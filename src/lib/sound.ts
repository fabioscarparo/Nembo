"use client";

/**
 * The interface's two sounds, synthesised rather than downloaded.
 *
 * Nothing here is an asset: both are recipes that the Web Audio API renders on
 * the fly, so the app ships no audio files and the tick costs a few hundred
 * bytes of description instead of a request.
 *
 * The detent is modelled on the axis dials in ui.camera, which synthesise
 * theirs too — so what is reproduced is the recipe, not a sample. The split
 * between the two layers is the whole character: the click lives in the
 * band-passed noise, and the sine underneath is what stops it reading as a
 * rustle. Tone alone would be a beep.
 *
 * The mute flag is module state rather than React state, because `playSound`
 * has to stay a plain call from anywhere. Components read it once after mount
 * — see readMuted — because a static export renders them where storage throws.
 *
 * @see https://audio.raphaelsalaja.com
 */
import { useMemo } from "react";

import { defineSound } from "@web-kits/audio";

/**
 * The timeline's two sounds, built with the same @web-kits/audio synthesis the
 * portfolio uses. Nothing is downloaded: these are recipes, and the Web Audio
 * API renders each one on the fly.
 *
 * The detent is modelled on the axis dials in ui.camera. They ship no audio
 * files either — their tick is synthesised too — so what is reproduced here is
 * the recipe, not an asset: a band-passed noise burst with a quiet sine under
 * it. That split is the whole character. The click lives in the noise; the
 * tone alone would read as a beep, and noise alone as a rustle.
 *
 * @see https://audio.raphaelsalaja.com
 */
const sounds = {
  /** Crossing one tick of the tape. Eighteen milliseconds, and mostly air. */
  tick: defineSound({
    layers: [
      {
        source: { type: "noise", color: "white" },
        filter: { type: "bandpass", frequency: 5400, resonance: 1.8 },
        envelope: { attack: 0.001, decay: 0.018 },
        gain: 0.14,
      },
      {
        source: { type: "sine", frequency: 2600 },
        envelope: { attack: 0.001, decay: 0.012 },
        gain: 0.018,
      },
    ],
  }),

  /** Letting go. Lower and softer than a tick, so the end of a drag reads as
   *  a settle rather than as one more detent. */
  release: defineSound({
    layers: [
      {
        source: { type: "noise", color: "white" },
        filter: { type: "bandpass", frequency: 1700, resonance: 1.4 },
        envelope: { attack: 0.001, decay: 0.022 },
        gain: 0.11,
      },
    ],
  }),
} as const;

/** Names of the recipes above, so `playSound` cannot be asked for one that
 *  does not exist. */
type SoundName = keyof typeof sounds;

/** Shared with the portfolio, so a visitor who silenced one finds the other
 *  silent too if the two ever sit on one domain. */
export const SOUND_KEY = "sound";

/**
 * Held at module scope rather than in React state so `playSound` stays a plain
 * call from anywhere. Read once; on the server the read throws and falls back
 * to unmuted, which is the right starting point anyway.
 */
let muted = readMuted();

/**
 * The stored preference, read straight from storage rather than from the
 * module's copy.
 *
 * Read after mounting rather than during render: a static export renders
 * components once on the server, where storage throws and every read has to
 * answer "unmuted". Nothing else needs an accessor — `playSound` closes over
 * the module flag directly.
 */
export function readMuted(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "off";
  } catch {
    return false;
  }
}

/** Sets the preference for this session and, if it can, for the next one. */
export function setMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(SOUND_KEY, next ? "off" : "on");
  } catch {
    // The choice just won't survive the session.
  }
}

/**
 * Renders one of the recipes, unless the visitor has asked for silence.
 *
 * Every failure is swallowed: there may be no AudioContext, the page may not
 * have had the user gesture that unlocks one yet, or the tab may be muted at
 * the OS level. None of those are worth an exception — a radar that throws
 * because it could not click is worse than a silent one.
 */
function playSound(name: SoundName, volume: number): void {
  if (muted) return;
  try {
    sounds[name]({ volume });
  } catch {
    // No AudioContext, no gesture yet, or the tab is muted. Never fatal.
  }
}

/**
 * Mirrors useHaptics(), so a call site can fire both in one line.
 *
 * Memoised because the object ends up in the dependency array of the
 * callbacks that use it: returning a fresh one each render rebuilt every
 * handler on every keystroke of a drag, and with it the buttons holding them.
 */
export function useSound() {
  return useMemo(
    () => ({
      tick: () => playSound("tick", 0.12),
      release: () => playSound("release", 0.13),
      /**
       * A tick at inaudible volume, fired on pointer down.
       *
       * Browsers will only start an AudioContext inside a user gesture, and
       * the first detent of a drag arrives after the gesture that could have
       * unlocked it. Spending that gesture on a silent note means the first
       * real tick is heard rather than swallowed.
       */
      prime: () => playSound("tick", 0.0001),
    }),
    [],
  );
}
