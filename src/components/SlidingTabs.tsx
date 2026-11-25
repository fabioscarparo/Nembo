"use client";

/**
 * A row of options with one pill that travels between them.
 *
 * Used twice — the dock's quantity and the panel's theme — and written for the
 * second. It was extracted when the first needed it, because the measurement
 * below is fiddly enough that two copies would have drifted the moment either
 * one's padding changed.
 *
 * The pill cannot be positioned in CSS: its width and offset are properties of
 * whichever option is selected, which only layout knows. So they are read from
 * the DOM and written inline, and the first write of each run is made with the
 * transition suspended so the pill never tweens from a position nobody chose.
 * Everything else about it is in globals.css under "Sliding tabs".
 *
 * @see https://transitions.dev/detail.html?t=tabs-sliding
 */
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** One option. Generic over the value so a caller keeps its own union — the
 *  dock's ProductKey, the panel's ThemeChoice — rather than casting strings. */
export type TabOption<T extends string> = {
  value: T;
  /** What the option reads on screen. */
  label: string;
  /** What it reads aloud, when the visible label is a unit or an
   *  abbreviation that would be meaningless said out of context. */
  srLabel?: string;
};

type Props<T extends string> = {
  /** In display order. Five or fewer, realistically: the pill has to stay
   *  wide enough to read the label inside it. */
  options: readonly TabOption<T>[];
  /** Controlled. The component holds no selection of its own. */
  value: T;
  onPick: (value: T) => void;
  /** Names the group. Use `labelledBy` instead when a visible label exists. */
  label?: string;
  labelledBy?: string;
  /** Extra classes on the track — sizing, and which surface it sits on. */
  className?: string;
  /** False during initial hydration so restoring a stored choice snaps the
   *  pill without sliding across options nobody clicked. */
  animate?: boolean;
};

/**
 * @param options   In display order. Five or fewer, realistically — the pill
 *                  has to stay wide enough to read the label inside it.
 * @param value     Which one is selected. The component is controlled; it
 *                  holds no selection of its own.
 * @param onPick    Called with the chosen value, including when it is the one
 *                  already selected — the caller decides whether that is a
 *                  no-op, because only the caller knows if it has a side
 *                  effect worth suppressing.
 * @param className Applied to the track. This is how a caller picks the
 *                  variant (`t-tabs-fill` for equal widths, `dock-tabs` for
 *                  the transparent one) as well as the type size.
 */
export default function SlidingTabs<T extends string>({
  options,
  value,
  onPick,
  label,
  labelledBy,
  className = "",
  animate = true,
}: Props<T>) {
  const bar = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const mounted = useRef(false);

  const placePill = useCallback((shouldAnimate: boolean) => {
    const el = bar.current;
    const p = pill.current;
    if (!el || !p) return;

    const active = el.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    if (!active) return;

    /* Suspended, forced, restored. Without this the pill tweens from wherever
       it happened to be — which on first paint is x=0 with no width, so it
       would visibly grow out of the left edge on every mount, and on a resize
       it would slide to a position nobody chose. */
    if (!shouldAnimate) p.style.transition = "none";
    p.style.width = `${active.offsetWidth}px`;
    p.style.transform = `translateX(${active.offsetLeft}px)`;
    if (!shouldAnimate) {
      void p.offsetWidth;
      p.style.transition = "";
    }
  }, []);

  /* Before paint, so the pill is already in place the first time it is seen
     rather than snapping into it a frame later. */
  useLayoutEffect(() => {
    placePill(false);
  }, [placePill, options]);

  /* Animated on subsequent user changes only; initial mount is already placed
     by useLayoutEffect, and hydration swaps snap via `animate={false}`. */
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    placePill(animate);
  }, [value, animate, placePill]);

  /* Labels reflow — a font landing late, a panel resizing, a viewport turning
     — and a pill measured against the old layout would sit wrong. */
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    let alive = true;
    const observer = new ResizeObserver(() => placePill(false));
    observer.observe(el);
    void document.fonts?.ready.then(() => {
      if (alive) placePill(false);
    });
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [placePill]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
      let nextIdx = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        nextIdx = (idx + 1) % options.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        nextIdx = (idx - 1 + options.length) % options.length;
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = options.length - 1;
      }
      if (nextIdx < 0) return;
      e.preventDefault();
      onPick(options[nextIdx].value);
      const buttons = bar.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      buttons?.[nextIdx]?.focus();
    },
    [options, onPick],
  );

  return (
    <div
      ref={bar}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`t-tabs ${className}`.trim()}
    >
      <span ref={pill} className="t-tabs-pill" aria-hidden />
      {options.map((o, i) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            aria-label={o.srLabel}
            onClick={() => onPick(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className="t-tab"
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
