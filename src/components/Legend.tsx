"use client";

/**
 * What the colours mean, for whichever quantity is on screen.
 *
 * Both halves of this panel are derived rather than restated, and for the same
 * reason: a legend that disagrees with its map is worse than no legend. The
 * gradient is sampled from the lookup table the map is actually painting
 * through, so recolouring the radar moves this in the same commit; the words
 * come from the product's own entry in dpc.ts, so selecting rain rate cannot
 * leave the panel explaining reflectivity.
 *
 * The icons are the exception, and deliberately: they are positional — one
 * drop, several, rain, a storm, a tornado — so they suit any product whose
 * legend declares five rising bands, and they stay here because this file has
 * the React dependency and dpc.ts should not.
 */
import { memo, useMemo } from "react";

import {
  CloudDrop,
  CloudDrops,
  CloudRain,
  CloudStorm,
  Tornado2,
} from "reicon-react";

import { PRODUCTS, type ProductKey } from "@/lib/dpc";
import { currentLut } from "@/lib/tiles";

/**
 * The marks, in rising order.
 *
 * They climb with the bands rather than each describing its own weather: one
 * drop, several, rain, a storm, a tornado. They are read as a series, which
 * is what a scale is — not as five separate forecasts. Positional, so they
 * suit any product whose legend declares five rising bands; the words that go
 * beside them come from the product, because they are the part that changes.
 */
const ICONS = [CloudDrop, CloudDrops, CloudRain, CloudStorm, Tornado2];

/**
 * @param product      Which quantity to describe. Selects both the ramp that
 *                     is sampled and the words that go beside it.
 * @param open         Drives the reveal. The panel stays mounted either way so
 *                     the transition can run in reverse on the way out.
 * @param paletteEpoch Bumped whenever the lookup table is rebuilt — on a theme
 *                     change, say. Nothing here reads it except the dependency
 *                     array, and that is its entire job: `currentLut()` is not
 *                     reactive, so without a token to change, the gradient
 *                     would keep the colours it sampled on first render.
 */
function Scale({
  place,
  product,
  open,
  paletteEpoch,
}: {
  product: ProductKey;
  open: boolean;
  /** Changes whenever the lookup table is rebuilt, so the scale resamples it. */
  paletteEpoch: number;
  /** Where it opens. Positioning belongs to the caller: the panel hangs off
   *  the button that opens it, and that button has moved once already — from
   *  the top corner to the timeline's row — so a panel that hardcodes its own
   *  corner stops following it. */
  place: string;
}) {
  const { gradient, unit, max, legend } = useMemo(() => {
    const lut = currentLut();
    const p = PRODUCTS[product];
    const stops: string[] = [];

    for (let i = 0; i <= 32; i++) {
      const byte = Math.round((i / 32) * 255);
      const o = byte * 4;
      const a = lut[o + 3] / 255;
      stops.push(
        `rgba(${lut[o]}, ${lut[o + 1]}, ${lut[o + 2]}, ${a.toFixed(3)}) ${((i / 32) * 100).toFixed(1)}%`,
      );
    }

    return {
      gradient: `linear-gradient(90deg, ${stops.join(", ")})`,
      unit: p.unit,
      max: p.srcMax,
      legend: p.legend,
    };
  }, [product, paletteEpoch]);

  return (
    /* The surface and the animation are the same element on purpose. A
       `filter` on an ancestor creates a containing block and stops
       `backdrop-filter` underneath it from sampling the page at all — even at
       blur(0), because what matters is that the property is not `none`. Split
       across two elements, the panel animated beautifully and lost its frosted
       glass; merged, it keeps both. */
    <div
      className={`dock-panel dock-surface w-64 rounded-2xl p-4 ${place}`}
      data-open={open}
      /* Closed, it is not just invisible: `inert` takes it out of the tab
         order and hides it from assistive technology, which `visibility`
         alone would do only once the transition had finished. */
      inert={!open}
      aria-hidden={!open}
    >
      <>
        <div className="text-fg text-[14px] font-medium">
          {legend.title} ({unit})
        </div>
        <p className="text-muted mt-1 text-[13px] leading-snug">{legend.blurb}</p>

        {/* Checkered behind the bar, because the low end of this palette is
            transparent and a flat backing would show it as a solid colour. */}
        <div className="legend-bar mt-3">
          <div className="h-3 w-full rounded-full" style={{ background: gradient }} />
        </div>

        <div className="text-muted numeric mt-2 flex justify-between text-[12px]">
          {legend.bands.map((b) => (
            <span key={b.at}>{b.at}</span>
          ))}
        </div>

        <div className="mt-3 space-y-1">
          {legend.bands.map((b, i) => {
            const Icon = ICONS[Math.min(ICONS.length - 1, i)];
            return (
            <div key={b.at} className="flex items-center justify-between text-[13px]">
              <span className="text-fg-soft flex items-center gap-2">
                {/* Inherits the label's colour, so the two read as one item
                    rather than as an icon with a caption beside it. */}
                <Icon size={16} aria-hidden />
                {b.label}
              </span>
              <span className="text-muted numeric">
                {b.at === max ? `${b.at}+` : `${b.at}`} {unit}
              </span>
            </div>
            );
          })}
        </div>

        <p className="text-muted mt-3 text-[13px] leading-snug">{legend.note}</p>
      </>
    </div>
  );
}

export default memo(Scale);
