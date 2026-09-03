/**
 * Steering flow, for the frames the radar cannot measure its own motion from.
 *
 * The block matcher in nowcast.ts reads the motion off the echo itself, which
 * is the right thing to do and beats any model when it works. It stops working
 * when there is not enough echo to match — and that is not a rare corner: a
 * single cell over one province is exactly the situation someone opens a radar
 * for, and it is also the situation where three independent blocks cannot
 * agree on anything. Measured on a quiet afternoon, the whole country carried
 * ninety-one echo pixels out of nine hundred and seventy-seven thousand. There
 * was nothing to match, so the forecast went to "non disponibile".
 *
 * The way out is a flow that does not come from the picture. This is what
 * 3BMeteo does — their app downloads a precomputed vector field as RGB tiles
 * and never estimates motion on the device at all — and it is why theirs is
 * always there. Their field is their own product, so this fetches an
 * equivalent from a source that is free to use: Open-Meteo's pressure-level
 * winds, no key, one request.
 *
 * ── Which level ─────────────────────────────────────────────
 *
 * Not 700 hPa, despite the old rule that storms travel with the 700 mb wind.
 * That rule is a rule of thumb about where the middle of a cloud-bearing layer
 * usually sits, and the layer moves. Measured over Italy on one ordinary
 * morning, at 46°N the 850 hPa wind was 1.1 m/s from 225° while the 500 hPa
 * wind was 14.2 m/s from 279° — nearly opposite, and thirteen times the
 * speed. Any single level is an arbitrary pick out of that profile.
 *
 * So this takes the mass-weighted mean across the cloud-bearing layer, which
 * is what operational practice actually uses (Corfidi's mean-wind vectors,
 * Bunkers' 0–6 km mean). Each level is weighted by the slab of atmosphere it
 * represents, so the answer follows the day's own profile instead of assuming
 * one.
 *
 * It remains an approximation: the honest weighting would follow where the
 * echo actually is, and shallow drizzle really does travel with the low-level
 * wind while deep convection does not. The radar products that would tell us
 * the echo top — POH and VIL — answer 403 at every tile, so that is not
 * available. The mitigation is the ordering: this flow is only ever used when
 * the radar could not measure its own, and it is labelled differently on
 * screen when it is.
 */

/** Pressure levels Open-Meteo publishes that fall in the cloud-bearing layer. */
const LEVELS = [850, 700, 600, 500] as const;

/**
 * The slab each level stands for, in hPa — the gap to the midpoint of each
 * neighbour, with the outer two closed off at half their inner gap. Weighting
 * by this rather than equally is what makes it a mean over the *air* instead
 * of a mean over whichever levels the API happens to offer.
 */
const WEIGHTS = [150, 125, 100, 100] as const;

/** Full weight of a complete profile, so a partial one can be rejected. */
const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b, 0);

/**
 * Sample points across the domain.
 *
 * Three by three rather than one: the flow over Italy is not uniform — the
 * same morning that gave 279° over the Alps gave 292° over Lazio — and one
 * request carries all nine, so the only cost of the grid is the arithmetic to
 * interpolate it.
 */
const NX = 3;
const NY = 3;

/**
 * The sampled flow, ready to interpolate. The bounds travel with it because
 * `steeringAt` needs them to place a longitude inside the grid, and a caller
 * holding the array without them could only guess.
 */
export type Steering = {
  lon0: number;
  lon1: number;
  lat0: number;
  lat1: number;
  /** Eastward and northward components in m/s, row-major from (lon0, lat0). */
  u: Float32Array;
  v: Float32Array;
};

/**
 * Meteorological direction is the direction the wind blows *from*, so both
 * components are negated to get the direction air actually travels.
 */
function components(speed: number, fromDeg: number): [number, number] {
  const r = (fromDeg * Math.PI) / 180;
  return [-speed * Math.sin(r), -speed * Math.cos(r)];
}

/**
 * The steering flow across a bounding box, or null if it cannot be had.
 *
 * Returns null rather than throwing, and every caller treats null as "no
 * fallback available" — a radar with no model wind behind it is still a
 * radar, it just goes back to saying it has no forecast.
 */
