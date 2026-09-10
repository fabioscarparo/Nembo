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

import {
  type Product,
  PRODUCTS,
  type ProductKey,
  echoFloorByte,
  hasTile,
} from "./dpc";
import { paintFloor } from "./colormap";
import { fetchTile } from "./tiles";
import { type Steering, steeringAt } from "./wind";
import {
  COLS,
  DH,
  DOWN,
  DW,
  H,
  ROWS,
  TILE,
  W,
  X0,
  Y0,
  Z,
  latAt,
  lonAt,
} from "./grid";
import {
  type Box,
  type Corners,
  type Field,
  type Painted,
  blend,
  compose,
  renderField,
  signalBox,
  warp,
} from "./field";
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
export type { Box, Corners, Field, Painted } from "./field";
export { renderField } from "./field";


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
  /* Pushed on arrival (~5 min), not per frame. Cloned rather than
     transferred: the motion estimate and the inline fallback still read it. */
  renderPost({
    k: "obs",
    key: cacheKey,
    value: field.value,
    mask: field.mask,
    box: field.box,
  });
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

  return any ? { value, mask, box: signalBox(value, mask, paintFloor(product)) } : null;
}

/** One observation, from cache or from the network, never twice at once. */
async function observation(
  product: Product,
  time: number,
): Promise<Field | null> {
  const cacheKey = `${product.key}:${time}`;

  const hit = observations.get(cacheKey);
  if (hit) return hit;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  /* Deliberately not given the caller's signal.
  
     This job is shared: the next caller to ask for the same instant is handed
     this very promise. A signal, though, belongs to one caller — so passing it
     in meant whoever asked first could cancel the fetch everybody after them
     was already waiting on, and they would read the aborted result as "no
     observation at this instant" and give up.

     That is not hypothetical. The sequence is rebuilt when the steering wind
     lands, a few hundred milliseconds after the first attempt starts; the
     rebuild aborted the first attempt and then inherited its cancelled
     promise, so `buildSequence` returned null, `setSequence(null)` changed
     nothing React could see, and the map stayed empty with every tile it
     needed already on its way.

     Letting the fetch finish costs a few small tiles that land in the cache
     the retry is about to read. Cancelling it cost the whole picture. */
  const job = stitch(product, time)
    .then((f) => {
      if (f) remember(cacheKey, f);
      return f;
    })
    /* `fetchTile` rethrows only for aborts, which can no longer originate
       here; everything else already returns null. Kept so a surprise from
       lower down resolves to "not available" rather than surfacing as an
       unhandled rejection. */
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
  floor: number,
): Promise<{ motion: Motion; source: MotionSource }> {
  const w = motionWorker();
  if (!w) return estimateFromCoarse(a, b, minutes, reference, floor);

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

    /* Copied, not transferred.
    
       Handing the four coarse grids over detaches them here, and the line
       below this promise reads them again: on a timeout or a worker error it
       falls back to `estimateFromCoarse(a, b, …)`, which would then run on
       zero-length arrays and produce a NaN flow — silently, in exactly the two
       cases the fallback exists to cover. The grids are 35 kB apiece, so the
       copy is not worth a broken fallback. */
    w.postMessage({
      id,
      minutes,
      aValue: a.value,
      aMask: a.mask,
      bValue: b.value,
      bMask: b.mask,
      refU: reference?.u ?? null,
      refV: reference?.v ?? null,
      floor,
    });
  });

  if (!reply) return estimateFromCoarse(a, b, minutes, reference, floor);
  return {
    motion: { u: reply.u, v: reply.v, maxSpeed: reply.maxSpeed },
    source: reply.source,
  };
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

/* ── Painting off the main thread ────────────────────────────
 *
 * Client for render.worker.ts. Optional on the same terms as the motion
 * worker: no Worker constructor, a throw, an error, a timeout — each falls
 * back to running the same code inline.
 */

type RenderReply = { id: number; image: ImageBitmap | null; coordinates?: Corners };

/**
 * `null` — the observations could not be assembled; retry.
 * `{ painted: null }` — they were, and hold nothing the palette would draw.
 *
 * Composing and painting used to be two calls, and the distinction fell out
 * of which one returned null. Behind one call it has to be explicit, or the
 * cold-start retry fires on clear sky.
 */
export type Frame = { painted: Painted | null } | null;

let renderHandle: Worker | null = null;
let renderUnavailable = false;
let nextRenderId = 1;
const renderPending = new Map<number, (r: RenderReply) => void>();

