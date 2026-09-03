import { ImageResponse } from "next/og";

/**
 * The card that appears when a link to Nembo is shared.
 *
 * Generated at build time rather than committed as a PNG, so it cannot drift
 * from the wording in `layout.tsx` — the two read the same strings. Under
 * `output: "export"` this route is rendered once during `next build` and
 * emitted as a static file; nothing runs at request time.
 *
 * Satori, which backs ImageResponse, supports only a subset of CSS: no
 * `gap`, no shorthand `background`, and every element that has more than one
 * child needs an explicit `display: flex`. Layout that looks wrong here is
 * usually one of those three rather than a mistake in the values.
 */

/* Required under `output: "export"`. An image route is dynamic by default, and
   a static export has no request-time runtime to render it — the build refuses
   outright rather than silently shipping a broken URL. */
export const dynamic = "force-static";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Nembo — Radar Meteorologico Italiano";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          /* The icon's own palette: deep navy at the edges lifting to a pale
             centre, which is what the mark itself does. */
          backgroundColor: "#0d2233",
          backgroundImage:
            "radial-gradient(circle at 72% 38%, #6f9ab5 0%, #2c536f 34%, #0d2233 68%)",
          color: "#ffffff",
        }}
      >
        <div
          style={{
            fontSize: 132,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1,
          }}
        >
          Nembo
        </div>

        <div
          style={{
            marginTop: 28,
            fontSize: 42,
            lineHeight: 1.3,
            color: "rgba(255, 255, 255, 0.82)",
            maxWidth: 900,
          }}
        >
          Radar meteorologico italiano con nowcasting a 30 minuti
        </div>

        <div
          style={{
            marginTop: 44,
            fontSize: 28,
            color: "rgba(255, 255, 255, 0.55)",
          }}
        >
          Dati del Dipartimento della Protezione Civile
        </div>
      </div>
    ),
    size,
  );
}