export async function fetchSteering(
  lon0: number,
  lat0: number,
  lon1: number,
  lat1: number,
  signal?: AbortSignal,
): Promise<Steering | null> {
  const lats: number[] = [];
  const lons: number[] = [];
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      lats.push(lat0 + ((lat1 - lat0) * j) / (NY - 1));
      lons.push(lon0 + ((lon1 - lon0) * i) / (NX - 1));
    }
  }

  const hourly = LEVELS.flatMap((p) => [
    `wind_speed_${p}hPa`,
    `wind_direction_${p}hPa`,
  ]).join(",");

  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lats.map((n) => n.toFixed(3)).join(",")}` +
    `&longitude=${lons.map((n) => n.toFixed(3)).join(",")}` +
    `&hourly=${hourly}` +
    /* Metres per second, so the conversion to pixels is one division by the
       Mercator scale rather than two by it and 3.6. */
    "&wind_speed_unit=ms&forecast_days=1&timezone=UTC";

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;

    const body = await res.json();
    /* One coordinate comes back as an object, several as an array. Asking for
       nine and getting one would mean the request was rewritten somewhere. */
    const points = Array.isArray(body) ? body : [body];
    if (points.length !== NX * NY) return null;

    const u = new Float32Array(NX * NY);
    const v = new Float32Array(NX * NY);

    /* Found by matching the timestamp, not by using the hour as an index.
       The two agree only as long as the response begins at midnight UTC of
       the current day, which is true of this request and is not a promise the
       API has made: add `past_days`, or have it decide to start somewhere
       else, and an index would quietly read a different hour's wind and give
       a plausible, wrong answer with nothing to show for it. */
    const wanted = new Date();
    wanted.setUTCMinutes(0, 0, 0);
    const stamp = wanted.toISOString().slice(0, 13);

    for (let k = 0; k < points.length; k++) {
      const h = points[k]?.hourly;
      if (!h) return null;

      const hour = (h.time as string[] | undefined)?.findIndex(
        (t) => t.slice(0, 13) === stamp,
      );
      if (hour === undefined || hour < 0) return null;

      let su = 0;
      let sv = 0;
      let weight = 0;

      for (let l = 0; l < LEVELS.length; l++) {
        const speed = h[`wind_speed_${LEVELS[l]}hPa`]?.[hour];
        const dir = h[`wind_direction_${LEVELS[l]}hPa`]?.[hour];
        if (typeof speed !== "number" || typeof dir !== "number") continue;
        const [cu, cv] = components(speed, dir);
        su += cu * WEIGHTS[l];
        sv += cv * WEIGHTS[l];
        weight += WEIGHTS[l];
      }

      /* A point missing most of its profile would drag the mean towards
         whichever level survived, so it is rejected rather than half-used. */
      if (weight < WEIGHT_SUM / 2) return null;
      u[k] = su / weight;
      v[k] = sv / weight;
    }

    return { lon0, lon1, lat0, lat1, u, v };
  } catch {
    return null;
  }
}

/** Bilinear across the sample grid, clamped at the edges. */
export function steeringAt(
  s: Steering,
  lon: number,
  lat: number,
): [number, number] {
  const fx = ((lon - s.lon0) / (s.lon1 - s.lon0)) * (NX - 1);
  const fy = ((lat - s.lat0) / (s.lat1 - s.lat0)) * (NY - 1);

  const cx = Math.min(NX - 1, Math.max(0, fx));
  const cy = Math.min(NY - 1, Math.max(0, fy));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(NX - 1, x0 + 1);
  const y1 = Math.min(NY - 1, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;

  const at = (arr: Float32Array) =>
    arr[y0 * NX + x0] * (1 - tx) * (1 - ty) +
    arr[y0 * NX + x1] * tx * (1 - ty) +
    arr[y1 * NX + x0] * (1 - tx) * ty +
    arr[y1 * NX + x1] * tx * ty;

  return [at(s.u), at(s.v)];
}
