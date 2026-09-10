/**
 * Frame arithmetic: boxes, trajectories, warping, blending, painting.
 * No network, no cache, no DOM.
 *
 * Imports only grid.ts and flow.ts, both leaves. Required, not stylistic:
 * an import cycle involving a worker entry point hangs the Turbopack build
 * with no error output. See motion.worker.ts.
 *
 * renderField takes the palette as an argument because a worker is a separate
 * module instance — tiles.ts's table is empty there.
 */
import {
  DH,
  DOWN,
  DW,
  H,
  TILE,
  W,
  X0,
  Y0,
  latAt,
  lonAt,
} from "./grid";
import type { Motion } from "./flow";

/** Pixel bounds, inclusive, of the region worth touching. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * A composite, plus the box its echo lives in.
 *
 * Everything outside that box is either no-data or below the palette's first
 * stop, which the DPC ramp draws at zero alpha — so skipping it is invisible,
 * not an approximation. It is also what makes a full-resolution grid
 * tractable: the box is usually a few per cent of the field.
 */
export type Field = { value: Uint8Array; mask: Uint8Array; box: Box | null };

/**
 * The tightest rectangle containing every pixel worth drawing, or null when
 * there is none.
 *
 * This one scan is what makes a full-resolution grid affordable: every
 * operation downstream — warping, blending, painting, uploading — is confined
 * to the box, and on a typical day the box is a few per cent of the field.
 * It costs one pass over 2.29 M pixels per observation, which is paid once
 * and saves that much work many times over.
 *
 * `floor` is the caller's, not a shared constant, and must come from the
 * product's own palette: a byte spans each product's range, so one fixed
 * threshold means 4.9 dBZ on VMI and 16.5 mm on SRT1. Read as a constant it
 * cropped rain rate and accumulation to their heaviest cores and cut the rest
 * of the echo off at the rectangle's edge. See paintFloor in colormap.ts.
 */
