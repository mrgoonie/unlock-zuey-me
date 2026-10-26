import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForHydration } from './helpers/wait-for-hydration';

/**
 * Done-means #2: a fresh guest on a phone viewport completes the plan-weekend mission end to end, the real
 * AI grader scores the answers, and the results screen shows criterion scores, XP and the first badge.
 *
 * The answers below are authored to satisfy every rubric criterion in content/missions/plan-weekend.yaml.
 * The pasted "AI answer" is authored text in the shape the mission asks for, not a live transcript.
 */

const MISSION_PAGE = '/missions/plan-weekend';

const ANSWERS = {
  goal: 'Nghỉ ngơi ở nhà nhưng vẫn ra ngoài đi bộ một chút và có một bữa ăn ngon cùng gia đình.',
  constraints: [
    'Ngân sách dưới 500k cho cả hai ngày',
    'Thứ Bảy chồng làm đến 12h nên chỉ đi từ 13h',
    'Phải về nhà trước 18h Chủ Nhật',
    'Đi cùng bé 5 tuổi, cần nghỉ trưa và tránh đường dốc',
  ],
  location: 'Quận 7, TP.HCM',
  aiAnswer: [
    'Lịch cuối tuần (ước tính chi phí, cần kiểm tra lại giờ mở cửa):',
    '',
    'Thứ Bảy',
    '08:00 - 09:00: Ăn sáng ở nhà, khoảng 40.000đ cho cả nhà.',
    '09:00 - 11:30: Nghỉ ngơi, bé xem phim hoạt hình, mẹ đọc sách.',
    '11:30 - 12:30: Chuẩn bị đồ, chờ bố làm xong.',
    '13:00 - 15:00: Đi công viên gần nhà bằng xe, đi bộ nhẹ, không dốc. Chi phí 0đ.',
    '15:00 - 16:00: Uống nước mía, khoảng 30.000đ cho 3 người.',
    '16:00 - 17:30: Cả nhà nấu bữa tối đơn giản ở nhà, khoảng 150.000đ.',
    '',
    'Chủ Nhật',
    '08:00 - 09:30: Ăn sáng, đi chợ gần nhà, khoảng 120.000đ.',
    '10:00 - 11:30: Chơi ở sân nhỏ hoặc thư viện thiếu nhi gần nhà (kiểm tra giờ mở cửa trước).',
    '11:30 - 13:00: Ăn trưa, nghỉ trưa cho bé ngủ 1 tiếng.',
    '14:00 - 16:30: Đi bộ quanh khu phố, tổng chi phí dự kiến dưới 500.000đ cho cả hai ngày.',
    '16:30 - 17:30: Chuẩn bị về, đảm bảo có mặt ở nhà trước 18h.',
  ].join('\n'),
  verdicts: {
    'claim-hours': 'Cần tra cứu',
    'claim-walk': 'Tin có căn cứ',
    'claim-price': 'Cần tra cứu',
    'claim-weather': 'Không đủ dữ liệu',
  } as Record<string, string>,
  checkNotes:
    'Mình đã mở Google Maps kiểm tra công viên trong lịch: AI ghi là mở cửa từ 6h nhưng trang của Google Maps ghi 5h30, nên mình chỉnh lại giờ đi. Mình cũng gọi thử về giá vé trong lịch, nhân viên báo giá khác với AI nói.',
  change: 'Nếu Chủ Nhật trời mưa thì sao? Vẫn giữ ngân sách 500k và về nhà trước 18h.',
  revised:
    'AI đổi hoạt động ngoài trời thành đi chợ trong nhà và chơi ở thư viện thiếu nhi, giữ nguyên ngân sách và giờ về nhà. Mình thấy hợp lý vì vẫn đủ việc cho bé, nhưng giờ mở cửa của thư viện mình phải tự tra lại.',
  lesson:
    'Lần sau mình sẽ ghi ngân sách và giờ về ngay từ đầu, và hỏi AI chỗ nào cần mình tự kiểm tra lại. Mình cũng sẽ tra giờ mở cửa trước khi chốt lịch.',
};

const CRITERIA_COUNT = 6;
const RESULT_OR_STOP = '[data-testid="results"], [data-testid="needs-revision"], [data-testid="evaluation-failed"]';

// The first step waits longer: opening a fresh guest's run can stall for several seconds on a cold worker.
async function expectStep(page: Page, stepId: string) {
  await expect(page.getByTestId('runner-step')).toHaveAttribute('data-step-id', stepId, { timeout: 45_000 });
}

async function next(page: Page) {
  await page.getByTestId('runner-next').click();
}

/** Moves on only after the autosave indicator reads "Đã lưu", as a learner would before tapping "Tiếp tục". */
async function nextAfterSave(page: Page) {
  await waitForSaved(page);
  await next(page);
}

