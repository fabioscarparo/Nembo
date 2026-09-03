import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/* Satori resolves no network requests and no bundler aliases, so the mark has
   to arrive as bytes. Read from the source tree at build time and inlined,
   which also keeps the card a single self-contained file. `assets/` holds the
   512px original; `src/app/icon.png` is half that and would soften at the size
   drawn below. */
const MARK = readFileSync(join(process.cwd(), "assets", "nembo.png"));
const MARK_SRC = `data:image/png;base64,${MARK.toString("base64")}`;

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
          /* Deliberately close to flat. The mark is itself a soft radial glow,
             so the radial gradient this card used to carry would have put a
             glow on a glow and dissolved the icon's edges into the background.
             A dark, directional wash leaves the mark as the only light source. */
          backgroundColor: "#0d2233",
          backgroundImage: "linear-gradient(160deg, #143349 0%, #0a1826 100%)",
          color: "#ffffff",
        }}
      >
        <img
          src={MARK_SRC}
          width={132}
          height={132}
          alt=""
          style={{ marginBottom: 36 }}
        />

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
            /* Narrower than the text needs, to force the break after
               "italiano". Left to the full column the line wraps one word
               short of the edge and orphans "minuti" on its own row. */
            maxWidth: 640,
          }}
        >
          Radar meteorologico italiano con nowcasting a 30 minuti
        </div>
      </div>
    ),
    size,
  );
}
