"use client";

/**
 * The interface's sounds, synthesised rather than downloaded.
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

import { defineSound, ensureReady } from "@web-kits/audio";

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

  /* The six below are the Minimal patch from the same library's registry,
     transcribed rather than installed. `npx @web-kits/audio add` writes all 26
     of the pack into the project; these are the six the interface actually
     fires, and they are plain data — the same `defineSound` calls as the two
     above, so nothing about how sound is built here changes.

     They share one shape: sine tones, no noise layer. That is the whole
     difference from the tick above, which is mostly filtered air. Discrete
     actions get a pitch; the tape's detents stay atonal, so a scrub does not
     turn into a melody.

     @see https://audio.raphaelsalaja.com/library/minimal */

  /** Rising fifth. Switching something on. */
  toggleOn: defineSound({
    layers: [
      {
        source: { type: "sine", frequency: 880 },
        envelope: { attack: 0, decay: 0.02, sustain: 0, release: 0.006 },
        gain: 0.08,
      },
      {
        source: { type: "sine", frequency: 1320 },
        envelope: { attack: 0, decay: 0.02, sustain: 0, release: 0.006 },
        delay: 0.03,
        gain: 0.07,
      },
    ],
  }),

  /** The same two tones the other way round. Switching something off. */
  toggleOff: defineSound({
    layers: [
      {
        source: { type: "sine", frequency: 1320 },
        envelope: { attack: 0, decay: 0.02, sustain: 0, release: 0.006 },
        gain: 0.08,
      },
      {
        source: { type: "sine", frequency: 880 },
        envelope: { attack: 0, decay: 0.02, sustain: 0, release: 0.006 },
        delay: 0.03,
        gain: 0.07,
      },
    ],
  }),

  /** A short upward sweep, for the pill travelling between tabs. */
  slide: defineSound({
    source: { type: "sine", frequency: { start: 800, end: 1100 } },
    envelope: { attack: 0.003, decay: 0.035, sustain: 0, release: 0.012 },
    gain: 0.05,
  }),

  /** Two rising tones. Something has started. */
  notification: defineSound({
    layers: [
      {
        source: { type: "sine", frequency: 660 },
        envelope: { attack: 0, decay: 0.05, sustain: 0, release: 0.02 },
        gain: 0.1,
      },
      {
        source: { type: "sine", frequency: 880 },
        envelope: { attack: 0, decay: 0.04, sustain: 0, release: 0.015 },
        delay: 0.08,
        gain: 0.08,
      },
    ],
  }),

  /** A downward blip. Something has stopped. */
  pop: defineSound({
    source: { type: "sine", frequency: { start: 400, end: 200 } },
    envelope: { attack: 0, decay: 0.04, sustain: 0, release: 0.012 },
    gain: 0.1,
  }),

  /** A major fifth, C to G. Something arrived. */
  success: defineSound({
    layers: [
      {
        source: { type: "sine", frequency: 523 },
        envelope: { attack: 0, decay: 0.05, sustain: 0, release: 0.015 },
        gain: 0.1,
      },
      {
        source: { type: "sine", frequency: 784 },
        envelope: { attack: 0, decay: 0.05, sustain: 0, release: 0.015 },
        delay: 0.06,
        gain: 0.08,
      },
    ],
  }),
} as const;

/**
 * Playback level for the patch sounds.
 *
 * They carry their own gains, tuned by the pack's author for exactly this kind
 * of interface, so this stays at 1 and lets those stand. The tick and release
 * above are damped hard instead: they fire on every detent of a drag, dozens a
 * second, and what is pleasant once is grating at that rate.
 */
const PATCH_VOLUME = 1;

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
       * Resumes the shared AudioContext from inside a user gesture.
       *
       * The first detent of a drag arrives after the gesture that would have
       * lifted the browser's suspension, hence pointer down. It has to be
       * resume(): playing into a suspended context is the call that gets
       * refused. Not awaited — a pointer handler must not block on audio.
       */
      prime: () => {
        if (muted) return;
        void ensureReady().catch(() => {});
      },

      /** The two switches in the settings panel. Direction carries the state:
       *  you can hear which way it went without looking at it. */
      toggleOn: () => playSound("toggleOn", PATCH_VOLUME),
      toggleOff: () => playSound("toggleOff", PATCH_VOLUME),
      /** Either row of tabs — the dock's quantity and the panel's theme. Both
       *  are the same control, so both make the same sound. */
      slide: () => playSound("slide", PATCH_VOLUME),
      /** Playback started. */
      notification: () => playSound("notification", PATCH_VOLUME),
      /** Playback stopped. */
      pop: () => playSound("pop", PATCH_VOLUME),
      /** The map has your position. */
      success: () => playSound("success", PATCH_VOLUME),
    }),
    [],
  );
}
