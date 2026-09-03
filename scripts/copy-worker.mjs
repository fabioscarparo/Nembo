/**
 * Puts MapLibre's worker where the browser can actually find it.
 *
 * MapLibre v6 derives its worker URL from its own module URL:
 *
 *   new URL("./maplibre-gl-worker.mjs", import.meta.url)
 *
 * Under any bundler that renames chunks — Turbopack included — that resolves
 * to /_next/static/chunks/maplibre-gl-worker.mjs, which does not exist. The
 * 404 returns Next's HTML error page, the worker fails its MIME check, and
 * every source silently never loads: no error on the map, no tiles, a canvas
 * that renders the background colour and nothing else.
 *
 * So we serve the worker ourselves and point setWorkerUrl() at it. Copied at
 * predev/prebuild rather than committed, so it can never drift from the
 * installed version of the library.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/dist/maplibre-gl.mjs"));

/* The worker imports ./maplibre-gl-shared.mjs relatively, so the two have to
   land next to each other or the worker resolves its dependency to a 404. */
const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

mkdirSync("public", { recursive: true });
for (const file of FILES) {
  copyFileSync(join(dist, file), join("public", file));
  console.log(`public/${file}`);
}
