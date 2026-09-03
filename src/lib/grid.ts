/**
 * The working grid, and the conversions between its pixels and the world.
 *
 * Split out of nowcast.ts so the motion worker can share it. The worker needs
 * the coarse-grid dimensions and nothing else from the radar pipeline, and
 * importing nowcast.ts to get them made the two modules import each other —
 * which Turbopack does not resolve so much as sit down in front of: the build
 * simply stopped, with no error to say why. A leaf module that neither side
 * imports back is the whole fix.
 */

/* ── Working grid ───────────────────────────────────────────
 * Zoom 7 over the DPC's Italian coverage: 1280 × 1792, about 0.9 km a pixel,
 * which is the deepest level the service publishes and therefore the radar's
 * own resolution. Anything coarser is a second, lossier copy of the
 * measurement, and next to the official viewer it reads as exactly that.
 *
 * Four times the pixels of zoom 6, which is affordable only because every
 * operation below is confined to the box that actually contains echo — on a
 * typical day a twentieth of the grid.
 */

export const Z = 7;
/** Western-most tile column of the domain, at zoom Z. */
export const X0 = 66;
/** Eastern-most. Inclusive, like all four. */
export const X1 = 70;
/** Northern-most tile row — the smaller index, because y grows south. */
export const Y0 = 44;
/** Southern-most. */
export const Y1 = 50;

/** Tiles across and down, and the pixel size that follows from them. */
export const COLS = X1 - X0 + 1;
export const ROWS = Y1 - Y0 + 1;
/** Edge of one tile in pixels, fixed by the service. */
export const TILE = 256;
/** The composite: 1280 × 1792 pixels of Italy at about 0.9 km each. */
export const W = COLS * TILE;
export const H = ROWS * TILE;

/**
 * Web Mercator tile coordinate to longitude, at the working zoom.
 *
 * Fractional `x` is meaningful and used: `lonAt(X0 + px / TILE)` converts a
 * pixel offset inside the composite, not just a tile boundary.
 */
export function lonAt(x: number): number {
  return (x / 2 ** Z) * 360 - 180;
}

/**
 * The same for latitude, which is where Mercator stops being linear — hence
 * the inverse Gudermannian rather than a scale factor. Fractional `y` is
 * meaningful here too, and latitude *decreases* as y grows: the northern edge
 * of the domain is the smaller row index.
 */
export function latAt(y: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** Z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** Corners in the order MapLibre's image source expects: TL, TR, BR, BL. */
export const COMPOSITE_BOUNDS: [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] = [
  [lonAt(X0), latAt(Y0)],
  [lonAt(X1 + 1), latAt(Y0)],
  [lonAt(X1 + 1), latAt(Y1 + 1)],
  [lonAt(X0), latAt(Y1 + 1)],
];

/**
 * The domain, as plain degrees. Exported so the steering flow can be sampled
 * over exactly the area the composite covers, rather than over a bounding box
 * someone has to keep in step with this one by hand.
 */
export const DOMAIN = {
  lon0: lonAt(X0),
  lon1: lonAt(X1 + 1),
  /* latAt grows southward, so the southern edge is the larger y. */
  lat0: latAt(Y1 + 1),
  lat1: latAt(Y0),
} as const;

/* ── Coarse grid ────────────────────────────────────────────
 * Everything that tracks motion works at an eighth of the resolution: a
 * coarse pixel is about 7 km, so a half-hour of storm travel is a handful of
 * them and both the block search and the flow pyramid stay small.
 */

export const DOWN = 8;
/** 160 × 224. Small enough that a dense flow over it is affordable. */
export const DW = W / DOWN;
export const DH = H / DOWN;

/** Below this the tile reports clear air rather than weak rain, ~5 dBZ. */
export const SIGNAL_FLOOR = 21;