/** Clicks the verdict radio whose accessible name contains the label, inside the claim's fieldset. */
async function chooseVerdict(page: Page, claimId: string, label: string) {
  await page.getByTestId(`claim-${claimId}`).getByRole('radio', { name: label }).check();
}

async function fillConstraintRows(page: Page, items: string[]) {
  const list = page.getByTestId('field-constraints');
  for (let i = 0; i < items.length; i++) {
    if (i >= 3) await list.getByRole('button', { name: 'Thêm dòng' }).click();
    await list.getByRole('textbox').nth(i).fill(items[i]);
  }
}

async function waitForSaved(page: Page) {
  await expect(page.getByTestId('save-state')).toContainText('Đã lưu', { timeout: 15_000 });
}

/** Visible text of a grading outcome view, so a failed test prints the grader's per-criterion feedback. */
async function outcomeText(locator: Locator): Promise<string> {
  return (await locator.innerText()).replace(/\n{2,}/g, '\n');
}

test('guest completes plan-weekend on a phone viewport and earns XP and a badge', async ({ page }) => {
  // Onboarding: a fresh guest lands on /start, skips the questions and reaches /home.
  await page.goto('/');
  await page.getByRole('link', { name: 'Bắt đầu ngay, không cần đăng nhập' }).click();
  await page.waitForURL('**/start');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Bỏ qua' }).click();
  await page.waitForURL('**/home');

  await page.goto(MISSION_PAGE);
  await page.getByTestId('mission-start').click();
  await page.waitForURL('**/missions/plan-weekend/run');

  // Step 1: intro.
  await expectStep(page, 'intro');
  await next(page);

  // Step 2: constraints. Fill, wait for autosave, reload, and check the answers came back.
  await expectStep(page, 'constraints');
  await page.getByTestId('field-goal').fill(ANSWERS.goal);
  await fillConstraintRows(page, ANSWERS.constraints);
  await waitForSaved(page);
  await page.reload();
  await expectStep(page, 'constraints');
  await expect(page.getByTestId('field-goal')).toHaveValue(ANSWERS.goal);
  await expect(page.getByTestId('field-constraints').getByRole('textbox').nth(3)).toHaveValue(ANSWERS.constraints[3]);
  await page.getByTestId('field-location').fill(ANSWERS.location);
  await nextAfterSave(page);

  // Step 3: ask the AI. Paste the answer the learner got back.
  await expectStep(page, 'ask-ai');
  await page.getByTestId('field-ai_answer').fill(ANSWERS.aiAnswer);
  await nextAfterSave(page);

  // Step 4: verification. One verdict per claim, then notes on what was checked.
  await expectStep(page, 'verify');
  for (const [claimId, label] of Object.entries(ANSWERS.verdicts)) {
    await chooseVerdict(page, claimId, label);
  }
  await page.getByTestId('field-check_notes').fill(ANSWERS.checkNotes);
  await nextAfterSave(page);

  // Step 5: adjust one condition.
  await expectStep(page, 'adjust');
  await page.getByTestId('field-change').fill(ANSWERS.change);
  await page.getByTestId('field-revised').fill(ANSWERS.revised);
  await nextAfterSave(page);

  // Step 6: reflection.
  await expectStep(page, 'reflect');
  await page.getByTestId('field-lesson').fill(ANSWERS.lesson);
  await nextAfterSave(page);

  // Review and submit. Confidence starts at 50, move it to 60 with the keyboard.
  await expect(page.getByTestId('submit-review')).toBeVisible();
  const confidence = page.getByTestId('self-confidence');
  await confidence.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(confidence).toHaveValue('60');
  await waitForSaved(page);
  await page.getByTestId('submit-evidence').click();

  // Grading is asynchronous. Wait for a terminal state.
  await expect(page.locator(RESULT_OR_STOP).first()).toBeVisible({ timeout: 150_000 });

  // A needs_revision outcome fails the test with the grader's feedback. The test never retries the grade.
  if (await page.getByTestId('needs-revision').isVisible()) {
    throw new Error(`Grader returned needs_revision.\n${await outcomeText(page.getByTestId('needs-revision'))}`);
  }
  if (await page.getByTestId('evaluation-failed').isVisible()) {
    throw new Error(`Grading failed (evaluation_failed): ${await outcomeText(page.getByTestId('evaluation-failed'))}`);
  }

  // Passed results.
  const results = page.getByTestId('results');
  await expect(results).toBeVisible();
  await expect(results.getByRole('heading', { name: /Mission hoàn thành/ })).toBeVisible();
  await expect(page.getByTestId('result-score')).toBeVisible();
  await expect(page.getByTestId('criterion-score')).toHaveCount(CRITERIA_COUNT);
  await expect(page.getByTestId('xp-gained')).toHaveText(/\+\s*[1-9]\d*\s*XP/, { timeout: 15_000 });
  await expect(page.getByTestId('badge-first-verified-win')).toBeVisible();
});
