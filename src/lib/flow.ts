/**
 * Where the motion field comes from: the block consensus, the dense optical
 * flow, and the rule that holds one to the other.
 *
 * A leaf module by design. nowcast.ts owns the observations, the warping and
 * the rendering; this owns the estimate, and the worker in motion.worker.ts
 * imports only this. Neither imports the other back, which is what keeps the
 * bundler from having to resolve a cycle it cannot.
 */

import { DH, DOWN, DW, SIGNAL_FLOOR, W } from "./grid";

/**
 * Where the motion came from, which is not a detail the interface can keep to
 * itself.
 *
 *   radar  the echo's own measured motion — the best answer there is
 *   model  the steering flow, when there was too little echo to match
 *   none   neither, so the future frames are the present held still
 *
 * The three are not interchangeable and the readout says which is in force.
 * A model flow is a real forecast and worth showing; presenting it as though
 * the radar had measured it would be the one dishonest thing this file could
 * do.
 */
export type MotionSource = "radar" | "model" | "none";


/* ── Motion ─────────────────────────────────────────────────── */


/**
 * Block side, in coarse pixels — so 8 × 8 covers 58 km of ground.
 *
 * Sixteen for a long time, which put a hundred and forty blocks over the
 * whole country at a hundred and sixteen kilometres each: bigger than most of
 * the storms they were supposed to be tracking, so a cell and the clear air
 * beside it were averaged into one vector and the field had no room to
 * deform. Halving it costs nothing — four times the blocks, each a quarter
 * the pixels, measured at 7 ms against the old 10 — and on a real front it
 * took the corroborating blocks from six to eighteen. A consensus with
 * eighteen blocks behind it is a different thing from one with six.
 */
const BLOCK = 8;
/** 20 × 28 blocks. Used by the consensus only — the flow itself is dense. */
const BLOCKS_X = Math.floor(DW / BLOCK);
const BLOCKS_Y = Math.floor(DH / BLOCK);

/** ±8 coarse pixels over the baseline ≈ 115 km/h, above anything Italian
 *  convection does and short of aliasing onto a neighbouring cell. */
const SEARCH = 8;

/* SIGNAL_FLOOR, declared above, is load-bearing here too. These tiles mark
   the whole radar domain as valid and fill the dry parts with zero, so "has
   data" is true almost everywhere while "has an echo" is true for a twentieth
   of it. A block matched across the dry majority scores identically at every
   offset, and the winner is then whichever the loop tried first — the corner
   of the search window. Those blocks once outvoted the real ones and dragged
   the whole forecast off in a fixed diagonal. */

/**
 * Echo pixels a block needs before its vector is believed.
 *
 * Six of a block's 64 cells. Twenty-four was too strict once the pooling
 * stopped destroying sparse echo: on a quiet day it disqualified every block
 * in the country, the motion field defaulted to zero, and the forecast became
 * the present held still — which looks exactly like a broken feature and is
 * impossible to tell apart from one.
 *
 * It was eight when a block held 256 cells. Six of 64 is a stricter fraction,
 * not a looser one, which is what a smaller block wants: fewer pixels to
 * average over means each one has to be worth more. Measured against four,
 * it gave up four blocks of fifty-five and two inliers of twenty — a fair
 * trade for a matcher that is harder to fool.
 */
const MIN_SIGNAL = 6;

/** Penalty per coarse pixel of displacement. Where the data cannot separate
 *  two offsets, prefer the smaller: motion has to be earned. */
const LAMBDA = 0.25;

/** How many of the best-evidenced blocks are tried as a consensus seed. */
const SEEDS = 4;

/** Half-width of the agreement window, in coarse pixels per minute, added to
 *  a term proportional to the speed. About 8 km/h: enough that blocks in the
 *  same airflow agree, tight enough that a stray one does not. */
const TOL_FLOOR = 0.15;

/**
 * Blocks that must agree before the flow is believed.
 *
 * Two is not enough. Measured back across two days of archive, a pair of
 * agreeing blocks out of six produced a consensus of 100 km/h towards the
 * south-west — the kind of direction that looks obviously wrong on the map,
 * and the reason the forecast was distrusted in the first place. Three
 * independent blocks pointing the same way is the smallest set where the
 * agreement is not plausibly coincidence. It costs the estimate on genuinely
 * marginal days, which is the right trade: no forecast is honest, and a
 * confident wrong one is not.
 */
