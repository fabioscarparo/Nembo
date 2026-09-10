"use client";

/**
 * The freshness of the data and the attribution the DPC's terms require.
 *
 * Its own component, and rendered by the page rather than by the timeline,
 * for one reason: it is the first substantial text on screen, and inside the
 * timeline it could not be. The timeline mounts only once a sequence exists,
 * so this line waited on the network before it could paint — Lighthouse
 * picked it as the largest contentful element and measured 3.3 s of render
 * delay behind it. Here it is in the static HTML, painted with the shell.
 */
import { memo, useState } from "react";

import { usePageVisible, useVisibleInterval } from "@/lib/visibility";

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

/* Memoised for the same reason Dock and PlacePill are: this sits in the page,
   so every step of a scrub re-renders RadarMap and would rebuild it. `at`
   moves once an observation, not once a frame. */
function Credits({ at }: { at: number | undefined }) {
  const age = useAge(at);

  /* Freshness first: it is the half that changes. `on-map` carries the
     legibility over whatever the map is showing.
  
     The first line is always rendered, empty until there is an age to put in
     it. Letting it appear later would grow a bottom-anchored column upward
     and move the attribution under the reader's eye — small enough not to
     cost a CLS point, large enough to see. A non-breaking space holds the
     line box; `aria-hidden` keeps assistive technology from announcing it. */
  return (
    <div className="on-map text-fg pointer-events-none flex flex-col items-center gap-[3px] text-center text-[11px] leading-tight">
      {/* Full width, not shrink-wrapped. The non-breaking space holds the
          line's height, but inside an `items-center` column the box itself
          still grew from a hair to the width of the text — which is a layout
          shift, and the one Lighthouse names. Stretched to the column, only
          the content changes. */}
      <p className="w-full" aria-hidden={age === null}>
        {age === null ? "\u00A0" : `aggiornato ${ageValue(age)}`}
      </p>
      <p>Dati radar del Dipartimento della Protezione Civile</p>
    </div>
  );
}

export default memo(Credits);
