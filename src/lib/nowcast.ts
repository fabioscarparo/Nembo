/**
 * Motion-compensated frames: the radar between its own observations, and
 * thirty minutes past the last one.
 *
 * The Protezione Civile publishes every five minutes, and a five-minute step
 * is long enough that a storm visibly jumps. 3BMeteo — which takes the same
 * `protezione_civile` feed — serves frames every *sixty seconds*, thirty
 * minutes back and thirty minutes forward. That single number explains the
 * difference in feel: their extra frames are not extra data, they are the
 * same data warped along a measured motion field.
 *
 * So interpolation and extrapolation are one operation here, not two. Ask for
 * any instant and you get the nearest observations carried along the flow to
 * meet it:
 *
 *   between two observations → warp both towards the instant, blend
 *   after the last one       → warp the last one forward, alone
 *
 * The second case is the forecast. It is extrapolation, not meteorology:
 * cells are moved, never grown or dissipated. Honest to about half an hour,
 * which is why nothing here goes further — the same horizon 3BMeteo stops at.
 */

import { type Product, PRODUCTS, type ProductKey, hasTile } from "./dpc";
import { currentLut, fetchTile } from "./tiles";
import { type Steering, steeringAt } from "./wind";
import {
  COLS,
  DH,
  DOWN,
  DW,
  H,
  ROWS,
  SIGNAL_FLOOR,
  TILE,
  W,
  X0,
  Y0,
  Z,
  latAt,
  lonAt,
} from "./grid";
import {
  type Coarse,
  type Motion,
  type MotionSource,
  downsample,
  estimateFromCoarse,
  sealMotion,
  zeroMotion,
} from "./flow";

export { COMPOSITE_BOUNDS, DOMAIN } from "./grid";
export type { Motion, MotionSource } from "./flow";

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
 */
