import { expect, type Page } from '@playwright/test';

/**
 * Waits until every client:load React island on the page has hydrated. Astro removes the `ssr` attribute
 * from an island once its JavaScript has attached event handlers. Until then, a click on a server-rendered
 * button does nothing, so tests call this before interacting with such a page.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await expect(page.locator('astro-island[client="load"][ssr]')).toHaveCount(0);
}
