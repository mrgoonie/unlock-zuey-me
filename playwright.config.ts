import { defineConfig, devices } from '@playwright/test';

/**
 * Production E2E suite. Targets the deployed site by default; set E2E_BASE_URL to point elsewhere.
 * Each run creates guest learners and triggers real AI grading, so keep the number of runs small.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'https://unlock.zuey.me';

export default defineConfig({
  testDir: './e2e',
  // AI grading can take a minute or more, so one test covers the whole mission flow with headroom.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 1,
  // Dot-directories keep run artifacts (traces, the HTML bundle) out of `astro check`, which type-checks
  // every .js file in the project.
  outputDir: '.e2e/results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '.e2e/report' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
