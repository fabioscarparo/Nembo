/**
 * Radar tiles, and the palette they are painted with.
 *
 * This file used to register a MapLibre protocol and hand back coloured tiles
 * for the map to place. That whole path went when frames became composites
 * built and warped here — what is left is the fetch and decode the nowcast
 * builds on, plus the lookup table it paints through.
 */

import { type Product, tileUrl } from "./dpc";

/* ── Active palette ─────────────────────────────────────────── */

let activeLut: Uint8Array = new Uint8Array(256 * 4);
let lutVersion = 0;

/** Swap the palette. Frames already on screen need a repaint to pick it up. */
export function setLut(lut: Uint8Array): void {
  activeLut = lut;
  lutVersion += 1;
}

/**
 * Bumped on every swap, so anything that derives from the palette can tell
 * that it has to look again.
 *
 * The legend learned this the hard way: it samples the table to draw its
 * scale, and once it stopped being mounted on demand it was sampling during
 * the first render — before the effect that fills the table had run. Two
 * hundred and fifty-six zeroes make a perfectly transparent gradient, which
 * looks exactly like a missing element.
 */
export function lutEpoch(): number {
  return lutVersion;
}

/** The palette currently in effect, for renderers outside this module. */
export function currentLut(): Uint8Array {
  return activeLut;
}

/**
 * One decoded tile. `red` carries the value — see decodeValue in dpc.ts — and
 * `mask` is the no-data channel flattened to 0 or 255. Green and blue are
 * dropped on the way in: WebP subsamples chroma, so reading them would be
 * reading compression noise.
 */
export type Tile = { red: Uint8Array; mask: Uint8Array; w: number; h: number };

/* ── Fetching ───────────────────────────────────────────────── */

/**
 * Coordinates the service has refused, so they are asked for once per session
 * rather than once per observation.
 *
 * The transcribed coverage in dpc.ts is the DPC's own declaration and it is
 * optimistic: 6/35/25 is listed and answers 403 anyway. Nothing can stop a
 * browser logging a failed request, so the only way to a quiet console is to
 * stop making the request.
 *
 * But a refusal does not, on its own, say *what* was refused. The bucket
 * denies listing, so 403 is the answer both to "this tile is outside the
 * radar footprint" and to "this instant is not published yet" — a frame a
 * few minutes ahead of publication answers 403 at every coordinate in the
 * country. Concluding geometry from one refusal therefore risks blacklisting
 * the entire footprint on a single early poll, and the radar then stays
 * blank for the rest of the session with nothing on screen to explain it.
 *
 * The two cases separate over time: a coordinate outside the footprint is
 * refused at *every* instant, an unpublished instant refuses at *every*
 * coordinate. So a first refusal is only remembered, with the instant that
 * produced it; a second refusal at a *different* instant is what concludes
 * the tile is not there. Geometry is confirmed on the next observation,
 * while a frame that was merely early costs one extra request and recovers.
 *
 * Keyed by product as well: the coverage sets in dpc.ts differ per product,
 * so what VMI does not publish says nothing about SRI.
 */
const missing = new Set<string>();

/** First unexplained refusal per coordinate, and when it was asked for. */
const refusedOnce = new Map<string, number>();

/**
 * Records a refusal and reports whether the coordinate is now believed
 * absent. Transient failures never get here — see the status check below.
 */
function refuse(key: string, time: number): void {
  const first = refusedOnce.get(key);
  if (first === undefined) {
    refusedOnce.set(key, time);
    return;
  }
  if (first !== time) {
    missing.add(key);
    refusedOnce.delete(key);
  }
}

/**
 * One tile, decoded to its value and no-data channels. Exported because the
 * nowcast builds its composites from exactly these pixels — reading the same
 * bytes twice through two different decoders is how the forecast and the
 * observation quietly stop agreeing with each other.
 *
 * Returns null for anything that is not there. The bucket denies listing, so
 * a frame that was never published answers 403 rather than 404; either way
 * there is nothing to draw, and throwing would only fill the console for
 * tiles that are legitimately absent — the open sea, or a radar that was down.
 */
export async function fetchTile(
  product: Product,
  time: number,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<Tile | null> {
  const coord = `${product.key}/${z}/${x}/${y}`;
  if (missing.has(coord)) return null;

  let bitmap: ImageBitmap;
  try {
    const res = await fetch(tileUrl(product, time, z, x, y), { signal });
    if (!res.ok) {
      /* Only an absence is worth remembering. A 5xx or a 429 is the service
         having a bad moment, and treating it as geometry would punch a
         permanent hole in the radar over whichever region happened to be
         mid-request — for the rest of the session, recoverable only by a
         reload. Those are simply retried on the next observation. */
      if (res.status === 403 || res.status === 404) {
        /* The frame, not the raw millisecond: tileUrl floors to the product
           cadence, so two unaligned instants can name one tile and would
           otherwise look like the two independent refusals this needs. */
        const step = product.stepMinutes * 60_000;
        refuse(coord, Math.floor(time / step) * step);
      }
      return null;
    }
    bitmap = await createImageBitmap(await res.blob());
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }

  const { width: w, height: h } = bitmap;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    // The bitmap is already decoded; leaving by this door still has to free it.
    bitmap.close();
    return null;
  }

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const src = ctx.getImageData(0, 0, w, h).data;

  /* Red only. WebP subsamples chroma, so green and blue drift a little from
     the value that was encoded — reading them would be reading compression
     noise. The DPC's own shader takes rgba.r for the same reason. */
  const red = new Uint8Array(w * h);
  const mask = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < red.length; i++, o += 4) {
    red[i] = src[o];
    mask[i] = src[o + 3] > 2 ? 255 : 0;
  }

  return { red, mask, w, h };
}