const MIN_INLIERS = 3;

/**
 * Slowest flow still worth calling a forecast, in pixels per minute.
 *
 * About 2.7 km/h — under a kilometre and a half of travel in half an hour.
 * Precipitation does not hold that still: an echo that matches best against
 * itself, unmoved, over thirty minutes is ground clutter or anomalous
 * propagation, and both are stationary by nature. Warping by a flow that
 * rounds to zero would produce future frames identical to the present and
 * label them a forecast, which is the one failure a viewer cannot see. Below
 * this the estimate is reported as unavailable instead.
 */
const MIN_FLOW = 0.05;


/**
 * The flow, one vector per coarse pixel, row-major over DW × DH.
 *
 * Units are the thing to get right here, because nothing in the type system
 * guards them: **full-resolution pixels per minute**, not coarse pixels and
 * not pixels per baseline. The grid is coarse but the vectors are expressed in
 * the fine grid's pixels, because that is what `warp` steps in; the conversion
 * happens once, where the matcher's coarse offsets are turned into these.
 *
 * `v` is positive *southward*: image rows grow downward, and every consumer
 * treats it that way. A field built from a wind — where north is positive —
 * has to flip it, and motionFromSteering is the only place that does.
 */
export type Motion = {
  /** Eastward, full-resolution pixels per minute. */
  u: Float32Array;
  /** Southward, full-resolution pixels per minute. See the note above. */
  v: Float32Array;
  /** The fastest vector in the field, in pixels per minute. Measured once by
   *  sealMotion, because `warp` asks for it on every frame and it never
   *  changes for a given field. */
  maxSpeed: number;
};

/* An intensity trend used to live here — measured per pixel, saturated over
 * the horizon, and applied to the warped values. It was removed after being
 * verified: scored as CSI at 20 dBZ over three archived events and six lead
 * times, advection with it and without it agreed to within ±0.003, noise
 * around zero and negative as often as positive.
 *
 * It made cells visibly build and fade, which is the only thing it was
 * actually delivering, and it is not worth the machinery it took: a field to
 * carry, a clamp to bound it, a smoothing pass that leaked it sixteen
 * kilometres into dry air, and a guard in the warp to stop it inventing echo
 * there. Advection moves what was measured. That is the honest claim, and now
 * it is the only one the code makes.
 */

export type Coarse = { value: Uint8Array; mask: Uint8Array };

/** What downsample needs of a Field: its pixels, not its bounding box. Stated
 *  structurally so this module need not know what a Field is. */
export type CoarseSource = { value: Uint8Array; mask: Uint8Array };

/**
 * Reduces the grid eightfold by taking the strongest value in each cell, not
 * the average.
 *
 * Averaging is what you want to resize a picture and exactly what you must
 * not do to track one. Sixty-four pixels go into each coarse cell, and a
 * storm core surrounded by clear air averages down to nothing: measured on a
 * quiet afternoon, the mean preserved fifteen coarse pixels of echo where the
 * maximum preserved fifty-four. The features worth following are the cores,
 * so the pooling keeps them.
 */
export function downsample(field: CoarseSource): Coarse {
  const value = new Uint8Array(DW * DH);
  const mask = new Uint8Array(DW * DH);

  for (let y = 0; y < DH; y++) {
    for (let x = 0; x < DW; x++) {
      let peak = 0;
      let any = false;
      for (let dy = 0; dy < DOWN; dy++) {
        for (let dx = 0; dx < DOWN; dx++) {
          const i = (y * DOWN + dy) * W + x * DOWN + dx;
          if (!field.mask[i]) continue;
          any = true;
          if (field.value[i] > peak) peak = field.value[i];
        }
      }
      const j = y * DW + x;
      if (any) {
        value[j] = peak;
        mask[j] = 255;
      }
    }
  }

  return { value, mask };
}

/**
 * Seals a raw flow into a Motion, measuring the fastest vector in it once.
 *
 * `warp` needs that figure to know how far echo can be carried outside its
 * own box, and it used to recompute it on every call — which was invisible
 * at five hundred and sixty vectors and is not at thirty-five thousand:
 * measured, 0.53 ms against 0.008, and `fieldAt` warps twice for every
 * interpolated frame. The field does not change between frames, so the work
 * was pure waste. Computing it where the field is built costs nothing and
 * removes it from the hot path entirely.
 *
 * Compared on the square and rooted once at the end rather than through
 * Math.hypot per element: same answer, seven times faster, and this is the
 * one place the difference is worth the loss of clarity.
 */
