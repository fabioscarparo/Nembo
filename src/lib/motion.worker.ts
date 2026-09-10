/// <reference lib="webworker" />

/**
 * The motion estimate, off the main thread.
 *
 * Deliberately thin: it owns no logic of its own, only the message plumbing.
 * The estimation lives in flow.ts and is called here exactly as the main
 * thread calls it when this worker is unavailable, so the two paths cannot
 * drift into computing different answers — which is the usual fate of a
 * worker that gets its own copy of the algorithm.
 *
 * It imports flow.ts and not nowcast.ts, and that is not a tidiness choice.
 * nowcast.ts is what constructs this worker, so importing it back made the
 * two modules a cycle — and Turbopack did not report that, it simply stopped:
 * the build hung with no output at all. flow.ts imports only grid.ts, which
 * imports nothing, so there is no cycle to resolve.
 */

import { estimateFromCoarse } from "./flow";

/**
 * What the main thread sends. The coarse grids are copied rather than
 * transferred: 35 kB apiece against the four and a half megabytes the
 * full-resolution fields would cost, and the sender still needs them for the
 * inline fallback it runs when this worker does not answer.
 */
type Request = {
  id: number;
  minutes: number;
  aValue: Uint8Array;
  aMask: Uint8Array;
  bValue: Uint8Array;
  bMask: Uint8Array;
  refU: Float32Array | null;
  refV: Float32Array | null;
  /* Per product — see echoFloorByte in dpc.ts. Sent rather than imported:
     dpc.ts is not a leaf, and this worker imports flow.ts alone for the
     cycle reason above. */
  floor: number;
};

self.onmessage = (e: MessageEvent<Request>) => {
  const d = e.data;

  const reference =
    d.refU && d.refV ? { u: d.refU, v: d.refV } : null;

  const { motion, source } = estimateFromCoarse(
    { value: d.aValue, mask: d.aMask },
    { value: d.bValue, mask: d.bMask },
    d.minutes,
    reference,
    d.floor,
  );

  /* The two vector fields are handed over rather than copied: they were
     built here and this worker has no further use for them. */
  (self as unknown as Worker).postMessage(
    {
      id: d.id,
      u: motion.u,
      v: motion.v,
      maxSpeed: motion.maxSpeed,
      source,
    },
    [motion.u.buffer, motion.v.buffer],
  );
};