function signalBox(value: Uint8Array, mask: Uint8Array): Box | null {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      if (!mask[i] || value[i] < SIGNAL_FLOOR) continue;
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
function clampBox(b: Box, pad: number): Box {
  return {
    x0: Math.max(0, Math.floor(b.x0 - pad)),
    y0: Math.max(0, Math.floor(b.y0 - pad)),
    x1: Math.min(W - 1, Math.ceil(b.x1 + pad)),
    y1: Math.min(H - 1, Math.ceil(b.y1 + pad)),
  };
}

/** The smallest box containing both, treating null as "nothing here". */
function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/* ── Timeline shape ─────────────────────────────────────────
 * Thirty minutes either side of now, a frame a minute — the window 3BMeteo
 * shows, and about as far as advection stays defensible.
 */

export const STEP_MS = 60_000;
/** How far back the timeline reaches, and how far forward. Thirty either way
 *  is the window 3BMeteo shows from this same feed, and about as far as
 *  advection stays defensible — see the note on the forecast above. */
export const HISTORY_MIN = 30;
export const HORIZON_MIN = 30;

/** How far back the motion is measured. Long enough that a storm's travel
 *  clears the noise in the matcher: over five minutes it moves three pixels
 *  on this grid, over thirty it moves twenty. */
const BASELINE_MIN = 30;

/* ── Observations ───────────────────────────────────────────── */

/** Stitched composites, keyed by their instant. Fetched lazily: an opening
 *  view needs two, and scrubbing pulls in the rest as it reaches them.
 *
 *  The window shows thirty minutes of history at five-minute observations,
 *  so a full pass over the timeline touches seven of them plus the one the
 *  next publication brings. At six the cache was smaller than its own working
 *  set: scrubbing from one end to the other evicted the observation it was
 *  about to need again, and refetched it. Eight is the smallest size that
 *  cannot thrash, at about thirty-seven megabytes. */
const CACHE_LIMIT = 8;
/* Keyed by product as well as instant. It was keyed by instant alone for as
   long as only one product could be selected, which made it correct by
   accident: the moment a second became reachable, switching to it at the same
   minute would have handed back the first one's field — the right shape, the
   right timestamp, and the wrong quantity, which is the kind of wrong that
   does not look wrong. */
const observations = new Map<string, Field>();
const inFlight = new Map<string, Promise<Field | null>>();

/**
 * Files an observation in the cache, evicting the oldest once it is full.
 *
 * Eviction is by insertion order rather than by last use: a Map preserves it
 * for free, and the access pattern here is a sweep along a timeline rather
 * than the repeated random hits an LRU is for. See CACHE_LIMIT for why the
 * size is what it is.
 */
function remember(cacheKey: string, field: Field) {
  observations.set(cacheKey, field);
  while (observations.size > CACHE_LIMIT) {
    // Insertion order, so the oldest fetch is the first one out.
    const oldest = observations.keys().next().value;
    if (oldest === undefined) break;
    observations.delete(oldest);
  }
}

/**
 * Fetches every tile of one instant and assembles them into a single grid.
 *
 * Tiles are requested together rather than in sequence — the whole point of a
 * composite is that it is one moment, and thirty-five round trips end to end
 * would take longer than the interval between observations. Coordinates the
 * service does not publish are skipped before the request rather than after
 * the error; see the coverage table in dpc.ts.
 *
 * Returns null when not a single tile arrived, which the caller reads as "no
 * observation at this instant" — different from an observation that happens
 * to be empty, which is a legitimate picture of a dry country.
 */
async function stitch(
  product: Product,
  time: number,
  signal?: AbortSignal,
): Promise<Field | null> {
  const value = new Uint8Array(W * H);
  const mask = new Uint8Array(W * H);
  let any = false;

  const tiles = await Promise.all(
    Array.from({ length: COLS * ROWS }, (_, i) => {
      const x = X0 + (i % COLS);
      const y = Y0 + Math.floor(i / COLS);
      /* Two corners of this rectangle fall outside the radar's footprint and
         are not published. Asking for them anyway costs a round trip and a
         console error apiece, every observation. */
      if (!hasTile(product.key, Z, x, y)) {
        return Promise.resolve({ t: null, i });
      }
      return fetchTile(product, time, Z, x, y, signal).then((t) => ({ t, i }));
    }),
  );

  for (const { t, i } of tiles) {
    if (!t) continue;
    any = true;
    const ox = (i % COLS) * TILE;
    const oy = Math.floor(i / COLS) * TILE;
    for (let y = 0; y < TILE; y++) {
      const dst = (oy + y) * W + ox;
      const src = y * TILE;
      value.set(t.red.subarray(src, src + TILE), dst);
      mask.set(t.mask.subarray(src, src + TILE), dst);
    }
  }

  return any ? { value, mask, box: signalBox(value, mask) } : null;
}

/** One observation, from cache or from the network, never twice at once. */
async function observation(
  product: Product,
  time: number,
  signal?: AbortSignal,
): Promise<Field | null> {
  const cacheKey = `${product.key}:${time}`;

  const hit = observations.get(cacheKey);
  if (hit) return hit;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const job = stitch(product, time, signal)
    .then((f) => {
      if (f) remember(cacheKey, f);
      return f;
    })
    /* An abort is how this is meant to end when the caller moves on — a new
       frame scrubbed to, or the component unmounting — so it resolves to "not
       available" rather than rejecting. Left to reject it surfaced as an
       unhandled rejection on every cleanup, which is a real error report for
       something that is working as designed. `fetchTile` only ever rethrows
       for aborts; everything else already returns null. */
    .catch(() => null)
    .finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, job);
  return job;
}

/* ── Off the main thread ────────────────────────────────────
 *
 * The estimate is 120 ms and it lands on first load, while someone is looking
 * at the map. It runs once per observation rather than per frame, so it never
 * showed up in a scrub — but a fifth of a second of frozen page on arrival is
 * exactly the kind of cost that is easy to leave in because it is easy to miss.
 *
 * The worker is optional, and deliberately so. This project has already been
 * bitten once by a bundler renaming a worker chunk out from under the library
 * that asked for it — see scripts/copy-worker.mjs — and the failure mode there
 * was silence, not an error. So every path here falls back to running the same
 * function inline: a browser with no worker support, a construction that
 * throws, a worker that errors, and a worker that simply never answers all end
 * up with a slightly janky radar rather than no radar.
 */

