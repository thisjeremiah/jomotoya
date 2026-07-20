// Layers 3 + 4 — procedural fill and the pseudo-3D scanline road renderer.
//
// Classic segment-based pseudo-3D (OutRun / Pole Position lineage): a list of
// road segments with per-segment curve and elevation, projected per scanline and
// painted back-to-front as trapezoids. No WebGL. The whole scene is drawn in
// grayscale so the dither pass downstream can treat R as luminance.

import { makeRng, hashString } from "./rng";
import type { RoadKind } from "./manifest";

const SEG_LEN = 200; // world units per segment
const RUMBLE_LEN = 3; // segments per rumble/stripe color band
const ROAD_WIDTH = 2000;
const CAMERA_HEIGHT = 1200;
const CAMERA_DEPTH = 0.84; // ~ 1/tan(fov/2), fov ~ 100deg
const DRAW_DISTANCE = 140; // segments rendered ahead
const LANE_OFFSET = 0.42; // fraction of half-road for a lane

// Grayscale tones (0..255). A cool filmic ramp, dark road under a paler sky.
const TONE = {
  skyTop: 150,
  skyHorizon: 96,
  ground1: 70,
  ground2: 58,
  road1: 40,
  road2: 46,
  rumbleLight: 150,
  rumbleDark: 30,
  lane: 130,
  fog: 96, // segments fade toward this with depth
};

export interface Segment {
  index: number;
  curve: number;
  worldY: number;
  color: 0 | 1; // alternating band
}

export interface Landmark {
  nodeId: string;
  segment: number; // segment index the billboard sits on
  side: -1 | 0 | 1; // left / center / right of road
}

export interface Edge {
  key: string;
  road: RoadKind;
  segments: Segment[];
  length: number; // world units
  landmark: Landmark; // destination landmark, placed before the end
}

/** Build one edge's geometry deterministically from seed + edge identity. */
export function buildEdge(seed: number, key: string, road: RoadKind, destNodeId: string): Edge {
  const rng = makeRng((seed ^ hashString(key)) >>> 0);
  const total = road === "highway" ? 300 : 240;
  const segments: Segment[] = new Array(total);

  // Piecewise curve + hill targets, linearly interpolated across each section
  // for C0-continuous (kink-free) geometry.
  let curCurve = 0;
  let curHill = 0;
  let i = 0;
  const curves = new Float32Array(total);
  const hills = new Float32Array(total);
  while (i < total) {
    const secLen = 24 + Math.floor(rng() * 46);
    const r = rng();
    let targetCurve = 0;
    if (r < 0.42) targetCurve = 0;
    else if (r < 0.72) targetCurve = rng() * 3 - 1.5;
    else targetCurve = (rng() < 0.5 ? -1 : 1) * (2.5 + rng() * 3);
    const targetHill = (rng() * 2 - 1) * 900;
    const end = Math.min(i + secLen, total);
    const span = end - i;
    for (let j = 0; i < end; i++, j++) {
      const t = span <= 1 ? 1 : j / (span - 1);
      curves[i] = curCurve + (targetCurve - curCurve) * t;
      hills[i] = curHill + (targetHill - curHill) * t;
    }
    curCurve = targetCurve;
    curHill = targetHill;
  }

  for (let s = 0; s < total; s++) {
    segments[s] = {
      index: s,
      curve: curves[s],
      worldY: hills[s],
      color: (Math.floor(s / RUMBLE_LEN) % 2) as 0 | 1,
    };
  }

  // Flatten and straighten the final stretch so arrivals read cleanly.
  const landmarkSeg = total - 45;
  for (let s = landmarkSeg - 20; s < total; s++) {
    if (s < 0) continue;
    segments[s].curve *= 0.15;
  }

  return {
    key,
    road,
    segments,
    length: total * SEG_LEN,
    landmark: {
      nodeId: destNodeId,
      segment: landmarkSeg,
      side: 0,
    },
  };
}