/** A field that carries nothing anywhere: the honest answer when neither the
 *  echo nor a model could say how the air is moving. */
export function zeroMotion(): Motion {
  return sealMotion(new Float32Array(DW * DH), new Float32Array(DW * DH));
}

/**
 * Seals a raw flow into a Motion, measuring the fastest vector in it once.
 *
 * `warp` needs that figure to know how far echo can be carried outside its
 * own box, and it used to recompute it on every call — which was invisible at
 * five hundred and sixty vectors and is not at thirty-five thousand: measured,
 * 0.53 ms against 0.008, and an interpolated frame warps twice. The field does
 * not change between frames, so the work was pure waste.
 *
 * Compared on the square and rooted once at the end rather than through
 * Math.hypot per element: same answer, seven times faster, and this is the one
 * place the difference is worth the loss of clarity.
 */
export function sealMotion(u: Float32Array, v: Float32Array): Motion {
  let peak = 0;
  for (let i = 0; i < u.length; i++) {
    const s = u[i] * u[i] + v[i] * v[i];
    if (s > peak) peak = s;
  }
  return { u, v, maxSpeed: Math.sqrt(peak) };
}

/* ── Optical flow ───────────────────────────────────────────
 *
 * Block matching gave one vector per 58 km block — five hundred and sixty for
 * the whole country. That was never enough to deform anything: measured on a
 * real front, ninety-six per cent of the field ended up holding the single
 * consensus vector, and a constant field can only translate what it carries.
 * Widening the tolerance and shrinking the blocks both helped a little and
 * neither fixed the shape of the problem, which is that a block is the wrong
 * unit. A storm is not made of blocks.
 *
 * So the local field comes from pyramidal Lucas-Kanade instead: a vector per
 * coarse pixel, thirty-five thousand eight hundred and forty of them, sixty-four
 * times what the blocks gave. Pyramids because a half-hour of travel is about
 * eight coarse pixels and a 7 × 7 window cannot see that far in one step; four
 * levels bring it inside one pixel at the top and refine down.
 *
 * Verified against what actually happened — CSI at 20 dBZ, three archived
 * events, two lead times:
 *
 *   uniform consensus            0.4415
 *   block matching, as it was    0.4400
 *   dense flow, unregularised    0.4387
 *   dense flow, regularised      0.4539
 *
 * The middle row is the important one. Raw Lucas-Kanade is no better than what
 * it replaced: on the dry majority of the grid the structure tensor is
 * singular and it returns whatever diffused there from the coarser level.
 * What makes it win is being held to the consensus everywhere it has no echo
 * to speak from — the same discipline the blocks were already under. The gain
 * concentrates where it is worth most: about +1% at +15 minutes and +5% at
 * +30, which is the signature of a better field rather than a luckier one,
 * since advection error compounds with lead time.
 */

const FLOW_LEVELS = 4;
/** Half-width, so a 7 × 7 window. Nine was worth about +0.004 CSI and cost
 *  more than twice the time; five gave up half the gain. */
const FLOW_WINDOW = 3;
/** Gauss-Newton refinements per pyramid level. */
const FLOW_ITERS = 3;
/** Tikhonov term. The dry grid is flat, so the 2 × 2 system is singular over
 *  most of the country; this keeps it invertible instead of special-cased. */
const FLOW_REG = 1e-3;
/** Per-iteration step limit, in pixels of the level being solved. A cell
 *  edge can produce an enormous gradient ratio, and without a leash one
 *  iteration throws the vector off the grid and the rest never recover. */
const FLOW_MAX_STEP = 2;

/** One pyramid level: values as floats, because gradients and bilinear taps
 *  both want them, and its own dimensions, because every level differs. */
type Plane = { v: Float32Array; w: number; h: number };

