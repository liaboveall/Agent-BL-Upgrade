import { useEffect, useState } from 'react';
import { useLang } from '../../state/hooks.js';

export function EvidencePanel() {
  const zh = useLang() === 'zh';
  const [status, setStatus] = useState(null), [session, setSession] = useState(''), [evidenceId, setEvidenceId] = useState('');
  const [result, setResult] = useState(null), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState(null), [reason, setReason] = useState('');
  const [reviewId, setReviewId] = useState(''), [contextHash, setContextHash] = useState(''), [reviewState, setReviewState] = useState(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/evidence/status', { signal: abort.signal }).then((response) => {
      if (!response.ok) throw new Error('Unavailable'); return response.json();
    }).then((data) => { if (!abort.signal.aborted) setStatus(data); }).catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, []);
  const download = async (event) => {
    event.preventDefault(); setBusy(true); setError(false); setResult(null);
    try {
      const response = await fetch(`/api/rights/evidence/${encodeURIComponent(evidenceId.trim())}/download`, { headers: { 'x-rights-session': session }, cache: 'no-store' });
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json(); if (!data.verification?.passed) throw new Error('Verification failed');
      const root = data.entries?.find((entry) => entry.bundle.evidence_id === data.root_id)?.bundle;
      setInspection(root ? { kind: root.kind, provider: root.source.provider, version: root.source.version, expires_at: root.expires_at } : null);
      const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }), url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `evidence-${data.root_id}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setResult(data.package_hash);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  const review = async (verdict = null) => {
    setBusy(true); setError(false); setReviewState(null);
    try {
      const endpoint = verdict ? `/api/rights/evidence-reviews/${encodeURIComponent(reviewId.trim())}/resolve`
        : `/api/rights/evidence/${encodeURIComponent(evidenceId.trim())}/review`;
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-rights-session': session },
        body: JSON.stringify(verdict ? { verdict, context_hash: contextHash.trim(), reason } : { reason }) });
      if (!response.ok) throw new Error('Review unavailable');
      const data = await response.json(); setReviewId(data.review_id); setContextHash(data.context_hash); setReviewState(data.status);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <aside className="evidence-panel" aria-label={zh ? '证据与来源' : 'Evidence and provenance'}><details>
    <summary>{zh ? '证据、来源与人工复核' : 'Evidence, sources and human review'}</summary>
    <p>{zh ? '来源、模型、付款和决策分别核验。参考行情与模型输出需要人工复核。' : 'Sources, models, payments and decisions are verified separately. Reference prices and model outputs require human review.'}</p>
    <dl>
      <div><dt>{zh ? '证据包' : 'Evidence package'}</dt><dd>{status ? (zh ? '版本化、加密保存、按权限下载，可离线复算。' : 'Versioned, encrypted, authorized download and offline verification.') : (zh ? '状态待核对' : 'Status pending')}</dd></div>
      <div><dt>{zh ? '模型与估值' : 'Model and valuation'}</dt><dd>{zh ? '研究参数，尚未完成独立业务验收。' : 'Research parameters. Independent business acceptance is pending.'}</dd></div>
      <div><dt>{zh ? '付款结果不明' : 'Payment outcome unknown'}</dt><dd>{zh ? '先对账已签授权，勿重复付费。' : 'Reconcile the signed authorization before another payment.'}</dd></div>
      <div><dt>{zh ? '链上包含' : 'Chain inclusion'}</dt><dd>{zh ? '包含证明不代表材料真实或仍可获取。' : 'Inclusion does not prove source truth or availability.'}</dd></div>
    </dl>
    <form onSubmit={download}>
      <label>{zh ? '业务会话' : 'Business session'}<input type="password" autoComplete="off" value={session} onChange={(event) => { setSession(event.target.value); setResult(null); setInspection(null); }} required /></label>
      <label>{zh ? '证据编号' : 'Evidence ID'}<input id="evidence-download-id" value={evidenceId} autoComplete="off" onChange={(event) => { setEvidenceId(event.target.value); setResult(null); setInspection(null); }} required pattern="[a-f0-9-]{36}" /></label>
      <button type="submit" disabled={busy}>{busy ? (zh ? '正在核验…' : 'Verifying…') : (zh ? '核验并下载材料包' : 'Verify and download package')}</button>
    </form>
    {inspection && <dl style={{ overflowWrap: 'anywhere' }}>
      <div><dt>{zh ? '来源与版本' : 'Source and version'}</dt><dd>{inspection.provider} / {inspection.version}</dd></div>
      <div><dt>{zh ? '材料有效期' : 'Material expiry'}</dt><dd>{inspection.expires_at}</dd></div>
    </dl>}
    <details className="evidence-review-form">
      <summary>{zh ? '人工复核与接管' : 'Human review and handover'}</summary>
      <p>{zh ? '先检查材料包中的来源、缺失和影响，再提交处理理由。独立审核员的结论只适用于当前材料和版本。' : 'Inspect sources, gaps and impact in the package, then record a reason. Independent review applies to the current material and version.'}</p>
      <label>{zh ? '复核理由与处理意见' : 'Review reason and decision'}<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} /></label>
      <button type="button" disabled={busy || !session || !reason.trim() || !/^[a-f0-9-]{36}$/u.test(evidenceId)} onClick={() => review()}>{zh ? '请求独立复核' : 'Request independent review'}</button>
      <label>{zh ? '复核编号' : 'Review ID'}<input value={reviewId} onChange={(event) => setReviewId(event.target.value)} /></label>
      <label>{zh ? '材料与版本指纹' : 'Material and version fingerprint'}<input value={contextHash} onChange={(event) => setContextHash(event.target.value)} /></label>
      <div className="evidence-review-actions">
        <button type="button" disabled={busy || !session || !reason.trim() || !reviewId || !contextHash} onClick={() => review('APPROVE')}>{zh ? '批准研究复核' : 'Approve research review'}</button>
        <button type="button" disabled={busy || !session || !reason.trim() || !reviewId || !contextHash} onClick={() => review('REJECT')}>{zh ? '拒绝并保留记录' : 'Reject and retain record'}</button>
      </div>
      {reviewState && <p role="status">{reviewState === 'PENDING' ? (zh ? '请求已保存，等待独立审核员处理。' : 'Request saved. An independent reviewer must resolve it.')
        : reviewState === 'REJECTED' ? (zh ? '拒绝意见已保留。' : 'Rejection retained.') : (zh ? '研究复核结论已保存；真实业务仍未启用。' : 'Research review saved. Real business remains disabled.')}</p>}
    </details>
    {error && <p role="alert">{zh ? '无法核验或获取。请核对会话权限、有效期和材料完整性。' : 'Verification or retrieval failed. Check session access, expiry and material integrity.'}</p>}
    {result && <p role="status" style={{ overflowWrap: 'anywhere' }}>{zh ? '服务器复算通过，材料包已下载：' : 'Server verification passed. Package downloaded: '}{result}</p>}
  </details></aside>;
}