export function elevationAt(edge: Edge, worldZ: number): number {
  const seg = Math.floor(worldZ / SEG_LEN);
  const a = edge.segments[clampIndex(seg, edge.segments.length)];
  const b = edge.segments[clampIndex(seg + 1, edge.segments.length)];
  const t = (worldZ % SEG_LEN) / SEG_LEN;
  return a.worldY + (b.worldY - a.worldY) * t;
}

function clampIndex(i: number, len: number): number {
  if (i < 0) return 0;
  if (i >= len) return len - 1;
  return i;
}

export const ROAD = { SEG_LEN, ROAD_WIDTH, CAMERA_HEIGHT, CAMERA_DEPTH, LANE_OFFSET, TONE };

interface Projected {
  x: number;
  y: number;
  w: number;
  scale: number;
}

function project(
  worldX: number,
  worldY: number,
  worldZ: number,
  camX: number,
  camY: number,
  camZ: number,
  width: number,
  height: number,
): Projected {
  const dz = worldZ - camZ || 0.0001;
  const scale = CAMERA_DEPTH / dz;
  return {
    x: Math.round(width / 2 + (scale * (worldX - camX) * width) / 2),
    y: Math.round(height / 2 - (scale * (worldY - camY) * height) / 2),
    w: Math.round((scale * ROAD_WIDTH * width) / 2),
    scale,
  };
}

