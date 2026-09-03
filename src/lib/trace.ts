"use client";

/**
 * A record of what the first few frames did, kept so a failure that only
 * happens on a cold start can be read after the fact.
 *
 * It exists because the interesting bug is unreachable from a desktop: the
 * paint path makes half a dozen decisions — is there a field, is the palette
 * built, does the layer exist, did the crop come back empty — and every one of
 * them fails the same way on screen, as a map with no weather on it. On a
 * phone there is no console to tell them apart.
 *
 * So the trace is written to storage as it happens, and the session that reads
 * it is not the session that wrote it: launch the app, watch it fail, then open
 * it again with `?debug=1` and read what the previous launch recorded.
 *
 * Bounded on both ends. Only the first frames are recorded — a scrub emits one
 * paint every few milliseconds and tracing those would cost more than it
 * explains — and the buffer is capped, so a session that somehow keeps writing
 * cannot fill the origin's storage quota.
 */

/** Where the trace lives between sessions. */
const KEY = "nembo:trace";

/** Lines kept. Sized for a cold start plus a spell of poking at the unit
 *  switcher afterwards, which is how the failure is currently reproduced. */
const MAX_LINES = 160;

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

  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Storage full or refused. The trace is a diagnostic; losing it is not an
    // error worth propagating into the render path it is watching.
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
