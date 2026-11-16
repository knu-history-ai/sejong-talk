import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` only. Without an entry the dev server answers /_next/hmr with a bare
  // "Unauthorized" and the page never becomes interactive (buttons do nothing).
  // - *.trycloudflare.com: Cloudflare Quick Tunnel for phone tests. Pattern only; never hardcode the temporary URL.
  // - 127.0.0.1: same machine as localhost, which is allowed by default.
  allowedDevOrigins: process.env.NODE_ENV === "development" ? ["*.trycloudflare.com", "127.0.0.1"] : undefined,
};

export default nextConfig;
