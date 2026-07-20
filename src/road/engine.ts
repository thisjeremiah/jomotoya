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
import { edgesFrom, nodeById, type Manifest } from "./manifest";
import { RoadAudio } from "./audio";

export type DriveState = "DRIVING" | "FOCUS" | "READING";

export interface EngineCallbacks {
  /** Reading panel should show (nodeId) or hide (null). */
  onReading: (nodeId: string | null) => void;
}

const BASE_H = 240; // internal vertical resolution — fixes the pixel scale
const MAX_W = 760; // cap horizontal buffer size (perf on ultrawide)
const LEVELS = 5; // gray levels out of the dither
const CRUISE = 7200; // world units / second
const COAST = 0.4; // speed factor while a landmark is in reach (time to click)
const STOP_OFFSET = 9 * ROAD.SEG_LEN; // how far before the obelisk we halt
const APPROACH_LEAD = 48 * ROAD.SEG_LEN; // landmark becomes clickable this far out
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
  private inApproach = false; // landmark within reach (clickable + coast)?
  private landmarkBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private visits = new Map<string, number>(); // per-node routing cursor

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

  // --- pointer interaction (the only control) ------------------------------

  /**
   * Is the pointer over the clickable landmark? (fx, fy) are fractions [0,1] of
   * the display. Used only to show a pointer cursor — a wordless invitation.
   */
  isOverLandmark(fx: number, fy: number): boolean {
    const b = this.landmarkBox;
    if (!b) return false;
    const x = fx * this.lowW;
    const y = fy * this.lowH;
    return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  }

  /** A click on the landmark is how you view it. Clicks elsewhere do nothing. */
  clickAt(fx: number, fy: number): void {
    if (this.state !== "DRIVING" || this.pulledOff) return;
    if (!this.isOverLandmark(fx, fy)) return;
    this.state = "FOCUS";
    this.audio.sting();
  }

  /** Dismiss the reading panel and rejoin the road toward the junction. */
  leaveReading(): void {
    if (this.state !== "READING") return;
    this.audio.setReading(false);
    this.cb.onReading(null);
    // Continue forward on the same edge — the junction still waits at its end.
    this.state = "DRIVING";
  }

  /** Internal document link: travel to a specific connected node. */
  travelTo(nodeId: string): void {
    const out = edgesFrom(this.manifest, this.destNodeId);
    const match = out.find((e) => e.to === nodeId);
    this.audio.setReading(false);
    this.cb.onReading(null);
    if (match) this.loadEdgeToward(match.from, match.to);
    else this.departFrom(this.destNodeId);
    this.state = "DRIVING";
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
    this.inApproach = false;
    this.landmarkBox = null;
  }

  /**
   * At a junction, just keep driving — no menu. Cycle through a node's outgoing
   * roads on repeat visits so the whole graph gets seen over a long drive,
   * preferring not to immediately double back where we came from.
   */
  private departFrom(nodeId: string): void {
    const out = edgesFrom(this.manifest, nodeId);
    if (out.length === 0) {
      const back = this.manifest.edges.find((e) => e.to === nodeId);
      if (back) this.loadEdgeToward(back.to, back.from);
      this.state = "DRIVING";
      return;
    }
    const n = this.visits.get(nodeId) ?? 0;
    this.visits.set(nodeId, n + 1);
    const pick = out[n % out.length];
    this.loadEdgeToward(pick.from, pick.to);
    this.state = "DRIVING";
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
    if (this.state === "DRIVING") {
      this.position += this.speed * dt;

      // The landmark ahead is within reach: clickable, and the car coasts so
      // it's an easy target. No prompt, no text — just the slowdown and the
      // pointer cursor invite the click.
      this.inApproach =
        !this.pulledOff &&
        this.position >= this.stopPos - APPROACH_LEAD &&
        this.position < this.stopPos + 6 * ROAD.SEG_LEN;

      // Reaching the end of the road is the junction: drive straight on.
      if (this.position >= this.junctionPos) {
        this.position = this.junctionPos;
        this.inApproach = false;
        this.landmarkBox = null;
        this.departFrom(this.destNodeId);
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
        this.inApproach = false;
        this.landmarkBox = null;
        this.state = "READING";
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

    // Target speed: coast while a landmark is in reach so it's easy to click.
    let targetSpeed = CRUISE;
    if (this.state !== "DRIVING") targetSpeed = 0;
    else if (this.inApproach) targetSpeed = CRUISE * COAST;
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * (this.state === "FOCUS" ? 2.2 : 3.2));
    if (this.speed < 1 && targetSpeed === 0) this.speed = 0;

    // Gentle sway for the "operated camera" feel.
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
      playerX: bank + swayX,
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

    // Landmark billboard on top, sharp — and record its clickable box while the
    // landmark is in reach (a generous hit area, easy for touch).
    if (landmarkScreen) {
      const label = nodeById(this.manifest, this.edge.landmark.nodeId).label;
      renderLandmark(ctx, landmarkScreen, label, this.focus);
      if (this.inApproach && landmarkScreen.w > 4) {
        const p = landmarkScreen;
        const wob = Math.max(1, p.w * 0.34);
        const hob = Math.max(2, p.w * 1.15);
        const halfW = Math.max(wob * 1.5, 10);
        const top = p.y - hob - wob * 0.6 - (p.w > 26 ? wob * 0.5 + 4 : 0) - 2;
        this.landmarkBox = { x0: p.x - halfW, y0: top, x1: p.x + halfW, y1: p.y + 3 };
      } else {
        this.landmarkBox = null;
      }
    } else {
      this.landmarkBox = null;
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
