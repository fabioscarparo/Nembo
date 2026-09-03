/**
 * Warps and paints a frame off the main thread.
 *
 * A frame costs ~47ms: two warps of the 1280x1792 grid plus a crossfade. On
 * the main thread that blocks the drag that requested it — the slider stops
 * tracking the finger. The cost is unchanged here; it just runs elsewhere.
 *
 * State is pushed, not requested: observations when stitched (~5 min),
 * motion per sequence, palette per rebuild. Per frame this receives two keys
 * and an instant.
 *
 * Imports only ./field, itself a leaf. An import cycle through a worker entry
 * point hangs the Turbopack build with no error output.
 */
import { type Field, compose, renderField } from "./field";
import type { Motion } from "./flow";

/** What the main thread sends. */
type Incoming =
  | { k: "lut"; lut: Uint8Array }
  | { k: "obs"; key: string; value: Uint8Array; mask: Uint8Array; box: Field["box"] }
  | { k: "seq"; motion: Motion }
  | {
      k: "render";
      id: number;
      time: number;
      aKey: string;
      bKey: string;
      aTime: number;
      step: number;
      ahead: boolean;
    };

/* Pushed state. Sending it per frame would cost 4.6MB an observation and
   286KB of motion, against a request rate of one every few milliseconds. */
const observations = new Map<string, Field>();
let motion: Motion | null = null;
let lut: Uint8Array | null = null;

/** Matches nowcast.ts's CACHE_LIMIT: an hour of timeline spans 13 observations
 *  at most, and a scrub touches two at a time. */
const CACHE_LIMIT = 8;

/* Queue of one. A drag emits requests faster than they can be served; a later
   one replaces the pending one rather than queueing behind it, so the frame
   that gets painted is the current position and not a backlog of stale ones. */
let wanted: Extract<Incoming, { k: "render" }> | null = null;
let working = false;

async function pump() {
  if (working) return;
  working = true;
  try {
    while (wanted) {
      const job = wanted;
      wanted = null;

      if (!motion || !lut) {
        self.postMessage({ id: job.id, image: null });
        continue;
      }

      const a = observations.get(job.aKey) ?? null;
      const b = job.ahead ? null : (observations.get(job.bKey) ?? null);
      const field = compose(a, b, job.aTime, job.step, motion, job.time, job.ahead);
      const painted = field ? await renderField(field, lut) : null;

      if (painted) {
        // Transferred, not structured-cloned: the bitmap is up to 9MB.
        self.postMessage(
          { id: job.id, image: painted.image, coordinates: painted.coordinates },
          [painted.image],
        );
      } else {
        self.postMessage({ id: job.id, image: null });
      }
    }
  } finally {
    working = false;
  }
}

self.onmessage = (e: MessageEvent<Incoming>) => {
  const msg = e.data;

  if (msg.k === "lut") {
    lut = msg.lut;
    return;
  }

  if (msg.k === "obs") {
    observations.set(msg.key, {
      value: msg.value,
      mask: msg.mask,
      box: msg.box,
    });
    while (observations.size > CACHE_LIMIT) {
      const oldest = observations.keys().next().value;
      if (oldest === undefined) break;
      observations.delete(oldest);
    }
    return;
  }

  if (msg.k === "seq") {
    motion = msg.motion;
    return;
  }

  wanted = msg;
  void pump();
};
