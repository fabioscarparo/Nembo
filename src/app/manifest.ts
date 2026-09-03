import type { MetadataRoute } from "next";

/**
 * The web app manifest, which is what turns the site into something a phone
 * can install rather than bookmark.
 *
 * Without this file the browser has nothing to install: Android falls back to
 * a shortcut, drops the icon into a system-drawn white backdrop and shrinks it
 * to the launcher's safe zone, and the page opens with browser chrome instead
 * of standalone. The icons below are what stop that, and `maskable` is the
 * part that matters — it promises the launcher a full-bleed square it may crop
 * to any shape, so nothing gets padded onto white.
 *
 * Kept as `.ts` rather than a static `.json` so it stays typed against
 * `MetadataRoute.Manifest`; under `output: "export"` it is evaluated once at
 * build time and emitted as a file.
 */

/* Same reason as the OG image: an export has no request-time runtime, and a
   metadata route is dynamic by default. */
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nembo — Radar Meteorologico Italiano",
    /* What fits under a home screen icon before Android truncates it. */
    short_name: "Nembo",
    description:
      "Radar meteorologico italiano essenziale e curato, con nowcasting a 30 " +
      "minuti, elaborato a partire dai dati del Dipartimento della Protezione " +
      "Civile.",
    lang: "it",
    dir: "ltr",
    start_url: "/",
    /* No browser chrome. The map already owns the viewport, and a URL bar over
       it costs a strip of the only thing on screen. */
    display: "standalone",
    /* No `theme_color` on purpose. The field holds a single colour and the
       manifest has no way to ask what the system is set to, so declaring one
       paints the installed app's bar that colour in both appearances — which
       is what put a navy bar over a white page. Omitted, the browser falls
       back to `<meta name="theme-color">`, and that one does take a `media`
       query.

       `background_color` stays: it paints the launch splash, which exists
       before the document does and so can never be theme-aware either way.
       The icon's own navy is what makes the mark sit on it as one surface. */
    background_color: "#0d2233",
    categories: ["weather", "utilities"],
    /* The same two files listed twice, under each purpose. `purpose` accepts
       a space-separated list in the spec, but `MetadataRoute.Manifest` types
       it as a single keyword, so the pair has to be spelled out.

       One file can serve both only because the artwork is a centred glow on a
       gradient: there is no mark near the edges for a launcher's crop to cut
       into. Artwork with a logo would need a distinct maskable file, padded
       into the central 80%. */
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