export function signalBox(
  value: Uint8Array,
  mask: Uint8Array,
  floor: number,
): Box | null {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (!mask[i] || value[i] < floor) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Grows a box by `pad` on every side and clips it to the grid.
 *
 * Rounded outward — floor on the near edges, ceil on the far ones — so the
 * padding can only ever be generous. A box that is one pixel too small drops
 * echo silently; one pixel too large costs a row.
 */
export function clampBox(b: Box, pad: number): Box {
  return {
    x0: Math.max(0, Math.floor(b.x0 - pad)),
    y0: Math.max(0, Math.floor(b.y0 - pad)),
    x1: Math.min(W - 1, Math.ceil(b.x1 + pad)),
    y1: Math.min(H - 1, Math.ceil(b.y1 + pad)),
  };
}

/** The smallest box containing both, treating null as "nothing here". */
export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** The vector at a full-resolution pixel, interpolated across the coarse grid
 *  so it does not change in steps at a cell edge. */
export function motionAt(m: Motion, x: number, y: number): [number, number] {
  const cx = Math.min(DW - 1, Math.max(0, x / DOWN - 0.5));
  const cy = Math.min(DH - 1, Math.max(0, y / DOWN - 0.5));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(DW - 1, x0 + 1);
  const y1 = Math.min(DH - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;

  const at = (arr: Float32Array) =>
    arr[y0 * DW + x0] * (1 - fx) * (1 - fy) +
    arr[y0 * DW + x1] * fx * (1 - fy) +
    arr[y1 * DW + x0] * (1 - fx) * fy +
    arr[y1 * DW + x1] * fx * fy;

  return [at(m.u), at(m.v)];
}

/* ── Warping ────────────────────────────────────────────────── */

/** Full-resolution pixels per trajectory cell, and the grid that follows. */
const TRAJ = 32;
/** 40 × 56 trajectory cells. Coarser than the flow on purpose; see above. */
const TRAJ_X = Math.ceil(W / TRAJ);
const TRAJ_Y = Math.ceil(H / TRAJ);

/**
 * Where every trajectory cell came from, in full-resolution pixels.
 *
 * The trajectories are curved — integrated in five-minute steps so the flow
 * is sampled where the parcel actually is — but they are integrated on a grid
 * coarser than the flow itself, not once per pixel. Doing it per pixel was
 * the same arithmetic repeated two and a quarter million times, and measured
 * it turned a 63 ms frame into 234 ms at the far end of the horizon.
 *
 * The grid can be this coarse because the deformation lives in the *flow*,
 * not in the trajectory sampling. Measured across four resolutions from one
 * cell per coarse pixel down to one per 64, CSI moved between 0.4522 and
 * 0.4539 — noise — and the warp cost did not move at all, being dominated by
 * the per-pixel loop below rather than by the integration. So the dense field
 * costs nothing on the hot path: the extra vectors are spent where they
 * matter and interpolated where they do not.
 */
type Displacement = { dx: Float32Array; dy: Float32Array };

/**
 * Integrates every trajectory cell backwards through the flow and returns
 * where each one came from. See the note above `type Displacement` for why
 * the grid is coarser than the flow.
 */
function displacementFor(motion: Motion, minutes: number): Displacement {
  const dx = new Float32Array(TRAJ_X * TRAJ_Y);
  const dy = new Float32Array(TRAJ_X * TRAJ_Y);

  const steps = Math.max(1, Math.min(8, Math.round(Math.abs(minutes) / 5)));
  const dt = minutes / steps;

  for (let by = 0; by < TRAJ_Y; by++) {
    for (let bx = 0; bx < TRAJ_X; bx++) {
      const startX = (bx + 0.5) * TRAJ;
      const startY = (by + 0.5) * TRAJ;
      let px = startX;
      let py = startY;

      for (let s = 0; s < steps; s++) {
        const [u, v] = motionAt(motion, px, py);
        px -= u * dt;
        py -= v * dt;
      }

      const k = by * TRAJ_X + bx;
      dx[k] = px - startX;
      dy[k] = py - startY;
    }
  }

  return { dx, dy };
}

/** Bilinear across the trajectory grid, so nothing changes in steps at a seam. */
function displacementAt(
  d: Displacement,
  x: number,
  y: number,
): [number, number] {
  const bx = Math.min(TRAJ_X - 1, Math.max(0, x / TRAJ - 0.5));
  const by = Math.min(TRAJ_Y - 1, Math.max(0, y / TRAJ - 0.5));
  const x0 = Math.floor(bx);
  const y0 = Math.floor(by);
  const x1 = Math.min(TRAJ_X - 1, x0 + 1);
  const y1 = Math.min(TRAJ_Y - 1, y0 + 1);
  const fx = bx - x0;
  const fy = by - y0;

  const at = (arr: Float32Array) =>
    arr[y0 * TRAJ_X + x0] * (1 - fx) * (1 - fy) +
    arr[y0 * TRAJ_X + x1] * fx * (1 - fy) +
    arr[y1 * TRAJ_X + x0] * (1 - fx) * fy +
    arr[y1 * TRAJ_X + x1] * fx * fy;

  return [at(d.dx), at(d.dy)];
}

/**
 * Reused output buffers.
 *
 * An interpolated frame warps two observations and crossfades them, so the
 * naive version allocated six arrays of two and a quarter million bytes each
 * — fourteen megabytes handed to the collector for every frame of a scrub.
 * The pump renders one frame at a time and `renderField` reads a field to
 * completion before it awaits anything, so a fixed set of buffers is safe and
 * the garbage disappears.
 *
 * Only the mask is cleared between uses. Everything downstream gates on it,
 * so stale values under a zero mask are unreachable, and a single memset of
 * the mask is cheaper than clearing both.
 */
function scratch() {
  return { value: new Uint8Array(W * H), mask: new Uint8Array(W * H) };
}


/** Three, because the deepest case needs exactly that: two warps feeding one
 *  blend. A fourth would need `compose` to grow a case. */
export const SCRATCH = [scratch(), scratch(), scratch()] as const;

/**
 * Samples `field` as it would look `minutes` later — negative to look
 * backwards. Sampling runs backwards from each destination pixel, which is
 * what keeps the result free of the holes a forward scatter leaves behind.
 */
export function warp(
  field: Field,
  motion: Motion,
  minutes: number,
  into: { value: Uint8Array; mask: Uint8Array },
): Field {
  if (minutes === 0 || !field.box) return field;

  const { value, mask } = into;
  mask.fill(0);

  /* Echo can only land within its own box plus however far the fastest vector
     carries it, so everything outside that is guaranteed empty and is never
     visited. On a normal day this is a few per cent of the grid, which is
     what makes a full-resolution field affordable at all. */
  /* The furthest a parcel can be carried over the whole trajectory, plus a
     pixel of slack for the bilinear tap. */
  const reach = Math.abs(minutes) * motion.maxSpeed + 2;
  const box = clampBox(field.box, reach);

  /* Backward trajectories, integrated in steps rather than jumped in one.
   *
   * A single `x - u * minutes` takes the vector at the destination and
   * follows it in a straight line, which can only translate the pattern:
   * every pixel of a cell moves by the same amount, so the cell arrives
   * identical to itself. That is what makes a forecast look like a sticker
   * sliding across the map.
   *
   * Walking the trajectory in five-minute steps samples the field where the
   * parcel actually is at each moment. Where the flow speeds up, slows,
   * turns or converges, neighbouring pixels take different paths — so the
   * pattern stretches, rotates and squeezes on the way. That is not a
   * cosmetic difference: deformation by the wind is a real part of how
   * precipitation evolves, and it is the part advection can honestly claim.
   */
  const disp = displacementFor(motion, minutes);

  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const [ddx, ddy] = displacementAt(disp, x, y);
      const sx = x + ddx;
      const sy = y + ddy;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || x0 >= W - 1 || y0 < 0 || y0 >= H - 1) continue;

      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = y0 * W + x0;
      const i10 = i00 + 1;
      const i01 = i00 + W;
      const i11 = i01 + 1;

      const w00 = (1 - fx) * (1 - fy) * (field.mask[i00] ? 1 : 0);
      const w10 = fx * (1 - fy) * (field.mask[i10] ? 1 : 0);
      const w01 = (1 - fx) * fy * (field.mask[i01] ? 1 : 0);
      const w11 = fx * fy * (field.mask[i11] ? 1 : 0);
      const sum = w00 + w10 + w01 + w11;
      if (sum < 0.5) continue;

      const j = y * W + x;
      const carried =
        (field.value[i00] * w00 +
          field.value[i10] * w10 +
          field.value[i01] * w01 +
          field.value[i11] * w11) /
        sum;

      value[j] = carried < 0 ? 0 : carried > 255 ? 255 : Math.round(carried);
      mask[j] = 255;
    }
  }

  return { value, mask, box };
}