function lerpTone(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function gray(v: number): string {
  const c = Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${c},${c},${c})`;
}

export interface CameraView {
  /** position along the current edge, in world units */
  position: number;
  /** lane offset in [-1,1] * LANE_OFFSET, the driver's x on the road */
  playerX: number;
  /** extra camera pitch/height feel */
  camHeight: number;
}

/**
 * Draw the full grayscale scene for the current edge and camera into `ctx`
 * (the low-res offscreen buffer). Returns the on-screen projection of the
 * destination landmark, if visible — used for the focus push-in and billboard.
 */
export function renderRoad(
  ctx: CanvasRenderingContext2D,
  edge: Edge,
  view: CameraView,
  width: number,
  height: number,
): { landmarkScreen: Projected | null } {
  const segs = edge.segments;
  const baseSegment = Math.floor(view.position / SEG_LEN);
  const basePercent = (view.position % SEG_LEN) / SEG_LEN;
  const camZ = view.position;
  const camX = view.playerX * ROAD_WIDTH;
  const camY = elevationAt(edge, view.position) + view.camHeight;

  // Sky gradient.
  const sky = ctx.createLinearGradient(0, 0, 0, height * 0.62);
  sky.addColorStop(0, gray(TONE.skyTop));
  sky.addColorStop(1, gray(TONE.skyHorizon));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  // Ground base fill (covers any gaps below the nearest drawn band).
  ctx.fillStyle = gray(TONE.ground2);
  ctx.fillRect(0, height / 2, width, height / 2);

  // Curve is folded into the effective camera x: it accumulates as `x`, whose
  // per-segment delta is `dx` (which itself integrates each segment's curve).
  let x = 0;
  let dx = -(segs[clampIndex(baseSegment, segs.length)].curve * basePercent);
  let maxY = height; // hill occlusion: only draw bands whose top rises above this

  let landmarkScreen: Projected | null = null;

  for (let n = 0; n < DRAW_DISTANCE; n++) {
    const segIndex = baseSegment + n;
    if (segIndex + 1 >= segs.length) break;
    const seg = segs[segIndex];
    const next = segs[segIndex + 1];

    const z1 = segIndex * SEG_LEN;
    const z2 = (segIndex + 1) * SEG_LEN;

    const p1 = project(0, seg.worldY, z1, camX - x, camY, camZ, width, height);
    const p2 = project(0, next.worldY, z2, camX - x - dx, camY, camZ, width, height);

    x += dx;
    dx += seg.curve;

    // Clip: segment at/behind the camera, or fully hidden behind a nearer hill.
    if (z1 - camZ <= CAMERA_DEPTH * SEG_LEN) continue;
    if (p2.y >= maxY) continue;

    // Depth fog: fade tones toward the horizon tone with distance.
    const fog = Math.min(1, (n / DRAW_DISTANCE) ** 1.6);
    const light = seg.color === 0;
    const roadTone = lerpTone(light ? TONE.road1 : TONE.road2, TONE.fog, fog);
    const groundTone = lerpTone(light ? TONE.ground1 : TONE.ground2, TONE.fog, fog);
    const rumbleTone = lerpTone(light ? TONE.rumbleLight : TONE.rumbleDark, TONE.fog, fog);

    // Ground band for this slice.
    ctx.fillStyle = gray(groundTone);
    ctx.fillRect(0, p2.y, width, p1.y - p2.y + 1);

    // Road + rumble + lane marker.
    poly(ctx, p1.x - p1.w, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x - p2.w, p2.y, gray(roadTone));
    const r1 = p1.w * 0.16;
    const r2 = p2.w * 0.16;
    poly(ctx, p1.x - p1.w - r1, p1.y, p1.x - p1.w, p1.y, p2.x - p2.w, p2.y, p2.x - p2.w - r2, p2.y, gray(rumbleTone));
    poly(ctx, p1.x + p1.w, p1.y, p1.x + p1.w + r1, p1.y, p2.x + p2.w + r2, p2.y, p2.x + p2.w, p2.y, gray(rumbleTone));
    if (light) {
      const l1 = Math.max(0.5, p1.w * 0.03);
      const l2 = Math.max(0.5, p2.w * 0.03);
      poly(ctx, p1.x - l1, p1.y, p1.x + l1, p1.y, p2.x + l2, p2.y, p2.x - l2, p2.y, gray(lerpTone(TONE.lane, TONE.fog, fog)));
    }

    // Capture the landmark's projection when we reach its segment.
    if (segIndex === edge.landmark.segment) {
      landmarkScreen = { x: p1.x, y: p1.y, w: p1.w, scale: p1.scale };
    }

    maxY = p2.y;
  }

  return { landmarkScreen };
}

function poly(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  x4: number,
  y4: number,
  fill: string,
): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.lineTo(x4, y4);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw the landmark billboard: an iconic obelisk/gate that reads at low res and
 * high contrast. Drawn AFTER the world's focus fade so it stays sharp while the
 * surroundings desaturate toward mid-gray — the "arrival" beat.
 */
export function renderLandmark(
  ctx: CanvasRenderingContext2D,
  p: Projected,
  label: string,
  focus: number,
): void {
  if (p.scale <= 0) return;
  const h = Math.max(2, p.w * 1.15);
  const w = Math.max(1, p.w * 0.34);
  const cx = p.x;
  const baseY = p.y;
  const topY = baseY - h;

  // Contrast rises with focus so the landmark "sharpens" as you arrive.
  const dark = gray(24 - 24 * focus * 0.0 + 18); // ~ dark stone
  const bright = gray(190 + 50 * focus);

  // Obelisk body.
  ctx.fillStyle = dark;
  ctx.fillRect(cx - w / 2, topY, w, h);
  // Bright edge highlight.
  ctx.fillStyle = bright;
  ctx.fillRect(cx - w / 2, topY, Math.max(1, w * 0.16), h);
  // Cap.
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, topY);
  ctx.lineTo(cx, topY - w * 0.6);
  ctx.lineTo(cx + w / 2, topY);
  ctx.closePath();
  ctx.fill();

  // A faint plate for the label when close enough to read.
  if (p.w > 26) {
    ctx.fillStyle = gray(20);
    const pw = w * 2.2;
    const ph = Math.max(6, w * 0.5);
    ctx.fillRect(cx - pw / 2, topY - ph - 2, pw, ph);
    ctx.fillStyle = bright;
    ctx.font = `${Math.max(6, Math.floor(ph * 0.7))}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label.toUpperCase(), cx, topY - ph / 2 - 2);
  }
}