/**
 * One pyramid level down: half the width and height, four pixels averaged
 * into one.
 *
 * Averaged rather than max-pooled, unlike `downsample`. The two want opposite
 * things: `downsample` is preserving storm cores for a matcher to track, this
 * is preparing an image for gradients, and a maximum filter produces plateaux
 * whose gradients are zero exactly where the structure is.
 *
 * Both dimensions are assumed even at every level, which holds for 160 × 224
 * over four levels (down to 20 × 28). A grid that broke that would truncate
 * silently, so it is a constraint on FLOW_LEVELS rather than a check.
 */
function halve(p: Plane): Plane {
  const w = p.w >> 1;
  const h = p.h >> 1;
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * p.w + 2 * x;
      v[y * w + x] = (p.v[i] + p.v[i + 1] + p.v[i + p.w] + p.v[i + p.w + 1]) / 4;
    }
  }
  return { v, w, h };
}

/** Averaged, not max-pooled. The pyramid is for gradients, and the coarse
 *  grid has already had its one max-pooling — see downsample. */
function bilinear(p: Plane, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(p.w - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(p.h - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const i = y0 * p.w + x0;
  return (
    p.v[i] * (1 - fx) * (1 - fy) +
    p.v[i + 1] * fx * (1 - fy) +
    p.v[i + p.w] * (1 - fx) * fy +
    p.v[i + p.w + 1] * fx * fy
  );
}

/**
 * Displacement from `a` to `b`, in coarse pixels over whatever interval
 * separates them. Coarse-to-fine, refining the estimate at each level.
 */
function opticalFlow(a: Coarse, b: Coarse): { u: Float32Array; v: Float32Array } {
  const pa: Plane[] = [{ v: Float32Array.from(a.value), w: DW, h: DH }];
  const pb: Plane[] = [{ v: Float32Array.from(b.value), w: DW, h: DH }];
  for (let l = 1; l < FLOW_LEVELS; l++) {
    pa.push(halve(pa[l - 1]));
    pb.push(halve(pb[l - 1]));
  }

  let u = new Float32Array(0);
  let v = new Float32Array(0);
  let pw = 0;
  let ph = 0;

  for (let l = FLOW_LEVELS - 1; l >= 0; l--) {
    const src = pa[l];
    const dst = pb[l];
    const w = src.w;
    const h = src.h;

    if (pw === 0) {
      u = new Float32Array(w * h);
      v = new Float32Array(w * h);
    } else {
      // Doubling the vectors with the resolution keeps them in level units.
      const nu = new Float32Array(w * h);
      const nv = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const sx = Math.min(pw - 1, x >> 1);
          const sy = Math.min(ph - 1, y >> 1);
          nu[y * w + x] = u[sy * pw + sx] * 2;
          nv[y * w + x] = v[sy * pw + sx] * 2;
        }
      }
      u = nu;
      v = nv;
    }
    pw = w;
    ph = h;

    const gx = new Float32Array(w * h);
    const gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        gx[i] = (dst.v[i + 1] - dst.v[i - 1]) / 2;
        gy[i] = (dst.v[i + w] - dst.v[i - w]) / 2;
      }
    }

    for (let it = 0; it < FLOW_ITERS; it++) {
      const nu = Float32Array.from(u);
      const nv = Float32Array.from(v);

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = y * w + x;
          let a11 = 0;
          let a12 = 0;
          let a22 = 0;
          let b1 = 0;
          let b2 = 0;

          for (let dy = -FLOW_WINDOW; dy <= FLOW_WINDOW; dy++) {
            const yy = y + dy;
            if (yy < 1 || yy >= h - 1) continue;
            for (let dx = -FLOW_WINDOW; dx <= FLOW_WINDOW; dx++) {
              const xx = x + dx;
              if (xx < 1 || xx >= w - 1) continue;
              const i = yy * w + xx;
              // `a` pulled back along the running estimate, against `b`.
              const it0 = bilinear(src, xx - u[c], yy - v[c]) - dst.v[i];
              a11 += gx[i] * gx[i];
              a12 += gx[i] * gy[i];
              a22 += gy[i] * gy[i];
              b1 += gx[i] * it0;
              b2 += gy[i] * it0;
            }
          }

          const det = (a11 + FLOW_REG) * (a22 + FLOW_REG) - a12 * a12;
          if (Math.abs(det) < 1e-6) continue;
          const du = ((a22 + FLOW_REG) * b1 - a12 * b2) / det;
          const dv = ((a11 + FLOW_REG) * b2 - a12 * b1) / det;
          if (!Number.isFinite(du) || !Number.isFinite(dv)) continue;

          nu[c] = u[c] + Math.max(-FLOW_MAX_STEP, Math.min(FLOW_MAX_STEP, du));
          nv[c] = v[c] + Math.max(-FLOW_MAX_STEP, Math.min(FLOW_MAX_STEP, dv));
        }
      }
      u = nu;
      v = nv;
    }

    /* Smoothed between levels, so what the next level up refines is a field
       rather than a scatter. */
    const su = Float32Array.from(u);
    const sv = Float32Array.from(v);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let A = 0;
        let B = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const i = (y + dy) * w + x + dx;
            A += u[i];
            B += v[i];
          }
        }
        su[y * w + x] = A / 9;
        sv[y * w + x] = B / 9;
      }
    }
    u = su;
    v = sv;
  }

  return { u, v };
}

