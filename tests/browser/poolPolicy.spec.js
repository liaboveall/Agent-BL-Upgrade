import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Comprehensive review 2026-10-29 (v4) F04/F05 at the page: a screening whose signer lost COMPLIANCE, the freeze
// exception for undrawn principal, and an attention list that leads with its first few causes.
const pool = `0x${'34'.repeat(20)}`;
const row = (patch) => ({ state: 'Open', shares: '10', subscribed: '0', issue_price_atomic: '800000', redemption_per_share_atomic: '1000000', raised_atomic: '0',
  disbursed_atomic: '0', recovered_atomic: '0', escrow_atomic: '0', maturity: '1900000000', subscription_deadline: '1890000000', disbursement_deadline: '1895000000',
  subscription_open: false, subscription_blockers: ['state_closed'], ...patch });

async function financePage(page, language) {
  await page.addInitScript((value) => { localStorage.setItem('ts_lang', value); }, language);
  const config = { chainIdDecimal: 1439, protocolVersion: 5, controlVersion: 4, contracts: { RWAOfferingPool: pool }, abis: { RWAOfferingPool: [] } };
  const now = Math.floor(Date.now() / 1000);
  await page.route('**/api/controlled/status', (route) => route.fulfill({ json: { active: true, config, controller: `0x${'90'.repeat(20)}` } }));
  await page.route('**/api/controlled/offerings**', (route) => route.fulfill({ json: { config, snapshot: { block_number: 900, block_hash: `0x${'ab'.repeat(32)}`, block_timestamp: now - 60 },
    // The window is open, but the wallet that signed it no longer holds the compliance role.
    availability: { intake_stopped: false, screening_valid_until: String(now + 3600), screening_source_active: false, screening_valid: false },
    total_pools: 3, complete: true, failures: [], next_cursor: null, offerings: [
      row({ pool_id: 7, state: 'Frozen', subscribed: '10', raised_atomic: '8000000', escrow_atomic: '8000000', undisbursed_exit_available: true }),
      row({ pool_id: 8, subscription_blockers: ['screening_source_inactive', 'valuation_expired'] }),
      row({ pool_id: 9, empty_expired: true, unsubscribed_exit_available: true, subscription_blockers: ['deadline_passed'] })] } }));
}

for (const language of ['zh', 'en']) {
  const zh = language === 'zh';
  test(`F04/F05 ${language}: a revoked screening signer and the freeze exception read as tasks with their owners`, async ({ page }) => {
    await financePage(page, language);
    await page.goto('/#/finance');
    const panel = page.locator('.controlled-panel'), attention = panel.getByRole('region', { name: zh ? '需要处理的事项' : 'Needs attention' });
    await expect(attention).toContainText(zh ? '全局来源审查的签发人已失去合规角色' : 'no longer holds the compliance role');
    await expect(attention).toContainText(zh ? '这不是某个出资人自身的资格问题' : 'not an individual investor');
    await expect(attention).toContainText(zh ? '已过放款截止且从未放款' : 'Past the draw deadline with nothing drawn');
    // Four causes: three show, one folds behind a button that says how many.
    await expect(attention.locator('li')).toHaveCount(3);
    const more = attention.getByRole('button', { name: zh ? '还有 1 项' : '1 more' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(attention.locator('li')).toHaveCount(4);
    await expect(attention.getByRole('button', { name: zh ? '收起' : 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('tbody')).toContainText(zh ? '来源审查签发人已失去合规角色' : 'The screening signer no longer holds the compliance role');

    await panel.getByRole('button', { name: `${zh ? '查看详情' : 'View details'} #7`, exact: true }).click();
    const detail = panel.getByRole('region', { name: zh ? '融资详情' : 'Financing details', exact: true });
    await expect(detail).toContainText(zh ? '冻结不阻止这一退出' : 'A freeze does not stop this exit');
    expect((await new AxeBuilder({ page }).include('.controlled-panel').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  });
}
