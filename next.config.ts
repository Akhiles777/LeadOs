import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // На VPS (Docker) — автономная сборка; Vercel собирает по-своему.
  output: process.env.VERCEL ? undefined : "standalone",
  // Страница закладок читает исходники закладок с диска — на Vercel их нужно явно положить в функцию.
  outputFileTracingIncludes: {
    "/bookmarklet": ["./public/bookmarklet/**/*"],
  },
};

export default nextConfig;