/** Crossfades two already-warped fields. Where only one has data it wins
 *  outright, so a cell entering the domain does not fade up out of nothing. */
export function blend(
  a: Field,
  b: Field,
  t: number,
  into: { value: Uint8Array; mask: Uint8Array },
): Field {
  const { value, mask } = into;
  mask.fill(0);
  const box = unionBox(a.box, b.box);
  if (!box) return { value, mask, box: null };

  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const i = y * W + x;
      const ma = a.mask[i] ? 1 - t : 0;
      const mb = b.mask[i] ? t : 0;
      const sum = ma + mb;
      if (sum <= 0) continue;
      value[i] = Math.round((a.value[i] * ma + b.value[i] * mb) / sum);
      mask[i] = 255;
    }
  }

  return { value, mask, box };
}

/** Corners for MapLibre's image source: TL, TR, BR, BL. */
export type Corners = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

/** A pixel edge on the working grid, as longitude / latitude. */
function edgeLon(px: number): number {
  return lonAt(X0 + px / TILE);
}

/** The same for a horizontal pixel edge; see edgeLon. */
function edgeLat(py: number): number {
  return latAt(Y0 + py / TILE);
}

/** A frame ready for the map: the cropped bitmap, and the quad it belongs in.
 *  The two travel together because the crop moves as the weather does — the
 *  image alone would be placed wrong on the very next frame. */
export type Painted = { image: ImageBitmap; coordinates: Corners };

/**
 * Paints a field through the palette currently in effect, cropped to the box
 * its echo occupies, and returns where that crop belongs on the map.
 *
 * Cropping is not an optimisation of the drawing — it is an optimisation of
 * the upload. A full-grid frame is 1280 × 1792 RGBA, nine megabytes pushed to
 * the GPU for every step of a scrub, most of it transparent. Sending only the
 * rectangle the weather is actually in cuts that to a fraction on any normal
 * day, and the image source is told exactly where to put it, so nothing moves
 * by a pixel.
 */
export async function renderField(
  field: Field,
  lut: Uint8Array,
): Promise<Painted | null> {
  const box = field.box;
  if (!box) return null;

  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  const img = new ImageData(w, h);
  const px = img.data;

  for (let y = box.y0; y <= box.y1; y++) {
    const src = y * W;
    const dst = (y - box.y0) * w - box.x0;
    for (let x = box.x0; x <= box.x1; x++) {
      const i = src + x;
      if (!field.mask[i]) continue;
      const o = (dst + x) * 4;
      const l = field.value[i] * 4;
      px[o] = lut[l];
      px[o + 1] = lut[l + 1];
      px[o + 2] = lut[l + 2];
      px[o + 3] = lut[l + 3];
    }
  }

  /* The crop's outer edges, not its pixel centres: an image source spans the
     quad it is given, so a half-pixel error here would shift the whole frame
     against the coastline. */
  const west = edgeLon(box.x0);
  const east = edgeLon(box.x1 + 1);
  const north = edgeLat(box.y0);
  const south = edgeLat(box.y1 + 1);

  return {
    image: await createImageBitmap(img),
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
  };
}

/* ── Composing an instant ───────────────────────────────────── */

/**
 * The field at one instant, from the observations bracketing it.
 *
 * Takes the observations rather than fetching them: selection and caching stay
 * on the main thread, so this runs unchanged in a worker.
 *
 * @param a      Observation at or before `time`.
 * @param b      Observation one step later, or null when `ahead`.
 * @param aTime  When `a` was measured.
 * @param step   Milliseconds between observations.
 * @param ahead  `time` is past the last observation; extrapolate from `a`.
 */
export function compose(
  a: Field | null,
  b: Field | null,
  aTime: number,
  step: number,
  motion: Motion,
  time: number,
  ahead: boolean,
): Field | null {
  // Past the last observation there is only one frame to work from.
  if (ahead) {
    if (!a) return null;
    return warp(a, motion, (time - aTime) / 60_000, SCRATCH[0]);
  }

  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;

  /* Both ends carried towards the instant, then crossfaded. Warping only one
     of them would make each observation arrive with a jolt as the source
     switched; warping both means the picture is always in motion and the
     observations are just the moments where it agrees with the radar. */
  const t = (time - aTime) / step;
  const forward = warp(a, motion, (t * step) / 60_000, SCRATCH[0]);
  const backward = warp(b, motion, -((1 - t) * step) / 60_000, SCRATCH[1]);
  return blend(forward, backward, t, SCRATCH[2]);
}
