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
import { WebHaptics } from "web-haptics";

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
  if (typeof window === "undefined") return true;
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
 * Single shared engine for the whole app.
 *
 * Calling `useWebHaptics()` from multiple components created separate
 * instances, each injecting its own hidden `<label><input switch>` into
 * `document.body` on iOS and isolating their `stopPattern()` queues.
 */
let engine: WebHaptics | null = null;

function getEngine(): WebHaptics | null {
  if (typeof window === "undefined") return null;
  engine ??= new WebHaptics();
  return engine;
}

/**
 * Whether the current interaction modality supports haptic feedback.
 *
 * `navigator.maxTouchPoints > 0` alone is true on touchscreen laptops even
 * when driven by a mouse or trackpad, causing Chrome to block and log every
 * `navigator.vibrate` call. Tracking the active pointer modality (falling back
 * to `(pointer: coarse)` before the first pointer event) keeps phones/tablets
 * live on first tap while staying silent under mouse input on hybrid devices.
 */
let pointerTracked = false;
let touchActive: boolean | null = null;

function trackPointer(): void {
  if (pointerTracked || typeof window === "undefined") return;
  pointerTracked = true;
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "touch") touchActive = true;
      else if (e.pointerType === "mouse") touchActive = false;
    },
    { capture: true, passive: true },
  );
}

function canTap(): boolean {
  if (typeof window === "undefined") return false;
  trackPointer();
  if (touchActive !== null) return touchActive;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/** Fires a trigger without letting a failure reach the caller: handlers ask
 *  for feedback before doing their work, so a throw here would take the
 *  action with it. */
function fire(run: (h: WebHaptics) => unknown): void {
  if (!enabled || !canTap()) return;
  const h = getEngine();
  if (!h) return;
  try {
    /* `trigger` returns a promise. A rejection would otherwise surface as an
       unhandled rejection from a control that worked perfectly. */
    void Promise.resolve(run(h)).catch(() => {});
  } catch {
    // No motor, no permission, or a platform that throws on the attempt.
  }
}

/** Stable singleton handle so every caller shares one identity and engine. */
const HAPTICS = {
  /** Crossing a detent — the timeline's ticks. The same feedback iOS
   *  uses for a picker, which is exactly what the slider is. */
  select: () => {
    fire((h) => h.trigger("selection"));
  },
  /** Any plain button press. 10ms at `light`'s own intensity — the preset
   *  is 15, which sat too close to the timeline's continuous detents. */
  tap: () => {
    fire((h) => h.trigger([{ duration: 10, intensity: 0.4 }]));
  },
};

/**
 * The two feedbacks this app uses.
 */
export function useHaptics() {
  return HAPTICS;
}
