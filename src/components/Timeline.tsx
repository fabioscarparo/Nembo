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
import { usePageVisible, useVisibleInterval } from "@/lib/visibility";
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
 * How long ago the newest measurement was taken, in whole minutes.
 *
 * On its own timer rather than derived at render: paused, nothing else in
 * this component re-renders, and a staleness readout that silently stops
 * ageing is worse than none — it would keep claiming the data was two
 * minutes old an hour later. Half a minute is well inside the five the DPC
 * takes between scans, so the number is never visibly behind.
 */
function useAge(at: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const visible = usePageVisible();

  /* Stopped while hidden, and resynced the moment the page comes back: a
     clock that keeps ticking in a background tab is work for nobody, and one
     that resumes without catching up would claim the data is two minutes old
     an hour later — the exact failure this hook exists to avoid. */
  useVisibleInterval(() => setNow(Date.now()), 30_000, visible);

  if (at === undefined) return null;
  // Clocks disagree; a scan cannot be from the future, so clamp rather than
  // render "aggiornato -1 minuti fa".
  return Math.max(0, Math.round((now - at) / 60_000));
}

/** The age, said the way it would be spoken. The value alone: the word
 *  "aggiornato" is supplied by the caller, which is also where the two are
 *  set — in one weight now, having been two. */
