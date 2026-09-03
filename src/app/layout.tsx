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

export const metadata: Metadata = {
  metadataBase: new URL("https://radar.fscarparo.com"),
  title: "Nembo",
  description:
    "Radar meteorologico italiano, dati del Dipartimento della Protezione Civile.",
  openGraph: {
    title: "Nembo",
    description:
      "Radar meteorologico italiano, dati del Dipartimento della Protezione Civile.",
    url: "https://radar.fscarparo.com",
    siteName: "Nembo",
    type: "website",
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