function renderWorker(): Worker | null {
  if (renderUnavailable) return null;
  if (renderHandle) return renderHandle;
  if (typeof Worker === "undefined") {
    renderUnavailable = true;
    return null;
  }
  try {
    const w = new Worker(new URL("./render.worker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e: MessageEvent<RenderReply>) => {
      renderPending.get(e.data.id)?.(e.data);
      renderPending.delete(e.data.id);
    };
    /* One error retires it: every later frame would otherwise pay
       RENDER_TIMEOUT before falling back. */
    w.onerror = () => {
      renderUnavailable = true;
      renderHandle = null;
      for (const settle of renderPending.values()) settle({ id: -1, image: null });
      renderPending.clear();
      w.terminate();
    };
    renderHandle = w;
    // Backfill: the worker may be built after observations have landed.
    for (const [key, field] of observations) {
      w.postMessage({ k: "obs", key, value: field.value, mask: field.mask, box: field.box });
    }
    return w;
  } catch {
    renderUnavailable = true;
    return null;
  }
}

/** Fire-and-forget state, dropped silently when there is no worker. */
function renderPost(msg: unknown) {
  renderWorker()?.postMessage(msg);
}

/** The worker's tiles.ts is a separate module instance; its table is empty. */
export function shareLut(lut: Uint8Array) {
  renderPost({ k: "lut", lut });
}

/** 160x224 floats, 286KB. Once per sequence, never per frame. */
export function shareMotion(motion: Motion) {
  renderPost({ k: "seq", motion });
}

/** Deliberately far above the ~47ms a frame takes: this catches a dead
 *  worker, not a busy one. */
const RENDER_TIMEOUT = 2000;

/**
 * A painted frame, off-thread when possible.
 *
 * Observation selection and fetching stay here, with the cache; the worker is
 * given the two keys. Falls back to inline when it is absent or does not
 * answer.
 */
export async function paintAt(
  seq: Sequence,
  time: number,
  lut: Uint8Array,
): Promise<Frame> {
  const need = bracket(seq, time);

  /* Awaited before posting: this guarantees `remember` has already pushed
     both observations to the worker. */
  const [a, b] = await Promise.all([
    observation(seq.product, need.aTime),
    need.ahead ? Promise.resolve(null) : observation(seq.product, need.bTime),
  ]);
  /* `null`, not an empty frame: the observations could not be assembled, and
     the caller's retry is for exactly this. An empty frame is a different
     answer and comes back as `{ painted: null }`. */
  if (!a && !b) return null;

  const w = renderWorker();
  if (w) {
    const id = nextRenderId++;
    const reply = await new Promise<RenderReply | null>((resolve) => {
      const timer = setTimeout(() => {
        renderPending.delete(id);
        resolve(null);
      }, RENDER_TIMEOUT);
      renderPending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      w.postMessage({
        k: "render",
        id,
        time,
        aKey: `${seq.product.key}:${need.aTime}`,
        bKey: `${seq.product.key}:${need.bTime}`,
        aTime: need.aTime,
        step: need.step,
        ahead: need.ahead,
      });
    });
    if (reply?.image && reply.coordinates) {
      return { painted: { image: reply.image, coordinates: reply.coordinates } };
    }
    /* Null reply: empty field, or the worker lacked an observation. Falling
       through recomputes inline and reaches the same answer either way. */
  }

  const field = compose(a, b, need.aTime, need.step, seq.motion, time, need.ahead);
  if (!field) return null;
  return { painted: await renderField(field, lut) };
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
): Promise<Sequence | null> {
  const product = PRODUCTS[key];
  const baseline = BASELINE_MIN * 60_000;

  const [past, now] = await Promise.all([
    observation(product, latest - baseline),
    observation(product, latest),
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
    echoFloorByte(product),
  );
  return { product, latest, motion, source };
}

/** Which two observations an instant sits between. Separate from fetching
 *  them because paintAt needs the same answer to build the worker message. */
export function bracket(seq: Sequence, time: number) {
  const step = seq.product.stepMinutes * 60_000;
  if (time >= seq.latest) {
    return { ahead: true, step, aTime: seq.latest, bTime: seq.latest };
  }
  const grid = Math.floor(time / step) * step;
  const aTime = Math.min(grid, seq.latest - step);
  return { ahead: false, step, aTime, bTime: aTime + step };
}

/* ── Rendering ──────────────────────────────────────────────── */