type MotionReply = {
  id: number;
  u: Float32Array;
  v: Float32Array;
  maxSpeed: number;
  source: MotionSource;
};

let workerHandle: Worker | null = null;
let workerUnavailable = false;
let nextRequestId = 1;
const pending = new Map<number, (reply: MotionReply | null) => void>();

/** The worker, built on first use, or null once anything has gone wrong. */
function motionWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (workerHandle) return workerHandle;
  if (typeof Worker === "undefined") {
    workerUnavailable = true;
    return null;
  }

  try {
    const w = new Worker(new URL("./motion.worker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e: MessageEvent<MotionReply>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
    /* One failure retires it for the session. A worker that has errored once
       is not going to start working, and every subsequent estimate would pay
       the timeout below before falling back anyway. */
    w.onerror = () => {
      workerUnavailable = true;
      workerHandle = null;
      for (const settle of pending.values()) settle(null);
      pending.clear();
      w.terminate();
    };
    workerHandle = w;
    return w;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

/** Long enough for a slow phone to finish a 120 ms job, short enough that a
 *  worker which never answers costs one visibly late frame rather than a
 *  radar that never arrives. */
const WORKER_TIMEOUT = 4000;

/**
 * The estimate, in the worker when there is one and inline when there is not.
 *
 * The caller cannot tell which happened, and nothing downstream depends on
 * knowing: the two paths run the same function over the same inputs.
 */
async function estimateOffThread(
  a: Coarse,
  b: Coarse,
  minutes: number,
  reference: Motion | null,
): Promise<{ motion: Motion; source: MotionSource }> {
  const w = motionWorker();
  if (!w) return estimateFromCoarse(a, b, minutes, reference);

  const id = nextRequestId++;
  const reply = await new Promise<MotionReply | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, WORKER_TIMEOUT);

    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });

    /* The coarse grids are freshly built by `downsample` on every estimate and
       read by nobody else, so they are handed over rather than copied. The
       reference is not: it belongs to the steering field, which is held in
       React state and reused. */
    w.postMessage(
      {
        id,
        minutes,
        aValue: a.value,
        aMask: a.mask,
        bValue: b.value,
        bMask: b.mask,
        refU: reference?.u ?? null,
        refV: reference?.v ?? null,
      },
      [a.value.buffer, a.mask.buffer, b.value.buffer, b.mask.buffer],
    );
  });

  if (!reply) return estimateFromCoarse(a, b, minutes, reference);
  return {
    motion: { u: reply.u, v: reply.v, maxSpeed: reply.maxSpeed },
    source: reply.source,
  };
}

/** The vector at a full-resolution pixel, interpolated across the coarse grid
 *  so it does not change in steps at a cell edge. */
