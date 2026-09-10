"use client";

/**
 * What the first frames did, kept so a cold-start failure can be read after
 * the fact.
 *
 * The paint path makes half a dozen decisions and every one fails the same way
 * on screen: a map with no weather on it. On a phone there is no console to
 * tell them apart.
 *
 * Written to storage as it happens and read by a later session: launch, watch
 * it fail, reopen with `?debug=1`.
 *
 * Bounded at both ends — MAX_PAINTS and MAX_LINES — so a scrub cannot fill the
 * origin's quota.
 */

/** Where the trace lives between sessions. */
const KEY = "nembo:trace";

/** Lines kept. Raised from 160: the scrub investigation needs several
 *  gestures, and each one sits behind the paint lines its own frames produce,
 *  which arrive dozens to a second. At 160 the gesture that failed had already
 *  been pushed past the cap by the ones that worked. */
const MAX_LINES = 400;

/** Paints recorded. Beyond a cold start and a few dozen deliberate
 *  interactions there is only scrubbing left, which teaches nothing. */
const MAX_PAINTS = 40;

/** This session's lines, in order. */
let lines: string[] = [];

/** What the launch before this one recorded, lifted out of storage before the
 *  first write of this session overwrites it. */
let previous: string[] = [];

/** Counts paints so the recorder can retire itself. See MAX_PAINTS. */
let paints = 0;

/* ── Persistence ────────────────────────────────────────────
 *
 * Recording is a push onto an array; persisting is a JSON.stringify of the
 * whole log and a synchronous localStorage write. Doing the second on every
 * call put both on the main thread inside a scrub, where trace() is called
 * dozens of times a second, for every visitor — the flag only ever gated the
 * panel, never the recorder, and it cannot gate the recorder without
 * destroying the point of the file: the failure is recorded before anyone
 * knows to ask for it.
 *
 * So the write is coalesced. A scrub's worth of lines costs one write, and a
 * tab that goes away takes the tail with it only if it does so within the
 * window below.
 */

/** How long a line may sit in memory before it reaches storage. */
const FLUSH_MS = 500;

let flushTimer: number | null = null;

function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Storage full or refused. The trace is a diagnostic; losing it is not an
    // error worth propagating into the render path it is watching.
  }
}

let started = false;

/** Milliseconds since the trace began, so the gaps between lines are visible —
 *  a step that waited four seconds for the network reads very differently from
 *  one that returned at once. */
const stamp = () => `${Math.round(performance.now())}ms`;

/**
 * Lifts the previous session's trace into memory and clears the slot for this
 * one.
 *
 * Called once, lazily, from the first `trace()` of the session rather than at
 * module scope: this module is imported by code that a static export evaluates
 * on the server, where storage throws.
 */
function begin(): void {
  if (started) return;
  started = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) previous = JSON.parse(raw) as string[];
  } catch {
    // Unparseable or unavailable. An empty history is the right fallback.
  }

  /* The tail is the part a diagnostic is read for, and a coalesced write can
     still be pending when the tab goes. `visibilitychange` as well as
     `pagehide` because a phone locking fires the first and not reliably the
     second, and that is the device this trace exists for. */
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
}

/**
 * Records one step.
 *
 * @param event  A short, stable name for the decision point.
 * @param detail Values that make the line worth reading — flattened into
 *               `key=value` pairs, because the reader is a phone screen.
 */
export function trace(event: string, detail?: Record<string, unknown>): void {
  begin();
  if (lines.length >= MAX_LINES) return;

  const rest = detail
    ? " " +
      Object.entries(detail)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    : "";
  lines.push(`${stamp()} ${event}${rest}`);

  if (flushTimer === null && typeof window !== "undefined") {
    flushTimer = window.setTimeout(flush, FLUSH_MS);
  }
}

/**
 * Whether the paint path should still be recording.
 *
 * Call once per paint. It counts as well as answers, so the caller does not
 * have to hold the counter.
 */
export function tracingPaint(): boolean {
  if (paints >= MAX_PAINTS) return false;
  paints += 1;
  return true;
}

/** This session's lines and the previous session's, for the overlay. */
export function readTrace(): { now: string[]; before: string[] } {
  begin();
  return { now: lines, before: previous };
}

/**
 * Whether to show the overlay.
 *
 * A query parameter rather than a stored flag, so it cannot be left on by
 * accident: the reader has to ask for it in the address bar, and the next
 * launch is clean.
 */
export function debugRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("debug");
  } catch {
    return false;
  }
}
