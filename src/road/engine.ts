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
  /** Optional "pull off to read {label}" prompt, or null to clear it. */
  onPrompt: (label: string | null) => void;
}

const BASE_H = 240; // internal vertical resolution — fixes the pixel scale
const MAX_W = 760; // cap horizontal buffer size (perf on ultrawide)
const LEVELS = 5; // gray levels out of the dither
const CRUISE = 7200; // world units / second
const COAST = 0.34; // speed factor while a landmark is offered (time to decide)
const STOP_OFFSET = 9 * ROAD.SEG_LEN; // how far before the obelisk we halt
const PROMPT_LEAD = 48 * ROAD.SEG_LEN; // show the pull-off prompt this far out
const JUNCTION_MARGIN = 8; // segments of runway kept before the junction

export class RoadEngine {
  private display: HTMLCanvasElement;
  private dctx: CanvasRenderingContext2D;
  private low: HTMLCanvasElement;
  private lctx: CanvasRenderingContext2D;
  private lowW = 320;
  private lowH = BASE_H;

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
  private junctionPos = Infinity;
  private pulledOff = false; // already read this edge's landmark?
  private nearLandmark = false; // currently inside the pull-off window?
  private forkPending: ForkOption[] | null = null;

  constructor(display: HTMLCanvasElement, manifest: Manifest, cb: EngineCallbacks) {
    this.display = display;
    this.manifest = manifest;
    this.cb = cb;

    this.dctx = display.getContext("2d")!;
    this.dctx.imageSmoothingEnabled = false;

    this.low = document.createElement("canvas");
    this.low.width = this.lowW;
    this.low.height = this.lowH;
    this.lctx = this.low.getContext("2d", { willReadFrequently: true })!;

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

    // Size the low-res buffer to the viewport's aspect ratio. Vertical
    // resolution is fixed (so the pixel/dither scale looks the same on any
    // screen); width follows the aspect so the scene fills edge-to-edge with no
    // letterbox bars. Cap the width on ultrawide by trimming height to keep the
    // buffer aspect exactly equal to the display (no stretching).
    const aspect = cssW / Math.max(1, cssH);
    let h = BASE_H;
    let w = Math.round(h * aspect);
    if (w > MAX_W) {
      const k = MAX_W / w;
      w = MAX_W;
      h = Math.max(120, Math.round(h * k));
    }
    if (w < 1) w = 1;
    if (w !== this.lowW || h !== this.lowH) {
      this.lowW = w;
      this.lowH = h;
      this.low.width = w;
      this.low.height = h;
    }
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

  /** Opt in to reading the landmark ahead. Never happens automatically. */
  pullOff(): void {
    if (this.state !== "DRIVING" || !this.nearLandmark || this.forkPending) return;
    this.nearLandmark = false;
    this.cb.onPrompt(null);
    this.state = "FOCUS";
    this.cb.onState("FOCUS");
    this.audio.sting();
  }

  /** Dismiss the reading panel and rejoin the road toward the junction. */
  leaveReading(): void {
    if (this.state !== "READING") return;
    this.audio.setReading(false);
    this.cb.onReading(null);
    // Continue forward on the same edge — the junction still waits at its end.
    this.enterDriving();
  }

  /** Internal document link: travel to a specific connected node. */
  travelTo(nodeId: string): void {
    // Only honor links that correspond to a real outgoing road.
    const out = edgesFrom(this.manifest, this.destNodeId);
    const match = out.find((e) => e.to === nodeId);
    this.audio.setReading(false);
    this.cb.onReading(null);
    this.cb.onPrompt(null);
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
    this.junctionPos = (edge.segments.length - JUNCTION_MARGIN) * ROAD.SEG_LEN;
    this.focus = 0;
    this.pulledOff = false;
    this.nearLandmark = false;
    this.cb.onPrompt(null);
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

    if (this.state === "DRIVING") {
      if (!idlingAtFork) {
        this.position += this.speed * dt;

        // Offer (never force) the pull-off while inside the window before the
        // landmark. The driver opts in with pullOff(); otherwise they cruise by.
        const near =
          !this.pulledOff &&
          this.position >= this.stopPos - PROMPT_LEAD &&
          this.position < this.stopPos;
        if (near !== this.nearLandmark) {
          this.nearLandmark = near;
          this.cb.onPrompt(near ? nodeById(this.manifest, this.destNodeId).label : null);
        }

        // Reaching the end of the road is the junction: pick the next road.
        if (!this.forkPending && this.position >= this.junctionPos) {
          this.position = this.junctionPos;
          this.nearLandmark = false;
          this.cb.onPrompt(null);
          this.departFrom(this.destNodeId);
        }
      }
    } else if (this.state === "FOCUS") {
      // Eased approach to the framed stop point (guaranteed to converge), plus
      // the contrast-pull and a subtle camera push-in (drop the eye height).
      this.position += (this.stopPos - this.position) * Math.min(1, dt * 1.9);
      this.focus += (1 - this.focus) * Math.min(1, dt * 1.7);
      this.camHeight += (ROAD.CAMERA_HEIGHT * 0.82 - this.camHeight) * Math.min(1, dt * 1.7);

      const arrived = this.position >= this.stopPos - 4 && this.focus > 0.985;
      if (arrived) {
        this.position = this.stopPos;
        this.focus = 1;
        this.pulledOff = true; // don't re-offer this landmark after leaving
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

    // Target speed, decided AFTER the state logic so it can react to the
    // pull-off window: coast down near a landmark to give time to decide.
    let targetSpeed = CRUISE;
    if (this.state !== "DRIVING" || idlingAtFork) targetSpeed = 0;
    else if (this.nearLandmark) targetSpeed = CRUISE * COAST;
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * (this.state === "FOCUS" ? 2.2 : 3.2));
    if (this.speed < 1 && targetSpeed === 0) this.speed = 0;

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

    const lw = this.lowW;
    const lh = this.lowH;
    const { landmarkScreen } = renderRoad(ctx, this.edge, view, lw, lh);

    // Focus contrast-pull: fade the whole world toward mid-gray by compositing,
    // BEFORE the landmark is drawn so the landmark holds full contrast.
    if (this.focus > 0.001) {
      ctx.save();
      ctx.globalAlpha = this.focus * 0.9;
      ctx.fillStyle = "rgb(128,128,128)";
      ctx.fillRect(0, 0, lw, lh);
      ctx.restore();
    }

    // Landmark billboard on top, sharp.
    if (landmarkScreen) {
      const label = nodeById(this.manifest, this.edge.landmark.nodeId).label;
      renderLandmark(ctx, landmarkScreen, label, this.focus);
    }

    // Post: vignette + grain + Bayer dither on the low-res buffer.
    const img = ctx.getImageData(0, 0, lw, lh);
    ditherInPlace(img.data, lw, lh, LEVELS, this.manifest.seed & 1023, this.grainPhase);
    ctx.putImageData(img, 0, 0);

    // Upscale to fill the whole display — buffer aspect matches the viewport, so
    // no letterbox bars. Hard pixels (no smoothing).
    this.dctx.imageSmoothingEnabled = false;
    this.dctx.drawImage(this.low, 0, 0, this.display.width, this.display.height);
  }
}
