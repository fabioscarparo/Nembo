/**
 * Where you are, and what it is doing there.
 *
 * Both lookups happen in the browser, because a static export has no server
 * to hide behind — the portfolio fetches its weather server-side precisely so
 * a visitor never talks to a third party, and that option is not available
 * here. What is available is sending less: coordinates are rounded to two
 * decimals, about a kilometre, before they leave. A town name and the
 * temperature do not need to know which street you are on.
 */

/** The same grouping the portfolio's footer uses, so the two projects
 *  describe the sky with one vocabulary. */
export type WeatherKind =
  | "clear"
  | "partly"
  | "cloud"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "storm";

/** Conditions reduced to what the pill can show: a number, a word, a mark,
 *  and whether it is day — which only the first two of those care about. */
export type Weather = {
  temperature: number;
  label: string;
  kind: WeatherKind;
  isDay: boolean;
};

/** A named place, with conditions when they could be had. The name is
 *  required and the weather is not: somewhere with no reading is still
 *  somewhere, but a reading with nowhere to attach it is not worth a pill. */
export type Place = {
  name: string;
  weather: Weather | null;
};

/** A kilometre of precision: enough to name a town, too coarse to locate a
 *  person. */
function blur(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * WMO 4677 codes, grouped down to the words worth showing and the mark that
 * goes with them.
 *
 * The kind is kept separate from the label rather than picking an icon here:
 * this module has no business importing React, and the same grouping then
 * serves both the word and the glyph without either drifting from the other.
 */
function describe(code: number): { label: string; kind: WeatherKind } {
  if (code === 0) return { label: "Sereno", kind: "clear" };
  if (code <= 2) return { label: "Poco nuvoloso", kind: "partly" };
  if (code === 3) return { label: "Coperto", kind: "cloud" };
  if (code <= 48) return { label: "Nebbia", kind: "fog" };
  if (code <= 57) return { label: "Pioviggine", kind: "drizzle" };
  if (code <= 67) return { label: "Pioggia", kind: "rain" };
  if (code <= 77) return { label: "Neve", kind: "snow" };
  if (code <= 82) return { label: "Rovesci", kind: "rain" };
  if (code <= 86) return { label: "Rovesci di neve", kind: "snow" };
  return { label: "Temporale", kind: "storm" };
}

/**
 * Current conditions from Open-Meteo, or null if they cannot be had.
 *
 * Coordinates arrive already blurred — see `blur` and its caller. Null is a
 * normal outcome and not an error: the pill drops to just a place name, which
 * is still worth showing.
 */
async function fetchWeather(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<Weather | null> {
  try {
    const url =
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${lat}&longitude=${lon}` +
      "&current=temperature_2m,weather_code,is_day&timezone=auto";
    const res = await fetch(url, { signal });
    if (!res.ok) return null;

    const current = (await res.json())?.current;
    if (typeof current?.temperature_2m !== "number") return null;

    return {
      temperature: Math.round(current.temperature_2m),
      isDay: current.is_day === 1,
      ...describe(Number(current.weather_code)),
    };
  } catch {
    return null;
  }
}

/**
 * The nearest named place. BigDataCloud's client endpoint is built to be
 * called from a browser and needs no key; Nominatim would be the obvious
 * alternative but its terms ask for a descriptive User-Agent, which a page
 * cannot set, so using it from here would be using it against its rules.
 */
async function fetchName(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const url =
      "https://api.bigdatacloud.net/data/reverse-geocode-client" +
      `?latitude=${lat}&longitude=${lon}&localityLanguage=it`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;

    const j = await res.json();
    return j.city || j.locality || j.principalSubdivision || null;
  } catch {
    return null;
  }
}

/**
 * Both together. Returns null only when the place cannot be named at all —
 * weather alone, with nowhere to attach it, is not worth a pill.
 */
export async function lookupPlace(
  lon: number,
  lat: number,
  signal?: AbortSignal,
): Promise<Place | null> {
  const y = blur(lat);
  const x = blur(lon);

  const [name, weather] = await Promise.all([
    fetchName(y, x, signal),
    fetchWeather(y, x, signal),
  ]);

  return name ? { name, weather } : null;
}