function motionAt(m: Motion, x: number, y: number): [number, number] {
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

/** Full-resolution pixels per trajectory cell, and the grid that follows. */
const TRAJ = 32;
/** 40 × 56 trajectory cells. Coarser than the flow on purpose; see above. */
const TRAJ_X = Math.ceil(W / TRAJ);
const TRAJ_Y = Math.ceil(H / TRAJ);

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
 *  blend. A fourth would only be reachable if `fieldAt` grew a case. */
const SCRATCH = [scratch(), scratch(), scratch()] as const;

/**
 * Samples `field` as it would look `minutes` later — negative to look
 * backwards. Sampling runs backwards from each destination pixel, which is
 * what keeps the result free of the holes a forward scatter leaves behind.
 */
function warp(
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
function blend(
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

/**
 * A motion field built from the steering flow instead of from the echo.
 *
 * The conversion is the only fiddly part. Open-Meteo answers in metres per
 * second over the ground; this grid is Web Mercator, whose scale runs with
 * the cosine of the latitude, so a wind of one speed covers more pixels over
 * the Alps than over Sicily. Each block is therefore converted at its own
 * latitude rather than at one figure for the country.
 *
 * The vertical sign flips: northward wind is positive, image rows grow
 * southward.
 *
 * A wind says where precipitation goes, and that is all this path claims. It
 * is the honest fallback, not a second opinion.
 */
function motionFromSteering(steering: Steering): Motion {
  const u = new Float32Array(DW * DH);
  const v = new Float32Array(DW * DH);

  for (let by = 0; by < DH; by++) {
    for (let bx = 0; bx < DW; bx++) {
      const px = (bx + 0.5) * DOWN;
      const py = (by + 0.5) * DOWN;
      const lon = lonAt(X0 + px / TILE);
      const lat = latAt(Y0 + py / TILE);

      const [east, north] = steeringAt(steering, lon, lat);

      // Mercator ground resolution at this latitude, metres per pixel.
      const mpp =
        (156_543.033_92 * Math.cos((lat * Math.PI) / 180)) / 2 ** Z;

      const k = by * DW + bx;
      u[k] = (east * 60) / mpp;
      v[k] = -(north * 60) / mpp;
    }
  }

  return sealMotion(u, v);
}

/* ── Sequence ───────────────────────────────────────────────── */


export type Sequence = {
  product: Product;
  /** The newest observation, and the origin of the timeline. */
  latest: number;
  motion: Motion;
  source: MotionSource;
};

/**
 * Prepares the motion field for an instant. Loads the two observations a
 * baseline apart and measures between them; everything else is warped from
 * observations pulled in on demand.
 */
export async function buildSequence(
  key: ProductKey,
  latest: number,
  steering?: Steering | null,
  signal?: AbortSignal,
): Promise<Sequence | null> {
  const product = PRODUCTS[key];
  const baseline = BASELINE_MIN * 60_000;

  const [past, now] = await Promise.all([
    observation(product, latest - baseline, signal),
    observation(product, latest, signal),
  ]);

  if (!now) return null;

  /* The steering flow, prepared up front. It is what the blocks are measured
     against when the echo cannot corroborate a consensus of its own, so it
     has to exist before the estimate rather than after it. */
  const reference = steering ? motionFromSteering(steering) : null;

  /* No baseline to match against — the first load after a gap, usually.
     Nothing can be measured from one frame, so the flow is the model's
     outright, or there is none. */
  if (!past) {
    if (reference) return { product, latest, motion: reference, source: "model" };
    return { product, latest, motion: zeroMotion(), source: "none" };
  }

  /* Otherwise the echo speaks first: it decides whether the reference is its
     own consensus or the model's wind, and either way the pixels that matched
     get to deviate from it locally. That local deviation is the whole of the
     deformation — a field with one vector in it can only translate what it
     carries. */
  const { motion, source } = await estimateOffThread(
    downsample(past),
    downsample(now),
    BASELINE_MIN,
    reference,
  );
  return { product, latest, motion, source };
}

/**
 * The field at any instant in the window, observed or not.
 *
 * Returns null while the observations it needs are still arriving, so a
 * caller can leave the previous frame on screen rather than blanking the map.
 */
export async function fieldAt(
  seq: Sequence,
  time: number,
  signal?: AbortSignal,
): Promise<Field | null> {
  const step = seq.product.stepMinutes * 60_000;
  const grid = Math.floor(time / step) * step;

  // Past the last observation there is only one frame to work from.
  if (time >= seq.latest) {
    const now = await observation(seq.product, seq.latest, signal);
    if (!now) return null;
    return warp(now, seq.motion, (time - seq.latest) / 60_000, SCRATCH[0]);
  }

  const older = Math.min(grid, seq.latest - step);
  const newer = older + step;
  const [a, b] = await Promise.all([
    observation(seq.product, older, signal),
    observation(seq.product, newer, signal),
  ]);

  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;

  /* Both ends carried towards the instant, then crossfaded. Warping only one
     of them would make each observation arrive with a jolt as the source
     switched; warping both means the picture is always in motion and the
     observations are just the moments where it agrees with the radar. */
  const t = (time - older) / step;
  const forward = warp(a, seq.motion, (t * step) / 60_000, SCRATCH[0]);
  const backward = warp(b, seq.motion, -((1 - t) * step) / 60_000, SCRATCH[1]);
  return blend(forward, backward, t, SCRATCH[2]);
}

/* ── Rendering ──────────────────────────────────────────────── */

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
export async function renderField(field: Field): Promise<Painted | null> {
  const box = field.box;
  if (!box) return null;

  const lut = currentLut();
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
