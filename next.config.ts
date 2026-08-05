import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Both ship platform-specific or runtime-resolved files (wasm, cmaps, .node
  // binaries) that must not be bundled. See docs/research/01-pdfjs-capabilities.md.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
};

export default nextConfig;