/**
 * The one vector the best-evidenced blocks agree on, and whether enough of
 * them did.
 *
 * All that survives of the block matcher, and it earns its place: it is six
 * milliseconds, it is robust where a gradient method is not, and it is what
 * MIN_INLIERS guards. The optical flow supplies the local structure; this
 * supplies the thing that structure is measured against, and the thing the
 * interface asks about when it needs to know whether there is a forecast.
 */
function consensusFlow(
  a: Coarse,
  b: Coarse,
  minutes: number,
): { mu: number; mv: number; measured: boolean } {
  const found: { u: number; v: number; echo: number }[] = [];

  for (let by = 0; by < BLOCKS_Y; by++) {
    for (let bx = 0; bx < BLOCKS_X; bx++) {
      let echo = 0;
      for (let y = 0; y < BLOCK; y++) {
        const ny = by * BLOCK + y;
        if (ny >= DH) break;
        for (let x = 0; x < BLOCK; x++) {
          const nx = bx * BLOCK + x;
          if (nx >= DW) break;
          const ni = ny * DW + nx;
          if (b.mask[ni] && b.value[ni] >= SIGNAL_FLOOR) echo++;
        }
      }
      if (echo < MIN_SIGNAL) continue;

      const score = (dx: number, dy: number) => {
        let sad = 0;
        let n = 0;
        for (let y = 0; y < BLOCK; y++) {
          const ny = by * BLOCK + y;
          const py = ny - dy;
          if (ny >= DH || py < 0 || py >= DH) continue;
          for (let x = 0; x < BLOCK; x++) {
            const nx = bx * BLOCK + x;
            const px = nx - dx;
            if (nx >= DW || px < 0 || px >= DW) continue;
            const ni = ny * DW + nx;
            const pi = py * DW + px;
            if (!b.mask[ni] || !a.mask[pi]) continue;
            if (b.value[ni] < SIGNAL_FLOOR && a.value[pi] < SIGNAL_FLOOR) continue;
            sad += Math.abs(b.value[ni] - a.value[pi]);
            n++;
          }
        }
        if (n < MIN_SIGNAL) return Infinity;
        return sad / n + LAMBDA * Math.hypot(dx, dy);
      };

      let best = Infinity;
      let bdx = 0;
      let bdy = 0;
      let matched = false;

      for (let dy = -SEARCH; dy <= SEARCH; dy += 2) {
        for (let dx = -SEARCH; dx <= SEARCH; dx += 2) {
          const sc = score(dx, dy);
          if (sc < best) {
            best = sc;
            bdx = dx;
            bdy = dy;
            matched = true;
          }
        }
      }
      if (!matched) continue;

      found.push({ u: (bdx * DOWN) / minutes, v: (bdy * DOWN) / minutes, echo });
    }
  }

  let mu = 0;
  let mv = 0;
  let inliers = 0;
  let support = 0;

  for (const seed of [...found].sort((x, y) => y.echo - x.echo).slice(0, SEEDS)) {
    const tol = tolerance(seed.u, seed.v);
    let su = 0;
    let sv = 0;
    let weight = 0;
    let n = 0;
    for (const c of found) {
      if (Math.hypot(c.u - seed.u, c.v - seed.v) > tol) continue;
      su += c.u * c.echo;
      sv += c.v * c.echo;
      weight += c.echo;
      n++;
    }
    if (n > inliers || (n === inliers && weight > support)) {
      mu = su / weight;
      mv = sv / weight;
      inliers = n;
      support = weight;
    }
  }

  const measured = inliers >= MIN_INLIERS && Math.hypot(mu, mv) >= MIN_FLOW;
  return { mu, mv, measured };
}

