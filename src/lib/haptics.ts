"use client";

/**
 * Vibration feedback over web-haptics, and the preference that mutes it.
 *
 * Shaped like sound.ts: module-scope state so the triggers stay plain calls,
 * one storage key, on by default. Both triggers gate on the preference here
 * rather than at the call sites.
 *
 * @see https://haptics.lochie.me
 */
import { useMemo } from "react";

import { useWebHaptics } from "web-haptics/react";

/** Storage key for the preference. */
export const HAPTICS_KEY = "haptics";

/* Module scope, not React state: the triggers are called from anywhere, and
   threading a preference through each of them would put it in the wrong
   place. */
let enabled = readHaptics();

/** The stored preference. Unset or unreadable means on: a device that can
 *  buzz generally should, and a static export reads this on the server, where
 *  storage throws. */
export function readHaptics(): boolean {
  try {
    return localStorage.getItem(HAPTICS_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Sets it for this session and, if storage allows, the next. */
export function setHaptics(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(HAPTICS_KEY, next ? "on" : "off");
  } catch {
    // Private mode with storage disabled — the choice just won't persist.
  }
}

/**
 * Whether a tap can ever happen on this device.
 *
 * Chrome permits navigator.vibrate only after the frame has been tapped, and
 * a click is not a tap. The method exists on desktop anyway, so web-haptics
 * reads the platform as supported and calls it once per detent — each one
 * blocked and logged. No touch points means no tap will ever come.
 *
 * Read lazily: the module is evaluated on the server.
 */
let touchable: boolean | null = null;

function canTap(): boolean {
  if (touchable === null) {
    touchable =
      typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  }
  return touchable;
}

/** Fires a trigger without letting a failure reach the caller: handlers ask
 *  for feedback before doing their work, so a throw here would take the
 *  action with it. */
function fire(run: () => unknown): void {
  if (!enabled || !canTap()) return;
  try {
    /* `trigger` returns a promise. A rejection would otherwise surface as an
       unhandled rejection from a control that worked perfectly. */
    void Promise.resolve(run()).catch(() => {});
  } catch {
    // No motor, no permission, or a platform that throws on the attempt.
  }
}

/**
 * The two feedbacks this app uses.
 *
 * Memoised: the object is a dependency of the handlers that fire it, and a
 * fresh identity every render rebuilds all of them.
 */
export function useHaptics() {
  const { trigger } = useWebHaptics();

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
