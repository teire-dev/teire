import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import("next").NextConfig} */
const nextConfig = {
  cacheComponents: true,
  devIndicators: false,
  partialPrefetching: true,
  reactCompiler: true,
  transpilePackages: ["@teire/db", "@teire/engine"],
  /** Short URLs: /demo is the hackathon video; the docs sections live under their tabs. */
  async redirects() {
    return [
      { source: "/demo", destination: "https://youtu.be/s3VyWZnEVqc", permanent: false },
      { source: "/docs", destination: "/docs/guide", permanent: false },
      { source: "/docs/cli", destination: "/docs/build/cli", permanent: false },
      { source: "/docs/mcp", destination: "/docs/build/mcp", permanent: false },
      { source: "/docs/config", destination: "/docs/guide/configuration", permanent: false },
    ];
  },
};

export default withMDX(nextConfig);
