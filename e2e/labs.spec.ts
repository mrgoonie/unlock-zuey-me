import { expect, test } from '@playwright/test';
import { waitForHydration } from './helpers/wait-for-hydration';

test('hallucination detective lab is recorded as done on mobile', async ({ page }) => {
  await page.goto('/labs/hallucination-detective');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Bắt đầu thôi' }).click();

  // Classify each claim with the first verdict, then advance. The score is not asserted here: the point
  // is that finishing the lab records its result. Labs never grant XP, so no reward check either.
  const verdicts = page.getByRole('group', { name: 'Phân loại câu trả lời' });
  const advance = page.getByRole('button', { name: /Câu tiếp theo|Vụ tiếp theo|Xem kết quả/ });
  const finish = page.getByRole('button', { name: 'Xem kết quả' });

  for (let claim = 0; claim < 40; claim++) {
    await verdicts.getByRole('button').first().click();
    if (await finish.isVisible()) {
      const recorded = page.waitForResponse((res) =>
        res.url().includes('/api/v1/labs/hallucination-detective/result') && res.request().method() === 'POST');
      await finish.click();
      const response = await recorded;
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { labsDone: string[] };
      expect(body.labsDone).toContain('hallucination-detective');
      await expect(page.getByText('Đã lưu vào tiến độ của bạn.')).toBeVisible();
      return;
    }
    await advance.click();
  }
  throw new Error('Hallucination detective did not reach its result screen');
});
