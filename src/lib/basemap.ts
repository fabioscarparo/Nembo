/**
 * The basemap is CARTO's Positron and Dark Matter — the same pair mapcn ships
 * as its default, and for good reason. They are vector, free, key-less, and
 * derived from OpenStreetMap, so the coastline is accurate at every zoom
 * instead of the country-level approximation a 1:110m dataset can give. They
 * are also already the two canonical near-monochrome basemaps for data
 * visualisation, which is exactly the register this app wants: the radar
 * stays the only saturated thing on screen.
 *
 * Their palettes are used as they ship. An earlier version flattened both to
 * this app's own tokens; it made the radar easier to read but threw away the
 * thing CARTO is here for. The radar compensates instead — see the ramp in
 * globals.css, whose lower steps carry a cool cast so they separate from a
 * neutral basemap by chroma rather than by lightness alone.
 *
 * The local coastline stays as a fallback, because MapLibre does not fire
 * `load` for a style whose source never resolves — a blocked CDN would take
 * the radar down with the basemap. Corporate networks do block unknown
 * domains, so the fallback is not hypothetical.
 */

import type { StyleSpecification } from "maplibre-gl";

/** The two styles, by theme. Keyless and CORS-open; see the note above. */
const CARTO = {
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
} as const;

/** Long enough for a slow connection, short enough not to stall a page load. */
const STYLE_TIMEOUT = 5000;

/**
 * One design token off the root element, with a black fallback.
 *
 * Read at call time rather than cached: the fallback style is rebuilt on every
 * theme change, and a value captured at module load would keep the map in
 * whichever theme the page happened to start in.
 */
function token(name: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    "#000"
  );
}

/**
 * The offline basemap: country outlines from Natural Earth, baked into
 * /public by `npm run basemap`. Coarse, but it is a fallback — its job is to
 * keep the radar on screen and give it somewhere to sit.
 */
export function fallbackStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      world: { type: "geojson", data: "/coastline.geojson" },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": token("--map-water") },
      },
      {
        id: "countries-fill",
        type: "fill",
        source: "world",
        paint: { "fill-color": token("--map-land") },
      },
      {
        id: "countries-coastline",
        type: "line",
        source: "world",
        paint: { "line-color": token("--map-line"), "line-width": 1 },
      },
    ],
  };
}

/**
 * Fetches the themed CARTO style, falling back to the local one. Returning the
 * parsed style rather than its URL means the fetch that proves the CDN is
 * reachable is also the fetch that loads it — MapLibre never goes back for it.
 */
export async function resolveStyle(dark: boolean): Promise<StyleSpecification> {
  try {
    const res = await fetch(CARTO[dark ? "dark" : "light"], {
      signal: AbortSignal.timeout(STYLE_TIMEOUT),
    });
    if (res.ok) return (await res.json()) as StyleSpecification;
  } catch {
    // Blocked, offline, or too slow. The local outline is still a map.
  }
  return fallbackStyle();
}

/**
 * The id of the first symbol layer, so the radar can be inserted underneath
 * the place names. Precipitation over a city should not erase its label —
 * that is the moment you most want to know which city it is.
 */
export function firstLabelLayer(style: StyleSpecification): string | undefined {
  return style.layers.find((l) => l.type === "symbol")?.id;
}

/**
 * Returns the style with the radar's source and layer already in it.
 *
 * The radar used to be added imperatively, from the map's `style.load`
 * handler. That event is the wrong signal: MapLibre withholds it until the
 * basemap's sprite sheet and every glyph range the labels need have finished
 * downloading, none of which the radar has any use for. On a first launch —
 * cold HTTP cache, a permission prompt holding the frame, a phone on mobile
 * data — that wait is seconds long, and it is dead time in which the radar has
 * its data and cannot draw it. The observed failure was worse than slow: with
 * the page not rendering the event does not arrive at all, and the map stays
 * empty while everything behind it is ready.
 *
 * Declaring the layer in the style instead removes the question. There is no
 * event to wait for, because the layer is part of what the map is constructed
 * from.
 *
 * The source starts on a blank pixel; the first painted frame replaces it
 * through `updateImage`.
 */
export function withRadar(
  style: StyleSpecification,
  source: string,
  layer: string,
  coordinates: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ],
  blank: string,
  opacity: number,
): StyleSpecification {
  if (style.layers.some((l) => l.id === layer)) return style;

  /* Shallow-copied rather than mutated: the caller's style may be the cached
     fallback object, and a second map would then find the radar already in it
     and skip its own insertion. */
  const layers = [...style.layers];
  const before = firstLabelLayer(style);
  const at = before ? layers.findIndex((l) => l.id === before) : -1;

  const radar = {
    id: layer,
    type: "raster" as const,
    source,
    paint: {
      "raster-opacity": opacity,
      "raster-resampling": "linear" as const,
      /* MapLibre's default 300 ms cross-fade is tuned for panning between
         zooms. On a timeline it smears every frame into the next. */
      "raster-fade-duration": 0,
    },
  };

  /* Under the place names: precipitation over a city should not erase its
     label — that is the moment you most want to know which city it is. */
  if (at >= 0) layers.splice(at, 0, radar);
  else layers.push(radar);

  return {
    ...style,
    sources: {
      ...style.sources,
      [source]: { type: "image", url: blank, coordinates },
    },
    layers,
  };
}
