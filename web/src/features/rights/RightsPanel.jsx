import { useEffect, useState } from 'react';
import { useLang } from '../../state/hooks.js';

/** The current deployment and W3 research candidate have separate, explicit status. */
export function RightsPanel() {
  const lang = useLang(), zh = lang === 'zh';
  const [state, setState] = useState(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/rights/status', { signal: abort.signal }).then((response) => {
      if (!response.ok) throw new Error('Status unavailable'); return response.json();
    }).then((value) => { if (!abort.signal.aborted) setState(value); }).catch(() => { if (!abort.signal.aborted) setState({ unavailable: true }); });
    return () => abort.abort();
  }, []);
  return (
    <aside className="rights-panel" aria-label={zh ? '权利与控制' : 'Rights and control'}>
      <details>
        <summary>{zh ? '权利、资格与私人资料' : 'Rights, eligibility and private material'}</summary>
        <p role="status">{!state ? (zh ? '正在核对控制状态…' : 'Checking control status…') : state.unavailable
          ? (zh ? '控制状态暂不可核对，暂停新增受控操作。' : 'Control status is unavailable. New controlled actions are on hold.')
          : state.active_control_plane ? (zh ? '已连接受控测试实例；每笔操作仍需钱包确认。' : 'Controlled test instance connected. Each action requires wallet confirmation.')
            : (zh ? '尚未配置受控融资实例。' : 'No controlled financing instance is configured.')}</p>
        <dl>
          <div><dt>{zh ? '使用范围' : 'Scope'}</dt><dd>{zh ? '教学研究、模拟单证与测试代币。' : 'Research, simulated titles and test assets.'}</dd></div>
          <div><dt>{zh ? '发行与认购' : 'Issuance and subscription'}</dt><dd>{zh ? '持有人同意、有效估值、持续资格及条款确认。' : 'Holder consent, current valuation, eligibility and accepted terms.'}</dd></div>
          <div><dt>{zh ? '已有权利' : 'Existing rights'}</dt><dd>{zh ? '新资格失效不撤销已取得的退款和领取权。' : 'Eligibility expiry preserves acquired refund and claim rights.'}</dd></div>
          <div><dt>{zh ? '私人资料' : 'Private material'}</dt><dd>{zh ? '私人材料加密保存，公开摘要须两名独立审核员批准。' : 'Private material is encrypted. Public summaries require two independent reviewers.'}</dd></div>
          <div><dt>{zh ? '真实业务' : 'Real business'}</dt><dd>{zh ? '尚未启用；真实签发、法律控制及外部身份仍待验证。' : 'Disabled. Real issuance, legal control and external identity remain unverified.'}</dd></div>
        </dl>
      </details>
    </aside>
  );
}
