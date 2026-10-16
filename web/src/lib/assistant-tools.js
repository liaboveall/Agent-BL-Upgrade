// Read-only assistant tools kept for integrations that used them. They only ever report what the
// server recorded: no activity means "no activity", and a transaction is shown only when one exists.
import { t, tData } from './i18n.js';
import { getAppState } from '../state/app-store.js';
import { copilotQuery } from './copilot-api.js';

export async function serverJson(path) {
  const response = await fetch(path);
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export function portfolioPath() {
  return `/api/investors/portfolio?wallet_address=${encodeURIComponent(getAppState().wallet?.address || '0xDemoWallet')}`;
}

export const toolExecutors = {
  async getAgentActivity({ limit = 10 } = {}) {
    const result = await serverJson(`/api/agent/activity?limit=${Math.min(50, Math.max(1, Number(limit) || 10))}`);
    if (!result.activities.length) return t('cp_activity_empty');
    return result.activities.map((item) => `${item.action}${item.tx_hash ? ` · ${item.tx_hash}` : ''}`).join('\n');
  },
  async getPortfolio() {
    const result = await serverJson(portfolioPath());
    return result.investments.map((item) => `${tData(item.label)} · ${t('cp_tool_demo')} · ${item.riskLevel === 'WARNING' ? '🟠' : ''}${item.riskLevel} · ${item.reference}`).join('\n') || t('portfolio_empty');
  },
  async recommendEBL({ preference }) { return (await copilotQuery(preference)).narrative; },
  async compareEBLs({ case_ids = [] }) { return (await copilotQuery('compare', { pool_ids: case_ids })).narrative; }
};
