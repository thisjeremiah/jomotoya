// Layer 5 — camera & state machine, plus the frame loop that ties the content
// graph, procedural geometry, renderer, dither, and audio together.
//
// States: DRIVING -> FOCUS -> READING -> DRIVING.
// The cinematic budget goes to authored arrivals (plan §5, Option B): driving is
// connective tissue; the eased push-in and contrast-pull cut into each document
// is the star beat.

import { ditherInPlace } from "./bayer";
import {
  buildEdge,
  renderRoad,
  renderLandmark,
  ROAD,
  type Edge,
} from "./road";
import {
  edgesFrom,
  nodeById,
  type Manifest,
  type ManifestEdge,
} from "./manifest";
import { RoadAudio } from "./audio";

export type DriveState = "DRIVING" | "FOCUS" | "READING";

export interface ForkOption {
  edge: ManifestEdge;
  label: string;
}

export interface EngineCallbacks {
  /** Reading panel should show (nodeId) or hide (null). */
  onReading: (nodeId: string | null) => void;
  /** Fork choices to present, or null to clear. */
  onFork: (options: ForkOption[] | null) => void;
  /** High-level state, for HUD/hints. */
  onState: (state: DriveState) => void;
}

const LOW_W = 320;
const LOW_H = 240;
const LEVELS = 5; // gray levels out of the dither
const CRUISE = 7200; // world units / second
const STOP_OFFSET = 9 * ROAD.SEG_LEN; // how far before the obelisk we halt
const TRIGGER_SEGMENTS = 34; // begin the focus beat this many segments out

export class RoadEngine {
  private display: HTMLCanvasElement;
  private dctx: CanvasRenderingContext2D;
  private low: HTMLCanvasElement;
  private lctx: CanvasRenderingContext2D;
  private buffer: ImageData;

  private manifest: Manifest;
  private cb: EngineCallbacks;
  private audio = new RoadAudio();

  private edgeCache = new Map<string, Edge>();
  private edge!: Edge;
  private destNodeId!: string;

  private state: DriveState = "DRIVING";
  private position = 0;
  private speed = 0;
  private targetLane = 0;
  private lane = 0; // eased actual lane
  private focus = 0; // 0..1 arrival contrast-pull
  private camHeight = ROAD.CAMERA_HEIGHT;
  private sway = 0;
  private lastTime = 0;
  private grainPhase = 0;
  private raf = 0;
  private running = false;
  private stopPos = Infinity;
  private forkPending: ForkOption[] | null = null;

  constructor(display: HTMLCanvasElement, manifest: Manifest, cb: EngineCallbacks) {
    this.display = display;
    this.manifest = manifest;
    this.cb = cb;

    this.dctx = display.getContext("2d")!;
    this.dctx.imageSmoothingEnabled = false;

    this.low = document.createElement("canvas");
    this.low.width = LOW_W;
    this.low.height = LOW_H;
    this.lctx = this.low.getContext("2d", { willReadFrequently: true })!;
    this.buffer = this.lctx.createImageData(LOW_W, LOW_H);

    // Opening: drive in toward the start node — its arrival is the first beat.
    this.loadEdgeToward("__intro__", manifest.start);
  }

