"use client";

/**
 * The hour: half of it measured, half of it forecast, and the present between.
 *
 * A real `<input type="range">` with a decorative ruler laid over it. That
 * choice is load-bearing: keyboard, pointer capture, touch and assistive
 * technology all come for free and correct, and every bit of the appearance
 * is still CSS. An earlier version moved a tape under a fixed mark and
 * hand-rolled the dragging, and got all four of those wrong.
 *
 * Three things here answer to measurement rather than to taste. The tick
 * count is derived from the track's width so the marks keep a readable pitch
 * instead of collapsing into a hatch on a phone; the wake behind the thumb is
 * driven by a per-tick counter that rides in the element key, because
 * restarting a running CSS animation is otherwise surprisingly awkward; and
 * the readout's box is sized to the widest state it can hold, because a box
 * that resizes as you scrub past the present makes the whole dock twitch.
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Clock, Play, Stop } from "reicon-react";
import { TextMorph } from "torph/react";

import type { MotionSource } from "@/lib/nowcast";
import { useHaptics } from "@/lib/haptics";
import { useSound } from "@/lib/sound";

type Props = {
  /** Every instant on the axis, oldest first, one a minute. Absolute times
   *  rather than offsets: a new observation arriving mid-scrub shifts the
   *  window without moving what you are looking at. */
  frames: number[];
  /** How many of `frames` are measurements; the rest are extrapolated. */
  observedCount: number;
  /** The instant on screen. Must be one of `frames`, or the thumb falls back
   *  to the first tick. */
  value: number;
  onChange: (time: number) => void;
  /** Snaps the thumb back to the present. Handed in rather than derived here
   *  because "the present" is the caller's `latest`, and the timeline only
   *  knows which of its own frames that is. */
  onNow: () => void;
  /** Whether the loop is running. Owned by the caller so that scrubbing by
   *  hand can stop it, which is a decision about the map, not the slider. */
  playing: boolean;
  onTogglePlay: () => void;
  /** Where the motion came from. "radar" is measured from the echo, "model"
   *  from the steering flow when there was too little echo to match, and
   *  "none" means the future frames are the present held still. */
  forecastSource: MotionSource;
  /** Rendered after the slider, in the same row. A slot rather than a prop
   *  for the button itself: what belongs beside the timeline is a layout
   *  decision, and the timeline has no business knowing about geolocation. */
  trailing?: ReactNode;
};

/** Every fifth mark is taller, so the eye lands on regular intervals. */
const MAJOR = 5;

/**
 * How far apart the marks want to be, in pixels.
 *
 * A fixed thirty-one was the wrong unit. What reads as a ruler rather than as
 * a hatch is the *spacing*, and the track is not a fixed width: on a phone it
 * comes out at ninety pixels once the padding, the gap and the readout have
 * taken their share, which put thirty-one marks under three pixels apart —
 * a grey smear. The same thirty-one then left a desktop track half empty.
 *
 * So the count is derived from the width instead, and this is the number that
 * actually carries the intent.
 */
const TICK_PITCH = 12;

/** The fewest marks that still read as a scale rather than as a few notches. */
const MIN_TICKS = 11;

/**
 * Marks for a track this wide.
 *
 * Snapped so `count - 1` divides by MAJOR: the tall marks then come out
 * evenly and the last one is tall, which is what makes the ruler look
 * finished at its right edge rather than cut off.
 *
 * Capped at one mark per frame — past that the ruler would advertise a
 * resolution the timeline does not have.
 */
function tickCountFor(width: number, frames: number): number {
  const ideal = Math.round(width / TICK_PITCH);
  const snapped = Math.round((ideal - 1) / MAJOR) * MAJOR + 1;
  return Math.max(MIN_TICKS, Math.min(frames, snapped));
}

/**
 * A fixed ruler with a moving thumb, built on a real `<input type="range">`
 * with the ticks laid over it as decoration.
 *
 * The previous version moved a tape under a fixed mark and hand-rolled the
 * dragging. That was the wrong instinct: a native range gets keyboard,
 * pointer capture, touch and assistive technology for free and correctly,
 * and the whole appearance is still CSS. Modelled on the perspective control
 * in ui.camera, which does exactly this.
 *
 * A fixed ruler also suits a bounded range better than a tape does. The whole
 * hour is visible at once — half an hour of measurement, half an hour of
 * forecast, and the present marked between them — instead of being something
 * you have to scroll to find.
 */
