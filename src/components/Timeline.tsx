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
import { Play, Stop } from "reicon-react";
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

/** The age, said the way it would be spoken — the value alone, so the word
 *  "aggiornato" can stay muted while the figure carries the emphasis. */
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
  forecastSource,
  trailing,
}: Props) {
  const haptics = useHaptics();
  const age = useAge(frames[observedCount - 1]);
  const sound = useSound();

  /* A detent is only worth announcing every so often. Dragged quickly the
     thumb crosses ten frames in a tenth of a second, and firing on each one
     turns the click into a rattle and the haptics into a buzz. 58 ms is the
     interval ui.camera's own controls use. */
  const lastDetent = useRef(0);

  const detent = useCallback(() => {
    const now = performance.now();
    if (now - lastDetent.current < 58) return;
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

  const fitTicks = useCallback(
    (width: number) => {
      if (width <= 0) return;
      const next = tickCountFor(width, frames.length);
      setPulses((prev) => (prev.length === next ? prev : Array(next).fill(0)));
    },
    [frames.length],
  );

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

  /* The one state with no lead time to report, and so the one whose second
     line is free. Its label is the only string that did not fit a compact
     readout, so it takes that line instead of forcing the box wider. */
  const noForecast = ahead && forecastSource === "none";

  /* Both sources say "Previsione": each is a real forecast with a real lead
     time, and the difference between them is one of confidence rather than
     of kind. The distinction is not thrown away — it is carried in the
     accessible description, where it can be spelled out properly instead of
     compressed into a word that would have to carry more than a word can. */
  const status = noForecast ? "Non" : ahead ? "Previsione" : "Rilevato";

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
      <p className="on-map text-muted pointer-events-none text-center text-[11px]">
        Dati radar del{" "}
        <span className="text-fg-soft">
          Dipartimento della Protezione Civile
        </span>
        {age !== null && (
          <>
            {/* Separated by a middot rather than punctuated: the credit and
                the freshness are two facts of equal weight about the same
                data, not a sentence with a subordinate clause. */}
            <span className="mx-1.5 opacity-50">·</span>
            aggiornato{" "}
            {/* The figure in the same weight as the attribution beside it:
                both are the fact, and the words around them are scaffolding. */}
            <span className="text-fg-soft">{ageValue(age)}</span>
          </>
        )}
      </p>

      <div className="flex w-full max-w-[46rem] items-center justify-center gap-2">
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

        <div className="dock-surface grid h-11 min-w-0 max-w-[38rem] flex-1 grid-cols-[1fr_auto] items-center gap-3 rounded-full pl-4 pr-4">
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
            onPointerDown={() => sound.prime()}
            /* Letting go, once. `onPointerUp` misses the drag that ends off
               the element and the gesture the browser cancels, and the range
               has pointer capture, so both are routed back here. */
            onPointerUp={() => sound.release()}
            onPointerCancel={() => sound.release()}
            onChange={(e) => {
              const at = Number(e.currentTarget.value);
              const next = frames[at];
              if (next === value) return;
              rippleTo(at);
              detent();
              onChange(next);
            }}
          />
        </div>

        {/* Morphed rather than replaced. The readout changes on every step of
            a drag and on every frame of the loop, and a hard swap at that rate
            reads as flicker — the digits appear to jump rather than to count.
            Torph animates the characters that actually differ, so a minute
            ticking over moves one digit and leaves the rest still. */}
        {/* leading-[0] collapses the line boxes: torph renders its roots as
            inline-block, so each one sat inside a 16px line box inherited from
            here and the pair was pushed seven pixels apart by leading alone,
            not by any margin. With the strut gone the gap is whatever we ask
            for. */}
        {/* Fixed box, right-aligned, tall enough for both lines whether or
            not the second one is there.

            It used to be 4.5rem, which fits "Rilevato" and "Previsione" and
            not "Non disponibile" — the long label overflowed and stopped
            lining up with the other two on the right edge. Sizing to the
            longest string keeps all three flush; a fixed height keeps the
            row from resizing when the second line goes away, which would
            otherwise make the whole dock twitch as you cross the present.

            4.25rem, not the 6.25rem it was. The box has to reserve its widest
            state or the dock twitches, but it was reserving eighty-seven
            pixels for "Non disponibile" and then rendering "Rilevato" at
            forty-six — leaving forty-one pixels of nothing pressed right up
            against the ruler, in the state the timeline is in by default.

            So the long label takes two lines instead. It appears only where
            there is no lead time to show, which is exactly the state whose
            second line is already empty — the room it needs is room nothing
            else wanted. CSS wrapping could not do this: torph splits its
            text into inline-block spans joined by a non-breaking space, so
            there is no break opportunity to give it. Splitting the string
            ourselves also puts the break where we want it.

            The widest string the box must now hold is "disponibile" at
            61.8px, not the whole phrase at 87.3, and the ruler gets the
            difference. Right-aligned, so every line stays flush with the
            other labels. */}
        <div className="flex h-[25px] w-[4.25rem] flex-col justify-center items-end leading-[0]">
          <TextMorph
            as="div"
            duration={200}
            ease="cubic-bezier(0.22, 1, 0.36, 1)"
            respectReducedMotion
            className="text-muted text-right text-[9px] font-medium uppercase leading-none tracking-[0.08em]"
          >
            {status}
          </TextMorph>
          {noForecast ? (
            /* The rest of the label, in the label's own type rather than the
               value's: it is still the status talking, and setting it at
               13px would read as a number that failed to render. */
            <div className="text-muted mt-[3px] text-right text-[9px] font-medium uppercase leading-none tracking-[0.08em]">
              disponibile
            </div>
          ) : (
            /* Not morphed. The clock changes on every step of a drag and on
               every frame of the loop, and animating a value that moves that
               often turns a readout into something you wait for rather than
               read. The label above changes twice in a whole scrub, at the
               boundary — which is exactly when a morph earns its place. */
            <div
              className={`numeric mt-[3px] text-[13px] font-medium leading-none ${
                ahead ? "text-[var(--ramp-6)]" : "text-fg"
              }`}
            >
              {ahead ? `+${minutesAhead}′` : clock(value)}
            </div>
          )}
          </div>
        </div>

        {trailing}
      </div>
    </div>
  );
}
