// Layer 4 — post-processing. Ordered (Bayer) dithering, chosen over
// Floyd–Steinberg on purpose: error diffusion shimmers and crawls as the camera
// moves, ordered dithering stays rock-stable frame to frame.

// 4x4 Bayer matrix, values 0..15 normalized to thresholds in [0,1).
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const THRESHOLD: number[] = [];
for (let y = 0; y < 4; y++) {
  for (let x = 0; x < 4; x++) {
    THRESHOLD[y * 4 + x] = (BAYER_4[y][x] + 0.5) / 16;
  }
}

/**
 * In-place post-process of a grayscale RGBA buffer. Fog is baked into the scene
 * draw and the focus contrast-pull is done by compositing before this runs, so
 * this pass owns vignette + grain + the Bayer dither quantization — all cheap
 * passengers on the per-pixel loop we already have to run.
 *
 * @param grainPhase  animated per frame so the grain shimmers subtly.
 */
export function ditherInPlace(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  levels: number,
  grainSeed: number,
  grainPhase: number,
): void {
  const cx = width / 2;
  const cy = height / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  const step = levels - 1;

  // A cheap deterministic value-noise-ish grain from pixel index + phase.
  const grain = (i: number) => {
    const n = Math.sin((i * 12.9898 + grainSeed + grainPhase) * 43758.5453);
    return (n - Math.floor(n)) - 0.5; // -0.5..0.5
  };

  for (let y = 0; y < height; y++) {
    const ty = (y & 3) * 4;
    // vignette factor for this row precomputed partially
    const dyc = y - cy;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      // Scene is drawn in grayscale, so R carries luminance.
      let l = data[idx] / 255;

      // Vignette — soft darkening toward the frame edges.
      const dxc = x - cx;
      const dist = Math.sqrt(dxc * dxc + dyc * dyc) / maxDist;
      const vig = 1 - 0.55 * dist * dist;
      l *= vig;

      // Grain.
      l += grain(idx) * 0.05;

      if (l < 0) l = 0;
      else if (l > 1) l = 1;

      // Ordered-dither quantize to `levels` gray steps.
      const scaled = l * step;
      const low = Math.floor(scaled);
      const frac = scaled - low;
      const threshold = THRESHOLD[ty + (x & 3)];
      const q = (frac > threshold ? low + 1 : low) / step;
      const v = (q * 255) | 0;

      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      // alpha left as-is (255)
    }
  }
}