export default function Timeline({
  frames,
  observedCount,
  value,
  onChange,
  playing,
  onTogglePlay,
  onNow,
  forecastSource,
  trailing,
}: Props) {
  const haptics = useHaptics();
  const sound = useSound();

  /* Gated on marks crossed, not frames changed: 61 frames over ~40 marks
     never lined up. The throttle is now a floor on detent rate, not a
     stand-in for tick pitch — at 58ms a flick across 40 marks yielded 5
     clicks. */
  const lastDetent = useRef(0);

  const detent = useCallback(() => {
    const now = performance.now();
    if (now - lastDetent.current < 24) return;
    lastDetent.current = now;
    haptics.select();
    sound.tick();
  }, [haptics, sound]);

  const index = Math.max(0, frames.indexOf(value));
  const nowIndex = observedCount - 1;

  /* One counter per tick. The thumb does not light ticks it is near — it
     leaves a wake: every mark it crosses jumps to full height and falls back
     over a third of a second, so a drag ripples along the ruler behind you.
     Lifted from ui.camera's own control, which is where the effect is from.

     The counter is what replays the animation. It rides in the element key,
     so React remounts that span and the CSS animation starts again from the
     top — restarting a running animation is otherwise surprisingly awkward. */
  /* Drives the row's collapse below `sm`. See `.t-strip` in globals.css. */
  const [scrubbing, setScrubbing] = useState(false);

  const [pulses, setPulses] = useState<number[]>(() =>
    Array(MIN_TICKS).fill(0),
  );

  /* Measured rather than guessed from a breakpoint: the track's width is what
     the buttons, the padding and the readout happen to leave, which no media
     query knows.
  
     Before paint, not after. A ResizeObserver does fire on observe, but its
     callback lands after the browser has already painted the mount — which
     showed the fallback eleven marks on a track four hundred pixels wide for
     a frame, and then snapped to forty-one. Measuring in a layout effect and
     letting React re-render synchronously means the first thing drawn is
     already at the right density; the observer then only has to catch
     genuine resizes. */
  const track = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);

  /* Held while the row animates. The ResizeObserver fires every frame of it;
     refitting on each one re-densified the ruler mid-travel. The count is set
     once, for the final width. */
  const locked = useRef(false);

  /* The resting width is whatever the buttons leave over, so unlike the
     expanded one it cannot be derived. Remembered at press instead. */
  const restingTrack = useRef(0);

  const fitTicks = useCallback(
    (width: number) => {
      if (locked.current || width <= 0) return;
      const next = tickCountFor(width, frames.length);
      setPulses((prev) => (prev.length === next ? prev : Array(next).fill(0)));
    },
    [frames.length],
  );

  /** The track's width once the row has finished opening. Read off the DOM —
   *  padding, gap and readout — rather than duplicating the stylesheet. */
  const expandedTrack = useCallback(() => {
    const row = strip.current;
    const pill = ruler.current;
    if (!row || !pill) return 0;
    const cs = getComputedStyle(pill);
    const readout = pill.lastElementChild?.getBoundingClientRect().width ?? 0;
    return (
      row.clientWidth -
      parseFloat(cs.paddingLeft) -
      parseFloat(cs.paddingRight) -
      parseFloat(cs.columnGap || "0") -
      readout
    );
  }, []);

  /* Final density set before the row moves. Below `sm` only — nothing
     collapses above it. */
  const beginScrub = useCallback(() => {
    setScrubbing(true);
    if (!window.matchMedia("(max-width: 639px)").matches) return;
    const target = expandedTrack();
    if (target <= 0) return;
    restingTrack.current = track.current?.getBoundingClientRect().width ?? 0;
    setPulses((prev) => {
      const next = tickCountFor(target, frames.length);
      return prev.length === next ? prev : Array(next).fill(0);
    });
    locked.current = true;
  }, [expandedTrack, frames.length]);

  /* Density restored immediately, not on transitionend: deferring it made the
     marks thin in one step after everything else had stopped, which is where a
     change reads loudest. The lock still runs to transitionend so the observer
     does not refit against widths the row is only passing through. */
  const endScrub = useCallback(() => {
    setScrubbing(false);
    const pill = ruler.current;
    if (!pill || !locked.current) return;

    if (restingTrack.current > 0) {
      setPulses((prev) => {
        const next = tickCountFor(restingTrack.current, frames.length);
        return prev.length === next ? prev : Array(next).fill(0);
      });
    }

    let settled = false;
    const done = () => {
      /* Both paths below can fire — a transition that runs and a timeout that
         was already scheduled — and the second must not undo the refit the
         first did. */
      if (settled) return;
      settled = true;
      pill.removeEventListener("transitionend", done);
      window.clearTimeout(timer);
      locked.current = false;
      /* One last fit against the real width, in case the viewport changed
         while the row was open and the remembered figure is stale. Normally
         it agrees with what was just set and changes nothing. */
      const el = track.current;
      if (el) fitTicks(el.getBoundingClientRect().width);
    };
    pill.addEventListener("transitionend", done, { once: true });
    /* A transition that never runs — reduced motion, or a release in the same
       frame as the press — would otherwise leave the lock on for good. When
       it is the timeout that wins, `done` takes the listener off itself:
       `once` only removes a listener that has fired, and one per gesture
       accumulates on the same element. */
    const timer = window.setTimeout(done, 500);
  }, [fitTicks, frames.length]);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;

    fitTicks(el.getBoundingClientRect().width);

    const observer = new ResizeObserver(([entry]) =>
      fitTicks(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitTicks]);

  const ticks = pulses.length;

  const tickOf = useCallback(
    (i: number) =>
      Math.round((ticks - 1) * (frames.length > 1 ? i / (frames.length - 1) : 1)),
    [frames.length, ticks],
  );

  const rippleTo = useCallback(
    (nextIndex: number) => {
      const from = tickOf(index);
      const to = tickOf(nextIndex);
      if (from === to) return;
      setPulses((prev) => {
        const next = [...prev];
        const step = to > from ? 1 : -1;
        // The mark being left, not the one being landed on: it lights as the
        // thumb departs, which is what makes the wake trail rather than lead.
        /* Bounded: a resize can land between the index this was computed
           from and the array it writes into, and a stray index would make a
           sparse array that renders as a gap in the ruler. */
        for (let i = from; i !== to; i += step) {
          if (i >= 0 && i < next.length) next[i] += 1;
        }
        return next;
      });
    },
    [index, tickOf],
  );
  /* Applying an index, wherever it came from. The pointer path below and the
     input's own change event — which is now only the keyboard — both land
     here, so the wake, the detent and the caller are driven identically. */
  const applyIndex = useCallback(
    (at: number) => {
      const next = frames[at];
      if (next === undefined || next === value) return;
      // Same test rippleTo lights on, so sound and wake agree.
      const crossed = tickOf(at) !== tickOf(index);
      rippleTo(at);
      if (crossed) detent();
      onChange(next);
    },
    [frames, value, index, tickOf, rippleTo, detent, onChange],
  );

  /* The value read off the pointer rather than left to the native thumb drag.
   *
   * iOS starts a range drag only when the touch lands near the thumb, and this
   * thumb is 3px wide. Measured on device: every gesture beginning within 12px
   * of it tracked, every one beginning 22px or further away delivered its
   * pointermove events and never moved the value. Leave the slider at either
   * end and the thumb sits on the edge, so the next press lands far from it —
   * which is why the control went dead after the first drag.
   *
   * Reading the position here also gives press-to-jump, which the native
   * control does with a mouse and not with a finger. The element stays a real
   * range for the keyboard and for assistive technology; only the pointer
   * path is ours. */
  const dragging = useRef(false);

  const seek = useCallback(
    (el: HTMLInputElement, clientX: number) => {
      const box = el.getBoundingClientRect();
      const last = frames.length - 1;
      if (box.width <= 0 || last < 1) return;
      const t = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
      applyIndex(Math.round(t * last));
    },
    [applyIndex, frames.length],
  );

  const ahead = index > nowIndex;
  const minutesAhead = Math.round((value - frames[nowIndex]) / 60_000);

  const clock = (t: number) =>
    new Date(t).toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    });

  /* Where the present falls along the track, as a fraction. The ruler is
     decorative and does not line up with frames one for one, so the marker
     is positioned rather than being one of the ticks. */
  const nowAt = frames.length > 1 ? nowIndex / (frames.length - 1) : 1;

  /* The strip alone. The row it sits in, and the credits above it, belong to
     the page: both exist before there is a sequence to show, and this
     component does not. */
  return (
    <>
      {/* 46rem when the strip held three controls; it now holds six, and the
          ruler was giving up its pitch to them. Still capped. */}
      <div
        ref={strip}
        className="t-strip flex w-full max-w-[64rem] items-center justify-center gap-1.5 sm:gap-2"
        data-scrubbing={scrubbing}
      >
        {/* Its own surface, not a compartment of the slider's. The two are
            different kinds of control — one is a switch, the other a
            continuous scrub — and a pill each says so, the way the dock
            opposite is one pill for one group of buttons. Matched in height
            so they read as a pair rather than as a misalignment. */}
        <button
          type="button"
          onClick={onTogglePlay}
          className="dock-surface dock-btn dock-btn-lg shrink-0 rounded-full"
          aria-label={playing ? "Ferma l'animazione" : "Anima la sequenza"}
          aria-pressed={playing}
        >
          <span className="t-icon-swap" data-state={playing ? "stop" : "play"}>
            <Play className="t-icon" data-icon="play" size={16} />
            <Stop className="t-icon" data-icon="stop" size={16} />
          </span>
        </button>

        {/* The present is 1 of 61 frames; hitting it by hand means aiming. */}
        <button
          type="button"
          onClick={onNow}
          disabled={index === nowIndex}
          /* Fade the glyph, never the button: `opacity` on the surface takes
             its `backdrop-filter` with it. */
          className="dock-surface dock-btn dock-btn-lg shrink-0 rounded-full disabled:cursor-default"
          aria-label="Torna all'istante attuale"
        >
          <Clock size={16} className={index === nowIndex ? "opacity-40" : undefined} />
        </button>

        <div
          ref={ruler}
          className="t-strip-ruler dock-surface control-h grid min-w-0 max-w-[52rem] flex-1 grid-cols-[1fr_auto] items-center gap-2 rounded-full px-3 sm:gap-3 sm:px-4">
          <div className="tick-slider" ref={track}>
          <div className="tick-marks" aria-hidden="true">
            {pulses.map((count, i) => {
              /* The ruler is decorative and does not line up with frames one
                 for one, so a tick is "ahead" by where it sits along the
                 track, not by its index. */
              const ahead = i / (ticks - 1) > nowAt + 1e-9;
              return (
                <span
                  key={`${i}-${count}`}
                  className={
                    `${i % MAJOR === 0 ? "is-step" : ""}${ahead ? " is-ahead" : ""}${count > 0 ? " is-pulsing" : ""}`.trim() ||
                    undefined
                  }
                />
              );
            })}
          </div>

          {/* The present, on the track rather than in the tick row, so it
              stays put whatever tick density is chosen. */}
          <span className="tick-now" style={{ left: `${nowAt * 100}%` }} />

          <input
            type="range"
            min={0}
            max={frames.length - 1}
            step={1}
            value={index}
            aria-label="Momento della sequenza radar"
            aria-valuetext={
              !ahead
                ? clock(value)
                : forecastSource === "none"
                  ? "previsione non disponibile"
                  : forecastSource === "model"
                    ? `previsione a ${minutesAhead} minuti, dal vento di trascinamento anziché dal moto misurato dell'eco`
                    : `previsione a ${minutesAhead} minuti`
            }
            /* Spends the gesture that starts the drag on a silent note, so
               the AudioContext is already unlocked when the first real detent
               arrives a few milliseconds later. Without it the browser
               swallows that first tick — the one that tells you the control
               is live — and the scrub feels mute until the second frame. */
            onPointerDown={(e) => {
              sound.prime();
              beginScrub();
              dragging.current = true;
              /* Explicit rather than relying on the implicit capture a touch
                 gets: with a mouse there is none, and the drag has to survive
                 the pointer leaving the pill. */
              e.currentTarget.setPointerCapture(e.pointerId);
              seek(e.currentTarget, e.clientX);
            }}
            onPointerMove={(e) => {
              if (dragging.current) seek(e.currentTarget, e.clientX);
            }}
            /* Letting go, once. `onPointerUp` misses the drag that ends off
               the element and the gesture the browser cancels, and the range
               has pointer capture, so both are routed back here. */
            onPointerUp={(e) => {
              dragging.current = false;
              sound.release();
              endScrub();
            }}
            onPointerCancel={(e) => {
              dragging.current = false;
              sound.release();
              endScrub();
            }}
            /* A capture lost to a system gesture fires neither handler above. */
            onLostPointerCapture={(e) => {
              dragging.current = false;
              endScrub();
            }}
            /* Arrow keys, Home and End. A pointer drag is handled above and
               reaches the same applyIndex, so a native change that repeats it
               is dropped by its own no-op test. */
            onChange={(e) => {
              /* The pointer path owns the value while a drag is live. Where
                 the native drag works it computes the same index to within a
                 rounding boundary, and letting both write meant the two could
                 disagree by one step and oscillate. */
              if (dragging.current) return;
              applyIndex(Number(e.currentTarget.value));
            }}
          />
        </div>

        {/* Clock only. The labels that sat above it restated the value: a past
            time is an observation, a future one already carries its lead.

            The lead is now the sole marker of a forecast, so it stays in the
            accent colour and drops to muted only when the motion could not be
            estimated. `aria-valuetext` carries the full distinction.

            Width: the clock is tabular and two-digit, so only the lead varies.
            Below `sm` the box is sized to content and the lead opens and
            closes — 34px is half the ruler there. Above `sm` the box is
            pinned, because the ruler cannot shorten mid-drag. Either way the
            digits stay flush right until there is a lead. */}
        <div className="t-readout numeric flex h-[25px] items-center justify-end text-[13px] font-medium leading-none sm:w-[4.5rem]">
          {/* Morphed: only the digits that differ move, so a minute ticking
              over turns one character and leaves the rest still, where a hard
              swap at this rate reads as the whole readout flickering.

              The lead beside it is not morphed. It carries its own colour —
              the accent that marks a forecast — and TextMorph takes a string,
              so folding the two together would have cost the one thing that
              distinguishes a forecast from an observation now that the labels
              are gone. */}
          {/* The two share a baseline; the pair is centred in the row. One
              container cannot do both — `items-baseline` on the outer box put
              the text off-centre vertically, `items-center` let the clock and
              the lead resolve their own baselines separately. */}
          <span className="flex items-baseline">
            <TextMorph
              as="span"
              duration={200}
              ease="cubic-bezier(0.22, 1, 0.36, 1)"
              respectReducedMotion
              className={ahead ? "text-fg-soft" : "text-fg"}
            >
              {clock(value)}
            </TextMorph>
            {/* The slot is always here, whether or not there is a lead to put
                in it. Rendered only when ahead, it pushed the clock 32px to the
                left the moment the present was crossed — the one thing a fixed,
                right-aligned box exists to prevent. Reserved, the digits keep
                their column and only the lead appears. */}
            {/* Always mounted, width 0 when empty. Mounting it on demand shoved
                the digits 32px in one frame; reserving it always left the space
                empty most of the time. */}
            <span
              aria-hidden={!ahead}
              data-open={ahead}
              className={`t-lead ${
                forecastSource === "none" ? "text-muted" : "text-[var(--ramp-6)]"
              }`}
            >
              {/* The minutes sit in a fixed two-digit slot so both edges hold:
                  the box is right-aligned, so the prime lands on the readout's
                  edge whatever the lead says, and the slot is a constant width,
                  so the plus does not move when the count crosses ten. Without
                  it one of the two gives — left-aligned the right edge went
                  ragged, right-aligned the plus jumped 8px. */}
              {ahead ? (
                <>
                  +<span className="t-lead-n">{minutesAhead}</span>′
                </>
              ) : (
                ""
              )}
            </span>
          </span>
        </div>
        </div>

        {trailing}
      </div>
    </>
  );
}
