"use client";

/**
 * The quantity on screen, and the legend that explains it.
 *
 * The gear used to sit here too, behind a hairline that was apologising for
 * the grouping: one pill held a control that changes what the radar measures
 * and two that open panels. It has gone down to the timeline's row, where the
 * things you press live. The legend stayed because it is about what is on
 * screen right now — the same subject as the tabs beside it — and because it
 * is the panel you open while reading the map rather than while setting it up.
 *
 * Two pills, not one. The divider is gone with the thing it was separating:
 * a gap says the same and says it more quietly.
 *
 * Memoised, because it is rebuilt by every step of a scrub otherwise: dragging
 * the slider re-renders RadarMap, and these buttons and their icons have
 * nothing to do with which minute is selected. The prize is not the render
 * cost of three buttons, it is keeping the hot path down to what changed.
 */
import { memo, useMemo } from "react";
import { InfoCircle } from "reicon-react";

import { PRODUCTS, PRODUCT_CYCLE, type ProductKey } from "@/lib/dpc";
import SlidingTabs, { type TabOption } from "./SlidingTabs";

/** Fully controlled: the dock holds nothing of its own. */
type Props = {
  /** Which quantity is on screen; drives which tab carries the pill. */
  product: ProductKey;
  onPickProduct: (key: ProductKey) => void;
  /** Reflected in `aria-pressed` and in the icon's colour, so the button says
   *  whether its panel is up without the panel being in view. */
  legendOpen: boolean;
  onToggleLegend: () => void;
};

/**
 * The quantity is three tabs rather than one button that cycles, for the same
 * reason the theme stopped being one: a single label reading "dBZ" says what
 * you are looking at and gives no sign that it can be changed at all, let
 * alone into what. Three of them, with the current one carrying a pill, say
 * both at once.
 *
 * Memoising works because none of these props move while scrubbing — the
 * callbacks are stable across a drag, so React can skip the subtree entirely.
 */
function DockControls({
  product,
  onPickProduct,
  legendOpen,
  onToggleLegend,
}: Props) {
  /* The unit is the label because it is the shortest honest name for what is
     on screen, and the one the legend's own heading repeats. The full name
     goes to assistive technology, where "mm/h" alone would be read as three
     letters and a slash. */
  const units = useMemo<TabOption<ProductKey>[]>(
    () =>
      PRODUCT_CYCLE.map((key) => ({
        value: key,
        label: PRODUCTS[key].unit,
        srLabel: `${PRODUCTS[key].label} (${PRODUCTS[key].unit})`,
      })),
    [],
  );

  return (
    /* `ml-auto` rather than the row's `justify-between`: the place pill is
       absent until a fix arrives, and with one child `justify-between` would
       park the dock on the left until it did. */
    <div className="pointer-events-auto ml-auto flex shrink-0 items-center gap-2">
      <div className="dock-surface dock-pill">
        <SlidingTabs
          options={units}
          value={product}
          onPick={onPickProduct}
          label="Grandezza"
          className="dock-tabs numeric text-[10px] font-medium"
        />
      </div>

      {/* Its own pill, at the same diameter as every round button on the map.
          Inside the tabs' pill it would have read as a fourth quantity. */}
      <button
        type="button"
        onClick={onToggleLegend}
        className="dock-surface dock-btn dock-btn-lg dock-toggle rounded-full"
        aria-label="Come leggere il radar"
        aria-pressed={legendOpen}
        aria-expanded={legendOpen}
      >
        <InfoCircle size={16} className={legendOpen ? "text-fg" : undefined} />
      </button>
    </div>
  );
}

export default memo(DockControls);
