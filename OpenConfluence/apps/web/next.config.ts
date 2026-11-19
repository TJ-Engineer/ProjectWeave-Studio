import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: [
    "@knowledge/contracts",
    "@knowledge/database",
    "@knowledge/domain",
  ],
};

export default config;
