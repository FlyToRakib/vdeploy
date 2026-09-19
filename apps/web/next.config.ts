import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:8080';

const config: NextConfig = {
  poweredByHeader: false,
  output: 'standalone',
  // The dashboard and the API share one origin: cookies stay first-party and
  // SameSite=Lax holds, with no CORS to configure.
  rewrites: () =>
    Promise.resolve([{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }]),
};

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default config;
