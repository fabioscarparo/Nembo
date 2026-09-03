"use client";

/**
 * Where you are, and the part of the weather that is not falling.
 *
 * It says what the radar cannot. Reflectivity is precipitation aloft; "22°,
 * sereno" is everything else, and on a dry day it is the only thing on screen
 * with anything to report.
 *
 * It does not position itself. Both pills used to be absolute at their own
 * corner, which meant nothing stopped them meeting in the middle — and on a
 * phone they did: measured at 375px, "Bologna · 22° Sereno" beside the dock
 * overflowed by 33 pixels, and "Sesto San Giovanni · Rovesci di neve" by 146.
 * They share one flex row now, so the overlap is not tuned away but
 * unrepresentable, and this pill gives up space in a deliberate order — the
 * weather word first, because the icon beside it already says that, then the
 * town name by truncation.
 */
import { memo } from "react";
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudRain,
  CloudSnow,
  CloudStorm,
  CloudSun,
  Moon,
  MoonCloud,
  Sun,
} from "reicon-react";
import { TextMorph } from "torph/react";

import type { Place, WeatherKind } from "@/lib/place";

/**
 * The mark for each grouping. Clear and partly cloudy take the hour into
 * account because a sun at midnight is simply wrong; the rest do not, since
 * rain looks the same in the dark.
 */
function iconFor(kind: WeatherKind, isDay: boolean) {
  switch (kind) {
    case "clear":
      return isDay ? Sun : Moon;
    case "partly":
      return isDay ? CloudSun : MoonCloud;
    case "cloud":
      return Cloud;
    case "fog":
      return CloudFog;
    case "drizzle":
      return CloudDrizzle;
    case "rain":
      return CloudRain;
    case "snow":
      return CloudSnow;
    case "storm":
      return CloudStorm;
  }
}

/**
 * Renders nothing at all without a place — not an empty pill, not a spinner.
 * Most of the time there is no location fix, and a permanent placeholder for
 * something that may never arrive is worse than the space it would occupy.
 *
 * Same surface and height as the dock opposite, so the two read as a pair
 * holding that edge rather than as two unrelated boxes.
 */
function Pill({ place }: { place: Place | null }) {
  if (!place) return null;

  return (
    <div className="pointer-events-auto min-w-0">
      <div className="dock-surface flex h-8 min-w-0 items-center gap-2 rounded-full px-3 text-[13px] font-medium">
        {/* The first thing to give up space, because a shortened town name is
            still the town you are in. min-w-0 is what lets a flex item shrink
            below its content at all. */}
        <span className="min-w-0 truncate">
          <TextMorph as="span" duration={260} respectReducedMotion className="text-fg">
            {place.name}
          </TextMorph>
        </span>
        {place.weather && (
          <>
            <span className="text-muted shrink-0">·</span>
            {/* The temperature is refreshed every quarter of an hour, so this
                one morphs while you are looking at it — which is the moment a
                hard swap is most likely to be mistaken for a glitch. */}
            <TextMorph
              as="span"
              duration={260}
              respectReducedMotion
              className="numeric text-fg-soft"
            >
              {`${place.weather.temperature}°`}
            </TextMorph>
            {(() => {
              const Icon = iconFor(place.weather.kind, place.weather.isDay);
              return (
                <Icon size={15} className="text-fg-soft shrink-0" aria-hidden />
              );
            })()}
            {/* Dropped on a narrow screen before anything else is: the icon
                beside it already says "sereno", so it is the one element here
                that costs width without adding meaning. */}
            <span className="hidden shrink-0 sm:inline">
              <TextMorph
                as="span"
                duration={260}
                respectReducedMotion
                className="text-muted"
              >
                {place.weather.label}
              </TextMorph>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export default memo(Pill);
