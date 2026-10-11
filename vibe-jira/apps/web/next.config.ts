import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@vibe/contracts", "@vibe/domain", "@vibe/database"],
};

export default nextConfig;
