import type { NextConfig } from "next";

/**
 * A static export, because there is nothing for a server to do. Both upstream
 * hosts are CORS-open (see lib/dpc.ts), so every request the app makes goes
 * straight from the visitor's browser to the Protezione Civile — no proxy, no
 * route handler, no runtime to keep warm or pay for. `next build` emits plain
 * files that any static host will serve.
 */
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  devIndicators: false,
  images: { unoptimized: true },
};

export default nextConfig;
