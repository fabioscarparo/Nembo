"use client";

/**
 * The tactile half of the same idea as sound.ts, and deliberately its mirror.
 *
 * A thin wrapper over web-haptics, kept parallel to the portfolio's so the two
 * projects speak one vocabulary, plus a preference with the same shape as the
 * mute flag: module state so the triggers stay plain calls, persisted under
 * its own key, defaulting to on because a device that can buzz generally
 * should. Everything no-ops where there is no motor.
 *
 * Both triggers are gated here rather than at the call sites. A caller asking
 * for feedback should not also have to ask whether feedback is wanted — that
 * is how one of them ends up forgetting.
 *
 * @see https://haptics.lochie.me
 */
import { useMemo } from "react";

import { useWebHaptics } from "web-haptics/react";

/**
 * Thin wrapper over web-haptics, kept deliberately parallel to the one in the
 * portfolio so the two projects speak the same tactile vocabulary. No-ops on
 * devices without a vibration motor.
 *
 * @see https://haptics.lochie.me
 */
export const HAPTICS_KEY = "haptics";

/**
 * Held at module scope for the same reason the mute flag is: the triggers
 * below are plain calls from anywhere, and threading a preference through
 * every one of them would put the state in the wrong place. Read once; on the
 * server the read throws and falls back to on, which is the right default —
 * a device that can buzz generally should.
 */
let enabled = readHaptics();

/** The stored preference, straight from storage. Separate from isHapticsOn()
 *  read after mount rather than during render, because a static export
 *  renders on the server where storage throws. The triggers below close over
 *  the module flag, so no accessor is needed. */
export function readHaptics(): boolean {
  try {
    return localStorage.getItem(HAPTICS_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Sets it for this session and, if it can, for the next one. */
export function setHaptics(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(HAPTICS_KEY, next ? "on" : "off");
  } catch {
    // Private mode with storage disabled — the choice just won't persist.
  }
}

/**
 * The two feedbacks this app uses, memoised.
 *
 * Memoised because the object lands in the dependency array of the handlers
 * that fire it: a fresh identity every render rebuilt every handler on every
 * keystroke of a drag, and with it the buttons holding them.
 */
/**
 * Fires a trigger without letting a failure escape.
 *
 * Handlers call for feedback before doing their work, so a throw here takes
 * the action with it. sound.ts has swallowed its own failures from the start.
 */
function fire(run: () => unknown): void {
  if (!enabled) return;
  try {
    /* `trigger` returns a promise. A rejection would otherwise surface as an
       unhandled rejection from a control that worked perfectly. */
    void Promise.resolve(run()).catch(() => {});
  } catch {
    // No motor, no permission, or a platform that throws on the attempt.
  }
}

export function useHaptics() {
  const { trigger } = useWebHaptics();

  /* Memoised for the same reason as useSound: this object is a dependency of
     the handlers that fire it, and a new identity every render churns them. */
  return useMemo(
    () => ({
      /** Crossing a detent — the timeline's ticks. The same feedback iOS
       *  uses for a picker, which is exactly what the slider is. */
      select: () => {
        fire(() => trigger("selection"));
      },
      /** Any plain button press. 10ms at `light`'s own intensity — the preset
       *  is 15, which sat too close to the timeline's continuous detents. */
      tap: () => {
        fire(() => trigger([{ duration: 10, intensity: 0.4 }]));
      },
    }),
    [trigger],
  );
}
