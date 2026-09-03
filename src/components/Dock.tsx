"use client";

/**
 * The three controls that live in the corner, and nothing else.
 *
 * Three because they are three kinds of thing: the quantity changes what the
 * radar measures, the legend explains what is on screen, the gear opens the
 * preferences. Sound and theme used to sit here too, which made a row of four
 * glyphs where half changed the data and half changed the page — and made
 * "which theme am I on?" a question you answered by pressing until it looked
 * right. They are named controls in a panel now; see Settings.tsx.
 *
 * Memoised, because it is rebuilt by every step of a scrub otherwise: dragging
 * the slider re-renders RadarMap, and these buttons and their icons have
 * nothing to do with which minute is selected. The prize is not the render
 * cost of three buttons, it is keeping the hot path down to what changed.
 */
import { memo, useMemo } from "react";
import { Gear, InfoCircle } from "reicon-react";

import { PRODUCTS, PRODUCT_CYCLE, type ProductKey } from "@/lib/dpc";
import SlidingTabs, { type TabOption } from "./SlidingTabs";

/**
 * Fully controlled: the dock holds nothing. Both panels' open states live in
 * RadarMap because they are mutually exclusive, and a component that owns half
 * of a mutual exclusion owns a bug.
 */
type Props = {
  /** Which quantity is on screen; drives which tab carries the pill. */
  product: ProductKey;
  onPickProduct: (key: ProductKey) => void;
  /** Reflected in `aria-pressed` and in the icon's colour, so the button says
   *  whether its panel is up without the panel being in view. */
  legendOpen: boolean;
  onToggleLegend: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
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
  settingsOpen,
  onToggleSettings,
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
    <div className="pointer-events-auto ml-auto shrink-0">
      <div className="dock-surface dock-pill">
        <SlidingTabs
          options={units}
          value={product}
          onPick={onPickProduct}
          label="Grandezza"
          className="dock-tabs numeric text-[10px] font-medium"
        />

        {/* Hairline between the quantity and the two panels it has nothing to
            do with. Without it the five controls read as one undifferentiated
            row, which is what the redesign was getting away from. */}
        <span className="dock-divider" aria-hidden />

        <button
          type="button"
          onClick={onToggleLegend}
          className="dock-btn"
          aria-label="Come leggere il radar"
          aria-pressed={legendOpen}
          aria-expanded={legendOpen}
        >
          <InfoCircle size={16} className={legendOpen ? "text-fg" : undefined} />
        </button>

        <button
          type="button"
          onClick={onToggleSettings}
          className="dock-btn"
          aria-label="Impostazioni"
          aria-pressed={settingsOpen}
          aria-expanded={settingsOpen}
        >
          <Gear size={16} className={settingsOpen ? "text-fg" : undefined} />
        </button>
      </div>
    </div>
  );
}

export default memo(DockControls);
