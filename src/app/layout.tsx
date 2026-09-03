/**
 * The document: type, metadata, and the two things that must happen before the
 * first pixel is painted.
 *
 * The boot script is the interesting part. It resolves the stored theme
 * against the OS and puts the class on <html> synchronously, and here that
 * matters more than avoiding a flash of the wrong colours: the radar palette
 * is built by reading custom properties off the root element, so a late theme
 * flip would hand the first lookup table the wrong nine colours and every
 * frame drawn before the correction would be wrong.
 *
 * The preconnects are the other. Tiles come from a different origin on every
 * frame request, so the TLS handshake is paid once here rather than on the
 * path of the first tile someone is actually waiting for.
 */
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Satoshi (Indian Type Foundry, ITF Free Font License — the licence file
 * travels with the woff2, see fonts/Satoshi-LICENSE.txt). Self-hosted as a
 * single variable file: nothing is fetched from a third party at build or at
 * runtime, which also means the radar keeps its type on a flaky connection
 * where a webfont CDN would have timed out.
 */
const satoshi = localFont({
  src: "./fonts/Satoshi-Variable.woff2",
  weight: "300 900",
  style: "normal",
  display: "swap",
  variable: "--font-satoshi",
  fallback: [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "Roboto",
    "system-ui",
    "sans-serif",
  ],
});

const SITE = "https://nembo.fscarparo.com";
/* One title and one description, shared by the document head, the Open Graph
   card and the Twitter card. Three copies of the same sentence drift the
   moment one of them is edited. */
const TITLE = "Nembo — Radar Meteorologico Italiano";
const DESCRIPTION =
  "Radar meteorologico italiano essenziale e curato, con nowcasting a 30 " +
  "minuti, elaborato a partire dai dati del Dipartimento della Protezione " +
  "Civile.";

export const metadata: Metadata = {
  /* Every relative URL in this object — the social card included — is resolved
     against this, so it has to be the canonical origin and not a preview one. */
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Nembo",
  authors: [{ name: "Fabio Scarparo", url: "https://fscarparo.com" }],
  creator: "Fabio Scarparo",
  keywords: [
    "radar meteo",
    "radar Italia",
    "nowcasting",
    "previsioni pioggia",
    "Protezione Civile",
    "precipitazioni",
  ],
  /* Deployed on more than one host — a Vercel preview URL always exists — so
     the canonical says which one search engines should keep. */
  alternates: { canonical: SITE },
  openGraph: {
    type: "website",
    locale: "it_IT",
    url: SITE,
    siteName: "Nembo",
    title: TITLE,
    description: DESCRIPTION,
    /* No `images` here on purpose: `opengraph-image.png` is picked up by the
       file convention, so Next emits both `og:image` and `twitter:image`
       itself, with a content hash and the dimensions read off the file.
       Declaring them again produces a second, unhashed tag that some scrapers
       pick instead. */
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  /* Added to the home screen on iOS this runs without browser chrome, which
     suits a map that already owns the whole viewport. `black-translucent` lets
     it reach under the status bar, matching `viewportFit: "cover"` below. */
  appleWebApp: {
    capable: true,
    title: "Nembo",
    statusBarStyle: "black-translucent",
  },
};
/**
 * The map owns the whole viewport, so the browser must not offer to zoom the
 * document on top of the map's own pinch, and the surface has to reach under
 * the notch rather than stopping at a letterboxed safe area.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0c" },
  ],
};

/**
 * Runs before first paint, same contract as the portfolio's: mark the
 * document JS-capable, then apply the stored theme (system unless the visitor
 * picked one) so the colours never flash.
 *
 * It matters more here than on a text page. The radar's palette is built by
 * reading these custom properties off the root element, so a late theme flip
 * would not just repaint — it would hand the first LUT the wrong nine colours
 * and every tile drawn before the correction would be wrong.
 */
const bootScript = `
(function () {
  document.documentElement.classList.add("js");
  try {
    var stored = localStorage.getItem("theme");
    var choice = stored === "light" || stored === "dark" ? stored : "system";
    var dark =
      choice === "dark" ||
      (choice === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="it" className={satoshi.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootScript }} />
        {/* The tile bucket is a different origin on every frame request.
            Paying the TLS handshake once, up front, takes it off the path of
            the first tile the visitor actually waits for. */}
        <link
          rel="preconnect"
          href="https://s3-prod-dpc-radar-webp-cache.s3.eu-south-1.amazonaws.com"
          crossOrigin=""
        />
        <link rel="preconnect" href="https://radar-api.protezionecivile.it" />
      </head>
      <body>{children}</body>
    </html>
  );
}
