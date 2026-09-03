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
      {/* Two lines inside the same 44px. Sharing one line, the name and the
          reading competed for a width neither could give up: a long comune was
          cut to a third of itself while the temperature beside it sat
          untouched. Stacked, the name has the pill to itself and the reading
          sits under it in smaller type — which is also the order you read them
          in: where you are, then what it is doing there.

          The second line is what makes the description affordable on a phone.
          It used to be dropped below `sm` because it cost the most width for
          the least meaning; on a line of its own it costs the name nothing. */}
      <div className="dock-surface flex h-11 min-w-0 flex-col justify-center gap-[3px] rounded-full px-4">
        {/* The first thing to give up space, because a shortened town name is
            still the town you are in. min-w-0 is what lets a flex item shrink
            below its content at all. */}
        <span className="min-w-0 truncate text-[13px] font-medium leading-none">
          <TextMorph as="span" duration={260} respectReducedMotion className="text-fg">
            {place.name}
          </TextMorph>
        </span>
        {place.weather && (
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-none">
            {/* The temperature is refreshed every quarter of an hour, so this
                one morphs while you are looking at it — which is the moment a
                hard swap is most likely to be mistaken for a glitch. */}
            <TextMorph
              as="span"
              duration={260}
              respectReducedMotion
              className="numeric text-fg-soft shrink-0"
            >
              {`${place.weather.temperature}°`}
            </TextMorph>
            {(() => {
              const Icon = iconFor(place.weather.kind, place.weather.isDay);
              return <Icon size={13} className="text-fg-soft shrink-0" aria-hidden />;
            })()}
            <span className="min-w-0 truncate">
              <TextMorph
                as="span"
                duration={260}
                respectReducedMotion
                className="text-muted"
              >
                {place.weather.label}
              </TextMorph>
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(Pill);
