import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:8080';

const config: NextConfig = {
  poweredByHeader: false,
  output: 'standalone',
  // The dashboard and the API share one origin: cookies stay first-party and
  // SameSite=Lax holds, with no CORS to configure.
  rewrites: () =>
    Promise.resolve([
      { source: '/api/:path*', destination: `${API_URL}/api/:path*` },
      // The public status page is served by the API, not the dashboard: it
      // has to answer when things are going badly, which is the only time
      // anybody opens one (§18).
      { source: '/status/:slug', destination: `${API_URL}/status/:slug` },
    ]),
};

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default config;