  // --- lifecycle -----------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.audio.dispose();
  }

  /** Called from a user gesture so audio may begin. */
  enableAudio(): void {
    this.audio.start();
  }

  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.display.width = Math.max(1, Math.floor(cssW * dpr));
    this.display.height = Math.max(1, Math.floor(cssH * dpr));
    this.dctx.imageSmoothingEnabled = false;
  }

  // --- public controls (wired to keyboard / buttons in React) --------------

  steer(dir: -1 | 0 | 1): void {
    if (this.state !== "DRIVING") return;
    this.targetLane = dir;
  }

  chooseFork(index: number): void {
    if (!this.forkPending) return;
    const opt = this.forkPending[index];
    if (!opt) return;
    this.forkPending = null;
    this.cb.onFork(null);
    this.loadEdgeToward(opt.edge.from, opt.edge.to);
    this.enterDriving();
  }

  /** Dismiss the reading panel and resume the journey. */
  leaveReading(): void {
    if (this.state !== "READING") return;
    this.audio.setReading(false);
    this.cb.onReading(null);
    this.departFrom(this.destNodeId);
  }

  /** Internal document link: travel to a specific connected node. */
  travelTo(nodeId: string): void {
    // Only honor links that correspond to a real outgoing road.
    const out = edgesFrom(this.manifest, this.destNodeId);
    const match = out.find((e) => e.to === nodeId);
    this.audio.setReading(false);
    this.cb.onReading(null);
    this.forkPending = null;
    this.cb.onFork(null);
    if (match) {
      this.loadEdgeToward(match.from, match.to);
    } else {
      // No direct road — fall back to the normal departure logic.
      this.departFrom(this.destNodeId);
      return;
    }
    this.enterDriving();
  }

  // --- edge / navigation ---------------------------------------------------

  private loadEdgeToward(fromId: string, toId: string): void {
    const key = `${fromId}->${toId}`;
    let edge = this.edgeCache.get(key);
    if (!edge) {
      const road = this.manifest.edges.find((e) => e.from === fromId && e.to === toId)?.road ?? "highway";
      edge = buildEdge(this.manifest.seed, key, road, toId);
      this.edgeCache.set(key, edge);
    }
    this.edge = edge;
    this.destNodeId = toId;
    this.position = 0;
    this.stopPos = edge.landmark.segment * ROAD.SEG_LEN - STOP_OFFSET;
    this.focus = 0;
  }

  private enterDriving(): void {
    this.state = "DRIVING";
    this.cb.onState("DRIVING");
  }

  /** Decide the next road after finishing a document. */
  private departFrom(nodeId: string): void {
    const out = edgesFrom(this.manifest, nodeId);
    if (out.length === 0) {
      // Dead end: turn around and head back the way we came, if possible.
      const back = this.manifest.edges.find((e) => e.to === nodeId);
      if (back) this.loadEdgeToward(back.to, back.from);
      this.enterDriving();
      return;
    }
    if (out.length === 1) {
      this.loadEdgeToward(out[0].from, out[0].to);
      this.enterDriving();
      return;
    }
    // Fork: present choices; the car idles until one is picked.
    this.forkPending = out.map((e) => ({
      edge: e,
      label: e.choice ?? nodeById(this.manifest, e.to).label,
    }));
    this.cb.onFork(this.forkPending);
    this.enterDriving();
  }

  // --- main loop -----------------------------------------------------------

  private tick = (t: number): void => {
    if (!this.running) return;
    if (!this.lastTime) this.lastTime = t;
    let dt = (t - this.lastTime) / 1000;
    this.lastTime = t;
    if (dt > 0.05) dt = 0.05; // clamp after tab-away
    this.grainPhase += dt * 37;

    this.update(dt);
    this.render();

    this.raf = requestAnimationFrame(this.tick);
  };

  private update(dt: number): void {
    const idlingAtFork = this.forkPending !== null && this.state === "DRIVING";

    // Target speed per state.
    let targetSpeed = CRUISE;
    if (this.state === "READING") targetSpeed = 0;
    else if (this.state === "FOCUS") targetSpeed = 0;
    else if (idlingAtFork) targetSpeed = 0; // wait for the driver to choose

    // Ease speed (spring-ish) toward the target.
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * (this.state === "FOCUS" ? 2.2 : 3.5));
    if (this.speed < 1 && targetSpeed === 0) this.speed = 0;

    if (this.state === "DRIVING") {
      this.position += this.speed * dt;

      // Approaching the landmark: begin the authored arrival.
      const trigger = this.stopPos - TRIGGER_SEGMENTS * ROAD.SEG_LEN;
      if (!idlingAtFork && this.position >= trigger) {
        this.state = "FOCUS";
        this.cb.onState("FOCUS");
        this.audio.sting();
      }
    } else if (this.state === "FOCUS") {
      // Eased approach to the framed stop point (guaranteed to converge), plus
      // the contrast-pull and a subtle camera push-in (drop the eye height).
      this.position += (this.stopPos - this.position) * Math.min(1, dt * 1.9);
      this.focus += (1 - this.focus) * Math.min(1, dt * 1.7);
      this.camHeight += (ROAD.CAMERA_HEIGHT * 0.82 - this.camHeight) * Math.min(1, dt * 1.7);

      const arrived = this.position >= this.stopPos - 4 && this.focus > 0.985;
      if (arrived) {
        this.focus = 1;
        this.state = "READING";
        this.cb.onState("READING");
        this.audio.setReading(true);
        this.cb.onReading(this.destNodeId);
      }
    } else if (this.state === "READING") {
      // Frozen; panel is live DOM. camHeight/focus held.
    }

    // Recover camera height + focus once we're driving again.
    if (this.state === "DRIVING") {
      this.focus += (0 - this.focus) * Math.min(1, dt * 3);
      this.camHeight += (ROAD.CAMERA_HEIGHT - this.camHeight) * Math.min(1, dt * 3);
    }

    // Lane easing (lagged follow) + sway + bank into the current curve.
    const laneTarget = this.targetLane * ROAD.LANE_OFFSET;
    this.lane += (laneTarget - this.lane) * Math.min(1, dt * 4);
    this.sway += dt;

    // Audio intensity tracks speed.
    this.audio.setSpeed(Math.min(1, this.speed / CRUISE));
  }

  private render(): void {
    const ctx = this.lctx;

    // Bank: lean the camera into the segment's curve, scaled by speed.
    const baseSeg = this.edge.segments[
      Math.min(this.edge.segments.length - 1, Math.floor(this.position / ROAD.SEG_LEN))
    ];
    const bank = (baseSeg?.curve ?? 0) * 0.02 * (this.speed / CRUISE);
    const swayX = Math.sin(this.sway * 0.7) * 0.012 * (this.speed / CRUISE);

    const view = {
      position: this.position,
      playerX: this.lane + bank + swayX,
      camHeight: this.camHeight + Math.sin(this.sway * 1.7) * 6 * (this.speed / CRUISE),
    };

    const { landmarkScreen } = renderRoad(ctx, this.edge, view, LOW_W, LOW_H);

    // Focus contrast-pull: fade the whole world toward mid-gray by compositing,
    // BEFORE the landmark is drawn so the landmark holds full contrast.
    if (this.focus > 0.001) {
      ctx.save();
      ctx.globalAlpha = this.focus * 0.9;
      ctx.fillStyle = "rgb(128,128,128)";
      ctx.fillRect(0, 0, LOW_W, LOW_H);
      ctx.restore();
    }

    // Landmark billboard on top, sharp.
    if (landmarkScreen) {
      const label = nodeById(this.manifest, this.edge.landmark.nodeId).label;
      renderLandmark(ctx, landmarkScreen, label, this.focus);
    }

    // Post: vignette + grain + Bayer dither on the low-res buffer.
    const img = ctx.getImageData(0, 0, LOW_W, LOW_H);
    ditherInPlace(img.data, LOW_W, LOW_H, LEVELS, this.manifest.seed & 1023, this.grainPhase);
    this.buffer = img;
    ctx.putImageData(img, 0, 0);

    // Upscale to the display, letterboxed, hard pixels.
    const dw = this.display.width;
    const dh = this.display.height;
    this.dctx.fillStyle = "#000";
    this.dctx.fillRect(0, 0, dw, dh);
    const scale = Math.min(dw / LOW_W, dh / LOW_H);
    const w = LOW_W * scale;
    const h = LOW_H * scale;
    this.dctx.imageSmoothingEnabled = false;
    this.dctx.drawImage(this.low, (dw - w) / 2, (dh - h) / 2, w, h);
  }
}
