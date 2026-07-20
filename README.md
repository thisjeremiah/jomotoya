# The Road Site

A personal website where content has physical presence. You drive a monochrome,
cinematic road; documents are landmarks you pull off to read. Approaching one
desaturates the world while the landmark sharpens, then a real, crisp HTML page
fades in.

This is the MVP. All copy is placeholder — the point is the machinery.

## Run it

```bash
pnpm install
pnpm dev      # http://localhost:3000
pnpm build    # static export to ./out
```

Click **Start the drive** (needed as the gesture that enables audio), then:

- **← / →** — steer between lanes while driving, or pick a road at a fork
- **1 / 2 / 3** — pick a fork choice directly
- **Enter / Esc** — leave a landmark and get back on the road

## How it fits together

The architecture follows the project plan's layers:

| Layer | Where |
| --- | --- |
| 1 — Content graph (source of truth) | `src/content/site.tsx` — the manifest (nodes + edges) and the documents |
| 1 — Schema / validation | `src/road/manifest.ts` |
| 3 — Procedural fill (seed → geometry) | `src/road/rng.ts`, `buildEdge` in `src/road/road.ts` |
| 4 — Pseudo-3D scanline renderer | `renderRoad` / `renderLandmark` in `src/road/road.ts` |
| 4 — Bayer dither + fog + vignette + grain | `src/road/bayer.ts` |
| 5 — Camera rig + `DRIVING → FOCUS → READING` state machine | `src/road/engine.ts` |
| 6 — Documents (real HTML, not dithered) | `src/content/site.tsx`, `src/components/RoadSite.tsx` |
| Sound — procedural drone + focus sting | `src/road/audio.ts` |

### Editing the world

The manifest in `src/content/site.tsx` is the only thing you maintain by hand.
Add a node and an edge and a new landmark appears down a new road — nothing in
the renderer changes. The world is deterministic: the same `seed` + manifest
always generate the same curves, hills, and roadside detail (which is also what
would make future multiplayer sync tractable).

## Rendering notes

- Everything is drawn into a **320×240** offscreen canvas, reduced to grayscale,
  quantized with a **4×4 Bayer** ordered-dither matrix, then upscaled with
  `image-rendering: pixelated`. Ordered dithering (not Floyd–Steinberg) stays
  stable frame-to-frame instead of crawling under camera motion.
- The road is a classic **segment-based pseudo-3D projection** (OutRun lineage) —
  no WebGL.
- The **focus contrast-pull** ("arrival" beat) is done by compositing the world
  toward mid-gray, then drawing the landmark on top at full contrast — cheaper
  than optical blur and on-aesthetic.

## Out of MVP scope (see the plan)

Auto-layout / force-directed placement, multiplayer, true free-roam
intersections, and the ASCII-filter render mode are all deliberately deferred.
