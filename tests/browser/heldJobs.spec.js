import { test, expect } from '@playwright/test';

// Application assessment 2026-10-29 C06 (and C05's withdrawal) at the page: with more held jobs than one page, the
// count is the server's, the oldest held job is reachable and can be acted on, and withdrawing it updates every count.
test('C06: nine held jobs are all reachable, counted by the server, and the oldest can be withdrawn', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ts_lang', 'zh'));
  await page.goto('/#/mint');
  await expect(page.locator('#ebl-browse-btn')).toBeEnabled();
  const submitted = await page.evaluate(async () => {
    const copy = await (await fetch('/api/agent/workspace/copies/CASE-EBL-CU-SIN-SHA')).json();
    const ids = [];
    for (let i = 1; i <= 9; i += 1) {
      const response = await fetch('/api/agent/ingest?wait=1', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ case_id: copy.case_id, documents: [{ name: `synthetic-held-${i}.txt`, mime_type: 'text/plain',
          text: `Synthetic browser check, no real shipment. Revision ${i}. No invoice or insurance supplied.` }] }) });
      ids.push((await response.json()).job.job_id);
    }
    return ids;
  });
  await page.reload();
  const documents = page.locator('.documents');
  await expect(page.locator('#mint-start-review')).toHaveText('继续待复核任务（9）');
  await expect(page.locator('#ebl-jobs-summary')).toContainText('共 9 个任务，其中 9 个等待提交更正');
  await expect(documents.locator('.job-review button')).toHaveCount(8);
  const oldest = documents.locator(`[data-job-id="${submitted[0]}"]`);
  await expect(oldest).toHaveCount(0);

  await page.locator('#ebl-jobs-more').click();
  await expect(oldest).toBeVisible();
  await expect(documents.locator('.job-review button')).toHaveCount(9);
  await expect(page.locator('#ebl-jobs-more')).toHaveCount(0);

  await oldest.locator('.job-withdraw-open').click();
  await oldest.locator('.job-withdraw-yes').click();
  await expect(oldest).toContainText('已撤回');
  await expect(oldest.locator('.job-review button')).toHaveCount(0);
  await expect(page.locator('#mint-start-review')).toHaveText('继续待复核任务（8）');
  await expect(page.locator('#ebl-jobs-summary')).toContainText('其中 8 个等待提交更正');
});