function ageValue(minutes: number) {
  if (minutes < 1) return "adesso";
  if (minutes === 1) return "1 minuto fa";
  return `${minutes} minuti fa`;
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
  const age = useAge(frames[observedCount - 1]);
  const sound = useSound();

  /* Fired when a mark is crossed, not when a frame changes.
  
     There are more frames than marks — sixty-one minutes over about forty
     ticks — so the two do not line up, and clicking per frame meant the sound
     and the ruler disagreed: marks went by in silence, and clicks arrived with
     nothing moving under them. Gating on the mark the thumb actually leaves
     puts the click on the thing the eye is following.
  
     The throttle stays, at less than half of what it was. It is now a floor on
     how fast the ear can take detents rather than a stand-in for the pitch of
     the ruler, which the mark test already provides — and at 58 ms a quick
     flick across forty marks would have been rationed down to five clicks,
     which is what made a fast scrub feel unhitched from the drag. */
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
  /* True between pressing the ruler and letting go. Only the row below reads
     it, and only on a narrow screen, where it hands the ruler the width the
     buttons were holding. */
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

  /* Held while the row is opening or closing. The observer fires on every
     frame of that, and refitting on each one made the ruler re-densify twice
     on the way out and twice on the way back — marks visibly rearranging
     under a finger that had not moved. The count is set once, to what the
     final width will be, and the animation is left to spread the marks it
     already has into place. */
  const locked = useRef(false);

  const fitTicks = useCallback(
    (width: number) => {
      if (locked.current || width <= 0) return;
      const next = tickCountFor(width, frames.length);
      setPulses((prev) => (prev.length === next ? prev : Array(next).fill(0)));
    },
    [frames.length],
  );

  /**
   * What the track will measure once the row has finished opening.
   *
   * The expanded pill is the whole strip; the track gets that, less the pill's
   * own padding, the gap inside it and the readout beside it. All four are
   * read off the DOM rather than repeated here, so changing any of them in the
   * stylesheet cannot leave this holding a stale number.
   */
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

  /* The final density, set before the row starts moving. Only below `sm`:
     that is the only width where anything collapses, and above it the lock
     would just be holding a stale count. */
  const beginScrub = useCallback(() => {
    setScrubbing(true);
    if (!window.matchMedia("(max-width: 639px)").matches) return;
    const target = expandedTrack();
    if (target <= 0) return;
    const next = tickCountFor(target, frames.length);
    setPulses((prev) => (prev.length === next ? prev : Array(next).fill(0)));
    locked.current = true;
  }, [expandedTrack, frames.length]);

  /* Released, but the row is still closing — so the lock stays on until the
     pill has finished travelling and the observer can be trusted again. */
  const endScrub = useCallback(() => {
    setScrubbing(false);
    const pill = ruler.current;
    if (!pill || !locked.current) return;
    const done = () => {
      locked.current = false;
      const el = track.current;
      if (el) fitTicks(el.getBoundingClientRect().width);
    };
    pill.addEventListener("transitionend", done, { once: true });
    /* A transition that never runs — reduced motion, or a release in the same
       frame as the press — would otherwise leave the lock on for good. */
    window.setTimeout(done, 400);
  }, [fitTicks]);

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

  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-4 pb-5">
      {/* Required by the DPC's terms, and it belongs on the surface rather
          than in a readme: the data is theirs, the colours are not. It lives
          here rather than in the page because the timeline is the only thing
          that knows how tall it is, and the line has to sit just above it
          however that changes. */}
      {/* Two lines, one colour. The freshness used to sit after the credit
          behind a middot, with the two figures that matter set a shade darker
          than the words around them — which made a line of four weights that
          read as three separate remarks rather than one caption. Both lines
          are full-strength ink now; `on-map` is what keeps them legible over
          whatever the map happens to be showing underneath.

          The reading goes first because it is the one that changes: how old
          the picture is answers a question you might actually be asking. The
          attribution below it is required by the DPC's terms and does not
          change from one minute to the next.

          It lives here rather than in the page because the timeline is the
          only thing that knows how tall it is, and this has to sit just above
          it however that changes. */}
      <div className="on-map text-fg pointer-events-none flex flex-col items-center gap-[3px] text-center text-[11px] leading-tight">
        {age !== null && <p>aggiornato {ageValue(age)}</p>}
        <p>Dati radar del Dipartimento della Protezione Civile</p>
      </div>

      {/* Wider than it was. The strip used to hold play, the ruler and one
          button; it now holds five buttons, and at 46rem the ruler was giving
          up its width to them — the marks were spaced by what the buttons left
          rather than by the pitch they are meant to have. Still capped, so the
          control does not stretch across a very wide monitor. */}
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

        {/* Back to the present. Its own button rather than a tap on the ruler:
            the present is one minute out of sixty-one and landing on it by
            hand means aiming, which is the opposite of what a scrub is for.
            Disabled when already there, so it reads as a state and not just
            as a control that does nothing. */}
        <button
          type="button"
          onClick={onNow}
          disabled={index === nowIndex}
          /* The fade is on the glyph, not on the button. `opacity` on the
             surface takes the frosted panel down with it — a `backdrop-filter`
             is composited with the element it belongs to — so a disabled
             button stopped being a pill over the map and became a pale patch
             of the map itself. The icon is the part that should look spent. */
          className="dock-surface dock-btn dock-btn-lg shrink-0 rounded-full disabled:cursor-default"
          aria-label="Torna all'istante attuale"
        >
          <Clock size={16} className={index === nowIndex ? "opacity-40" : undefined} />
        </button>

        <div
          ref={ruler}
          className="t-strip-ruler dock-surface grid h-11 min-w-0 max-w-[52rem] flex-1 grid-cols-[1fr_auto] items-center gap-2 rounded-full px-3 sm:gap-3 sm:px-4">
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
            onPointerDown={() => {
              sound.prime();
              beginScrub();
            }}
            /* Letting go, once. `onPointerUp` misses the drag that ends off
               the element and the gesture the browser cancels, and the range
               has pointer capture, so both are routed back here. */
            onPointerUp={() => {
              sound.release();
              endScrub();
            }}
            onPointerCancel={() => {
              sound.release();
              endScrub();
            }}
            /* Belt and braces: a capture lost to a system gesture — the swipe
               that pulls down a notification shade mid-drag — fires neither of
               the two above, and the row would stay expanded with no drag under
               it. */
            onLostPointerCapture={() => endScrub()}
            onChange={(e) => {
              const at = Number(e.currentTarget.value);
              const next = frames[at];
              if (next === value) return;
              /* The mark, not the minute. Same test `rippleTo` uses to decide
                 what to light, so what is heard and what lights up are the
                 same event rather than two approximations of it. */
              const crossed = tickOf(at) !== tickOf(index);
              rippleTo(at);
              if (crossed) detent();
              onChange(next);
            }}
          />
        </div>

        {/* Only the clock. The two words that used to sit above it —
            "Rilevato" and "Previsione" — named a distinction the readout was
            already making: a time in the past is an observation and there is
            nothing else it could be, and a time in the future carries a lead
            beside it. The label was restating its own value.

            The lead is what marks the forecast now, so it has to be legible
            as a sign and not only as a number: it keeps the accent colour
            when there is a forecast behind it, and drops to muted when the
            motion could not be estimated and the frames ahead are empty. The
            full explanation of which is which stays in `aria-valuetext`,
            where it can be a sentence.

            One line, sized to what is in it. The box used to reserve its
            widest state — "18:35 +30′" — so that crossing the present could
            not resize the ruler under the finger dragging it. But the clock is
            tabular and two-digit, so it never changes width; the only thing
            that does is the lead, and the reservation was 34px of nothing
            sitting beside the digits for the whole time the timeline is in its
            default state. The lead opens and closes on its own instead. It
            costs the ruler 34px when it appears, which is under a tick either
            way: the count snaps to multiples of five, and it lands on the same
            number at both widths.

            Above `sm` the box is pinned to its widest state instead. The
            trade goes the other way there: the ruler has hundreds of pixels
            and cannot afford to shorten every time the loop crosses the
            present, while 34px of slack beside the digits costs nothing you
            can see. The lead still opens and closes inside it, so the clock
            still sits flush right whenever there is no lead to make room
            for.

            Not morphed either, for the reason the clock never was: it changes
            on every step of a drag and on every frame of the loop, and
            animating a value that moves that often turns a readout into
            something you wait for rather than read. */}
        <div className="t-readout numeric flex h-[25px] items-center justify-end text-[13px] font-medium leading-none sm:w-[4.5rem]">
          {/* Morphed: only the digits that differ move, so a minute ticking
              over turns one character and leaves the rest still, where a hard
              swap at this rate reads as the whole readout flickering.

              The lead beside it is not morphed. It carries its own colour —
              the accent that marks a forecast — and TextMorph takes a string,
              so folding the two together would have cost the one thing that
              distinguishes a forecast from an observation now that the labels
              are gone. */}
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
          {/* Always mounted, and closed to nothing when there is no lead to
              show. Mounted only when ahead it appeared from nowhere and shoved
              the digits 32px sideways in a single frame; reserved at full
              width it left that space empty whenever the timeline was showing
              an observation, which is most of the time. Opening it is the only
              version with neither fault. */}
          <span
            aria-hidden={!ahead}
            data-open={ahead}
            className={`t-lead ${
              forecastSource === "none" ? "text-muted" : "text-[var(--ramp-6)]"
            }`}
          >
            {ahead ? `+${minutesAhead}′` : ""}
          </span>
        </div>
        </div>

        {trailing}
      </div>
    </div>
  );
}
