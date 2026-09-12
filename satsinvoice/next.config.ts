import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @react-pdf/renderer is CJS with native-ish internals; let Node require it
  // directly instead of bundling it into the server build.
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default nextConfig;
