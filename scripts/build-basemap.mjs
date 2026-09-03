/**
 * Bakes the basemap into the repo.
 *
 * Nembo draws two things: coastlines and the radar. Pulling the first from
 * someone else's tile CDN means the map — and, because MapLibre will not fire
 * `load` for a style whose source never resolves, the radar with it — depends
 * on a host we do not control and that corporate networks routinely block.
 *
 * Natural Earth 110m is public domain and, once the properties are dropped and
 * the coordinates rounded, small enough to serve as a single GeoJSON. At the
 * zooms this app reaches (3 to 7) the difference from a vector tile pyramid is
 * invisible.
 *
 *   node scripts/build-basemap.mjs
 */

import { writeFileSync } from "node:fs";

const SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";

/** Europe and the Mediterranean: the radar's neighbourhood, plus context. */
const VIEW = { west: -14, south: 26, east: 38, north: 62 };

/** 2 decimals ≈ 1.1 km. The radar's own cells are 1 km, so this is its equal. */
const PRECISION = 2;

const round = (n) => Number(n.toFixed(PRECISION));

function roundRing(ring) {
  const out = [];
  for (const [lon, lat] of ring) {
    const p = [round(lon), round(lat)];
    // Rounding collapses neighbouring vertices; keeping them would triple the
    // file for points that land on the same pixel.
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  // A ring needs four positions to close; anything less rounded itself away.
  return out.length >= 4 ? out : null;
}

function roundGeometry(geom) {
  if (geom.type === "Polygon") {
    const rings = geom.coordinates.map(roundRing).filter(Boolean);
    return rings.length ? { type: "Polygon", coordinates: rings } : null;
  }
  if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates
      .map((poly) => poly.map(roundRing).filter(Boolean))
      .filter((poly) => poly.length > 0);
    return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
  }
  return null;
}

function intersectsView(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    for (const [lon, lat] of poly[0]) {
      if (
        lon >= VIEW.west &&
        lon <= VIEW.east &&
        lat >= VIEW.south &&
        lat <= VIEW.north
      ) {
        return true;
      }
    }
  }
  return false;
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`Natural Earth: HTTP ${res.status}`);
const world = await res.json();

const features = [];
for (const f of world.features) {
  if (!f.geometry || !intersectsView(f.geometry)) continue;
  const geometry = roundGeometry(f.geometry);
  if (!geometry) continue;
  /* No properties at all. Nothing in this app styles by country or labels
     one, so every byte of attribute data would be shipped to be ignored. */
  features.push({ type: "Feature", properties: {}, geometry });
}

const out = { type: "FeatureCollection", features };
writeFileSync("public/coastline.geojson", JSON.stringify(out));

const kb = (JSON.stringify(out).length / 1024).toFixed(1);
console.log(`public/coastline.geojson — ${features.length} paesi, ${kb} kB`);