/** Half-width of the agreement window, shared by the consensus and by the
 *  clamp that holds the dense field to it. */
function tolerance(du: number, dv: number): number {
  return 0.5 * Math.hypot(du, dv) + TOL_FLOOR;
}

/**
 * Displacement per minute in full-resolution pixels, one vector per coarse
 * pixel, plus where it came from.
 *
 * Exported because it is the half of the work that belongs on another thread:
 * the optical flow alone is 99 ms of the 120 this takes, and it needs nothing
 * but two coarse grids — seventy kilobytes, against the four and a half
 * megabytes the full-resolution fields would cost to hand over. So the
 * downsampling stays here, where it is nine milliseconds, and everything
 * after it can run in a worker. See `estimateOffThread`.
 */
export function estimateFromCoarse(
  a: Coarse,
  b: Coarse,
  minutes: number,
  reference: { u: Float32Array; v: Float32Array } | null,
): { motion: Motion; source: MotionSource } {
  const { mu, mv, measured } = consensusFlow(a, b, minutes);

  /* The field every pixel is judged against. When the echo corroborated a
     consensus of its own, that is one vector for the whole country; when it
     did not, the steering flow stands in. */
  let refU: Float32Array;
  let refV: Float32Array;
  let source: MotionSource;

  if (measured) {
    refU = new Float32Array(DW * DH).fill(mu);
    refV = new Float32Array(DW * DH).fill(mv);
    source = "radar";
  } else if (reference) {
    refU = reference.u;
    refV = reference.v;
    source = "model";
  } else {
    return { motion: zeroMotion(), source: "none" };
  }

  const flow = opticalFlow(a, b);
  const u = new Float32Array(DW * DH);
  const v = new Float32Array(DW * DH);

  for (let y = 0; y < DH; y++) {
    for (let x = 0; x < DW; x++) {
      const i = y * DW + x;
      const ru = refU[i];
      const rv = refV[i];

      /* Nothing to see here, so nothing to say. Clear air still has to move
         somewhere — a cell drifting into a wall of zero motion would pile up
         against it — but the vector it moves by is borrowed, not measured. */
      if (!b.mask[i] || b.value[i] < SIGNAL_FLOOR) {
        u[i] = ru;
        v[i] = rv;
        continue;
      }

      // Coarse pixels across the baseline, into full-resolution px/min.
      let fu = (flow.u[i] * DOWN) / minutes;
      let fv = (flow.v[i] * DOWN) / minutes;

      /* Clamped towards the reference rather than replaced by it: a vector
         pulled too far keeps the direction of its departure and loses only
         the excess. Unregularised this scored 0.4387 against the reference's
         own 0.4415 — the gradient method is confidently wrong wherever it has
         no texture, and holding it to the consensus is what turns it into an
         improvement rather than a wash. */
      const du = fu - ru;
      const dv = fv - rv;
      const drift = Math.hypot(du, dv);
      const tol = tolerance(ru, rv);
      if (drift > tol) {
        const trust = tol / drift;
        fu = ru + du * trust;
        fv = rv + dv * trust;
      }

      u[i] = fu;
      v[i] = fv;

    }
  }

  return { motion: smooth(u, v), source };
}

/** A 5×5 mean over the coarse grid. Wider than the 3×3 the block field used,
 *  because the cells are an eighth the size: it is the same distance on the
 *  ground, and it is what joins the measured interior to the borrowed
 *  surroundings without a seam where they meet. */
export function smooth(rawU: Float32Array, rawV: Float32Array): Motion {
  const u = new Float32Array(rawU.length);
  const v = new Float32Array(rawV.length);

  for (let y = 0; y < DH; y++) {
    for (let x = 0; x < DW; x++) {
      let su = 0;
      let sv = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= DH) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= DW) continue;
          const k = yy * DW + xx;
          su += rawU[k];
          sv += rawV[k];
          n++;
        }
      }
      const k = y * DW + x;
      u[k] = su / n;
      v[k] = sv / n;
    }
  }

  return sealMotion(u, v);
}
