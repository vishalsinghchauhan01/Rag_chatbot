import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow long-running API calls for AI streaming responses
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
