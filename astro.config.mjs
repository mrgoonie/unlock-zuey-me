import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://unlock.zuey.me',
  output: 'server',
  // Origin checks run in src/middleware.ts so the OAuth/MCP machine endpoints can be exempted.
  security: { checkOrigin: false },
  adapter: cloudflare({
    imageService: 'passthrough',
    platformProxy: { enabled: true },
    // src/worker.ts wraps Astro's fetch handler: /mcp OAuth provider + the cron `scheduled` handler.
    workerEntryPoint: { path: 'src/worker.ts', namedExports: [] },
  }),
  integrations: [react(), tailwind({ applyBaseStyles: false })],
  vite: { ssr: { external: ['node:crypto', 'node:buffer'] } },
});
