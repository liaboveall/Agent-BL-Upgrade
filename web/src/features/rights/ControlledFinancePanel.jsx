import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, useLang } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { setView } from '../../state/controller.js';
import { appStore } from '../../state/app-store.js';
import { connectWallet, connectedAddress, currentWalletSession } from '../../lib/web3.js';
import { controlledRequest, controlledIntentOptions, acknowledgeControlledTerms, subscribeControlled, claimControlled, refundControlled } from '../../lib/controlled.js';
import { verifyReadableTerms } from '../../lib/financing-disclosure.js';
import { describeFinanceError } from '../../lib/finance-errors.js';
import { ReadableTerms } from './ReadableTerms.jsx';
import { RoleWorkspace } from './RoleWorkspace.jsx';

// A pool the chain returned without a date shows a dash; it must not throw and take the whole panel down.
const isoTime = (v) => { const ms = v == null ? NaN : Number(v) * 1000; return Number.isFinite(ms) ? new Date(ms).toISOString() : '—'; };
const amount = (v) => v == null ? '—' : `${BigInt(v) / 1000000n}.${(BigInt(v) % 1000000n).toString().padStart(6, '0')}`;
// Each wallet action says what it moves; a refund or claim must never read like a subscription.
function confirmationCopy(review, zh) {
  switch (review.kind) {
    case 'acknowledge': return zh ? '只在链上记录你同意上述条款与报价版本，不转移任何资金。之后仍需单独审阅认购；报价更新会使本次同意失效。' : 'Records on chain that you accept these terms and this quote version. No funds move. Review the subscription separately afterwards; a new quote voids this acceptance.';
    case 'subscribe': return zh ? '钱包会依次请求代币授权和认购。资金进入上述池；本金与回报可能损失。结清后仍须单独领取；募集失败时可按链上条件退款。' : 'Your wallet asks for a token approval and then the subscription. Funds enter the pool above; principal and returns may be lost. Settlement needs a separate claim; a failed raise can be refunded under the chain conditions.';
    case 'claim': return zh ? '把你在该池的可领取回款转入当前钱包。首次领取会销毁份额，之后的迟到回款仍可再次领取。' : 'Moves your claimable payments from this pool to this wallet. The first claim burns your shares; later recoveries remain claimable.';
    default: return zh ? '募集未成功或池已取消时，退回你的实付成本并销毁对应份额；链上会再次核对退款条件，不满足时不会转移资金。' : 'If the raise failed or the pool was cancelled, returns what you paid and burns those shares. The chain checks the refund conditions again; nothing moves if they are not met.';
  }
}
export function ControlledFinancePanel({ primary = false }) {
  const zh = useLang() === 'zh', demo = useApp((s) => s.demoMode), generation = useApp((s) => s.modeGeneration);
  const stateLabel = (state) => zh ? ({ Open: '开放募集', Subscribed: '募集中', Funded: '募集成功', InTransit: '运输中', Repriced: '已更新报价', Paused: '暂停', Frozen: '冻结', Repaid: '已结清', Liquidation: '处置中', Cancelled: '已取消', Defaulted: '已违约', LossSettled: '损失结算' })[state] ?? state : state;
  const [wallet, setWallet] = useState(connectedAddress()), [status, setStatus] = useState(null), [offers, setOffers] = useState([]), [positions, setPositions] = useState([]);
  const [refresh, setRefresh] = useState(0), [problem, setProblem] = useState(null), [busy, setBusy] = useState(false), [review, setReview] = useState(null), [pending, setPending] = useState(null), [notice, setNotice] = useState('');
  const [shares, setShares] = useState('1');
  const [originalHash, setOriginalHash] = useState('');
  const [termsRead, setTermsRead] = useState(false);
  const [page, setPage] = useState({ from: 1 }), [listing, setListing] = useState(null), [lookup, setLookup] = useState('');
  const [loading, setLoading] = useState(true), [positionError, setPositionError] = useState(''), [selectedPool, setSelectedPool] = useState(null);
  const [publicTerms, setPublicTerms] = useState(null);
  // Messages are kept language-neutral ([zh, en] pairs or the original failure) and localized at render, so a
  // language switch re-labels the panel without re-reading the chain or closing an open review.
  const pick = (message) => Array.isArray(message) ? message[zh ? 0 : 1] : message;
  // Codes and contract reverts become a localized next step; unknown failures keep their own message.
  const shownProblem = problem?.failure ? describeFinanceError(problem.failure, zh) : problem ? { message: pick(problem.message), session: false } : null;
  const error = shownProblem?.message ?? '';
  const setError = useCallback((message) => setProblem(message ? { message } : null), []);
  const fail = useCallback((failure) => setProblem({ failure }), []);
  const [showRoles, setShowRoles] = useState(null);
  const rolesOpen = showRoles ?? !primary;
  const focusAfterRead = useRef(null);
  const readGeneration = useRef(0);
  const confirmation = useRef(null), reviewOpener = useRef(null);
  const detailPanel = useRef(null), detailOpener = useRef(null);
  useEffect(() => {
    if (selectedPool == null) return;
    const frame = requestAnimationFrame(() => detailPanel.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selectedPool]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (review) confirmation.current?.focus();
      else if (document.activeElement === document.body && reviewOpener.current?.isConnected) reviewOpener.current.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [review]);
  useEffect(() => {
    if (loading) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body && focusAfterRead.current?.isConnected) focusAfterRead.current.focus({ preventScroll: true });
      focusAfterRead.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [loading]);
  useEffect(() => {
    const change = () => { setWallet(connectedAddress()); setReview(null); setPositions([]); setPending(null); setPage({ from: 1 }); setListing(null); setOffers([]); setRefresh((n) => n + 1); };
    window.addEventListener('agentbl:walletchange', change); return () => window.removeEventListener('agentbl:walletchange', change);
  }, []);
  useEffect(() => {
    let mode = appStore.get().modeGeneration;
    return appStore.subscribe(() => {
      const next = appStore.get().modeGeneration;
      if (next !== mode) { mode = next; setReview(null); setTermsRead(false); }
    });
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const load = async () => {
      focusAfterRead.current = document.activeElement?.closest('#controlled-finance') ? document.activeElement : null;
      readGeneration.current += 1;
      setLoading(true); setError(''); setPositionError(''); setPositions([]); setOffers([]); setListing(null); setSelectedPool(null); setPublicTerms(null); setReview(null);
      try {
        const statusResponse = await fetch('/api/controlled/status', { signal: abort.signal }), value = await statusResponse.json();
        if (!statusResponse.ok) throw Object.assign(new Error(value.error ?? 'Controlled status unavailable'), { code: value.code });
        if (abort.signal.aborted) return;
        setStatus(value);
        if (!value.active) return;
        if (wallet) {
          try { setPending(JSON.parse(localStorage.getItem(`agentbl.controlled-intent:${value.config.contracts.RWAOfferingPool.toLowerCase()}:${wallet.toLowerCase()}`) ?? 'null')); }
          catch { setPending({ invalid: true }); setPositionError(['原交易记录损坏，请保留钱包记录并人工核对。', 'Saved transaction record is corrupt. Keep wallet records for manual reconciliation.']); }
        }
        const query = new URLSearchParams(Object.entries(page).map(([key, value]) => [key, String(value)]));
        const endpoint = page.pool_id ? `offerings/${page.pool_id}` : `offerings${page.from === 1 && !page.block_number ? '' : `?${query}`}`;
        const offerResponse = await fetch(`/api/controlled/${endpoint}`, { signal: abort.signal }), listing = await offerResponse.json();
        if (!offerResponse.ok) throw Object.assign(new Error(listing.error ?? 'Controlled offering read failed'), { code: listing.code });
        if (abort.signal.aborted) return; setOffers(listing.offerings); setListing(listing);
        if (listing.complete === false) setError(['部分池查询失败，请重试；未返回的数据不是零余额。', 'Some pools could not be read. Retry; missing data is not a zero balance.']);
        if (wallet) try {
          const response = await fetch(`/api/controlled/positions?wallet=${encodeURIComponent(wallet)}`, { signal: abort.signal }), data = await response.json();
          if (!response.ok) throw new Error(data.error ?? 'Position reconciliation failed');
          const allPositions = [...data.positions]; let next = data.next_cursor;
          const snapshot = data.snapshot; let incomplete = data.complete === false || Boolean(data.warning);
          while (next && snapshot && !abort.signal.aborted) {
            const more = await fetch(`/api/controlled/positions?wallet=${encodeURIComponent(wallet)}&from=${next}&limit=20&block_number=${snapshot.block_number}&block_hash=${snapshot.block_hash}`, { signal: abort.signal });
            const value = await more.json(); if (!more.ok) throw new Error(value.error ?? 'Position page unavailable');
            allPositions.push(...value.positions); incomplete ||= value.complete === false || Boolean(value.warning);
            if (value.next_cursor && value.next_cursor <= next) throw new Error('Position cursor did not advance'); next = value.next_cursor;
          }
          if (abort.signal.aborted) return; setPositions(allPositions);
          if (incomplete) setPositionError(['持仓查询未完整对账，未知金额显示为 —。', 'Position reads are incomplete; unknown amounts are shown as —.']);
          if (data.warning) setPositionError(['链上持仓尚待对账。', 'Chain positions need reconciliation.']);
        } catch { if (!abort.signal.aborted) { setPositions([]); setPositionError(['持仓读取失败；余额未知，请重试对账。', 'Position read failed. Balances are unknown; retry reconciliation.']); } }
      } catch (failure) { if (!abort.signal.aborted) { setOffers([]); setPositions([]); setListing(null); fail(failure); } }
      finally { if (!abort.signal.aborted) setLoading(false); }
    };
    load(); return () => abort.abort();
  }, [wallet, refresh, page, generation, setError, fail]);
  const navigate = (from) => { setReview(null); setPage({ from, block_number: listing.snapshot.block_number, block_hash: listing.snapshot.block_hash }); };
  const blockedReason = (offer) => demo ? (zh ? 'Demo 只读；Live 测试网操作需钱包逐次授权。' : 'Demo is read only; Live testnet actions require wallet approval.')
    : !wallet ? (zh ? '先连接钱包，再核对资格与条款。' : 'Connect a wallet, then verify eligibility and terms.')
    : pending ? (zh ? '先核对原交易，避免重复发送。' : 'Reconcile the original transaction before another send.')
    : !offer.subscription_open ? (zh ? '当前不接受新认购；核对募集截止、状态和实例版本。已有持仓仍可按条件退出。' : 'New subscriptions are closed. Check the deadline, state and instance version. Existing positions retain their exits.')
    : (zh ? '下一步：完整阅读并同意条款，再审阅认购；链上仍核验资格与额度。' : 'Next: read and accept the full terms, then review a subscription. Eligibility and limits are checked on chain.');
  // A subscribable chain state is not an open subscription: the server closes it at the snapshot block's deadline or at full supply.
  const closedLabel = (offer) => offer.subscription_open !== false || !['Open', 'Subscribed', 'Repriced'].includes(offer.state) ? null
    : Number(offer.subscription_deadline) < Number(listing?.snapshot?.block_timestamp) ? (zh ? '募集已截止' : 'Subscription ended')
    : BigInt(offer.subscribed) >= BigInt(offer.shares) ? (zh ? '已募满' : 'Fully subscribed') : (zh ? '不接受认购' : 'Not accepting subscriptions');
  const offerLabel = (offer) => closedLabel(offer) ?? stateLabel(offer.state);
  const storageKey = () => `agentbl.controlled-intent:${status.config.contracts.RWAOfferingPool.toLowerCase()}:${wallet.toLowerCase()}`;
  const onIntent = (intent) => { const value = { intent_id: intent.intent_id, operation: intent.operation }; localStorage.setItem(storageKey(), JSON.stringify(value)); setPending(value); };
  const connect = async () => { try { await connectWallet('metamask'); setError(''); } catch (failure) { fail(failure); } };
  const startReview = async (kind, offer) => {
    reviewOpener.current = document.activeElement;
    const snapshot = { wallet: connectedAddress(), session: currentWalletSession(), generation: appStore.get().modeGeneration };
    setBusy(true); setReview(null); setTermsRead(false); setError('');
    try {
      const pack = await controlledRequest(`offerings/${offer.pool_id}/terms`);
      await verifyReadableTerms(pack, offer, status);
      const current = appStore.get();
      if (snapshot.wallet !== connectedAddress() || snapshot.session !== currentWalletSession() || snapshot.generation !== current.modeGeneration || current.demoMode) throw Object.assign(new Error('Wallet or mode changed. Review again.'), { code: 'CONTEXT_CHANGED' });
      setReview({ kind, offer, shares, pack, generation: snapshot.generation });
    } catch (failure) { fail(failure); } finally { setBusy(false); }
  };
  const readPublicTerms = async (offer) => {
    const version = readGeneration.current;
    setBusy(true); setError(''); setPublicTerms(null);
    try {
      const pack = await controlledRequest(`offerings/${offer.pool_id}/terms`);
      await verifyReadableTerms(pack, offer, status);
      if (version === readGeneration.current) setPublicTerms({ pool_id: offer.pool_id, pack });
    } catch (failure) { if (version === readGeneration.current) fail(failure); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!review || busy || demo || !wallet) return;
    const snapshot = { wallet, generation, demo }, session = currentWalletSession(), selected = review;
    const assertCurrent = () => {
      const current = appStore.get();
      if (current.modeGeneration !== snapshot.generation || selected.offer && selected.generation !== snapshot.generation || current.demoMode !== false || connectedAddress() !== snapshot.wallet || currentWalletSession() !== session) throw Object.assign(new Error('Wallet or execution mode changed. Review the operation again.'), { code: 'CONTEXT_CHANGED' });
    };
    setBusy(true); setError(''); setNotice('');
    try {
      const revalidate = async () => {
        assertCurrent();
        if (selected.offer) await verifyReadableTerms(await controlledRequest(`offerings/${selected.offer.pool_id}/terms`), selected.offer, status);
        assertCurrent();
      };
      await revalidate();
      const options = { ...controlledIntentOptions(status.config, onIntent, assertCurrent, selected.pack?.disclosure_hash), onIntent };
      const checkpoint = options.beforeBroadcast;
      options.beforeBroadcast = async (intent) => { await revalidate(); return checkpoint(intent); };
      let result;
      if (selected.kind === 'acknowledge') result = await acknowledgeControlledTerms(selected.offer, status, assertCurrent, revalidate);
      else if (selected.kind === 'subscribe') result = await subscribeControlled(selected.offer, selected.shares, status, options);
      else if (selected.kind === 'claim') result = await claimControlled(selected.position, options);
      else result = await refundControlled(selected.position, status.config, options);
      if (selected.kind !== 'acknowledge') { localStorage.removeItem(storageKey()); setPending(null); }
      setNotice(`${zh ? '规范回执已确认' : 'Canonical receipt confirmed'}: ${result.txHash}`); setReview(null); setRefresh((n) => n + 1);
    } catch (failure) {
      if (failure.code === 'ACTION_REJECTED' || failure.code === 4001) { localStorage.removeItem(storageKey()); setPending(null); }
      fail(failure); setReview(null);
    }
    finally { setBusy(false); }
  };
  const reconcile = async () => {
    setBusy(true); setError('');
    try {
      const { intent } = await controlledRequest(`intents/${pending.intent_id}`);
      if (intent.status === 'confirmed') { localStorage.removeItem(storageKey()); setPending(null); setNotice(zh ? '原交易已确认，未重复发送。' : 'Original transaction confirmed without another send.'); }
      else { const value = { ...pending, status: intent.status }; localStorage.setItem(storageKey(), JSON.stringify(value)); setPending(value);
        setNotice(zh ? '原操作尚待对账，请保留记录并核对钱包。' : 'Original operation needs reconciliation. Keep the record and check the wallet.'); }
      setRefresh((n) => n + 1);
    } catch (failure) { fail(failure); } finally { setBusy(false); }
  };
  const attachOriginal = async () => {
    setBusy(true); setError('');
    try { await controlledRequest(`intents/${pending.intent_id}/transaction`, { tx_hash: originalHash }); await reconcile(); }
    catch (failure) { fail(failure); } finally { setBusy(false); }
  };
  const verifyIdentity = () => {
    setShowRoles(true);
    requestAnimationFrame(() => document.getElementById('financing-role-entry')?.scrollIntoView({ block: 'start' }));
  };
  return <aside id="controlled-finance" className={`controlled-panel${primary ? '' : ' is-secondary'}`} aria-label={zh ? '受控测试网融资' : 'Controlled testnet financing'}>
    <details open={primary || undefined}><summary>{zh ? '受控测试网融资与持仓' : 'Controlled testnet financing and positions'}</summary>
      <div className="finance-panel-lead">
        <p>{zh ? '核对资金池状态与完整条款，再由钱包确认每一步。仅限模拟单证与测试代币。' : 'Explore pools and verify the full terms before approving a wallet action. Research titles and test assets only.'}</p>
        <div className="finance-primary-actions">
          {status?.active && <button type="button" className="finance-button-primary" onClick={connect} disabled={busy}>{wallet ? `${wallet.slice(0, 8)}…${wallet.slice(-4)}` : (zh ? '连接 EVM 钱包' : 'Connect EVM wallet')}</button>}
          <button type="button" disabled={busy || loading} onClick={() => setRefresh((n) => n + 1)}>{zh ? '刷新数据' : 'Refresh data'}</button>
        </div>
      </div>
      {loading && <p className="finance-loading" role="status">{zh ? '正在读取链上快照与持仓…' : 'Reading chain snapshot and positions…'}</p>}
      {!status?.active ? (!loading && <div className="finance-empty" role="status">
        <p><strong>{t('finance_empty_title')}</strong><br />{t('finance_empty_body')}</p>
        <div className="finance-paths">
          {[['market', 'finance_path_market'], ['mint', 'finance_path_mint'], ['agent', 'finance_path_agent']].map(([view, key]) => (
            <button key={view} type="button" className="finance-path" onClick={() => setView(view)}>
              <strong>{t(key)}</strong><span>{t(`${key}_hint`)}</span>
            </button>
          ))}
        </div>
      </div>) : <>
        <div className="finance-overview" aria-label={zh ? '当前融资概览' : 'Current financing overview'}>
          <div><span>{zh ? '资金池总数' : 'Funding pools'}</span><strong>{listing?.total_pools ?? '—'}</strong><small>{zh ? '当前协议实例' : 'In this protocol instance'}</small></div>
          <div><span>{zh ? '当前浏览' : 'Showing'}</span><strong>{!listing ? '—' : !listing.total_pools ? '0' : page.pool_id ? `#${page.pool_id}` : `${page.from}–${Math.min(page.from + 9, listing.total_pools)}`}</strong><small>{zh ? '固定区块快照' : 'One consistent snapshot'}</small></div>
          <div><span>{zh ? '操作模式' : 'Execution mode'}</span><strong className="finance-mode">{demo ? 'Demo' : 'Live'}</strong><small>{demo ? (zh ? '只读浏览 · 无资金操作' : 'Read only · no fund actions') : (zh ? '测试网 · 钱包逐次确认' : 'Testnet · wallet approvals')}</small></div>
        </div>
        <div className="role-entry"><div className="finance-role-callout"><div><strong>{zh ? '融资方与审查人' : 'Borrowers and reviewers'}</strong><p>{zh ? '管理单证、材料审核与融资流程。' : 'Manage documents, reviews, and financing responsibilities.'}</p></div><button type="button" aria-label={`${rolesOpen ? (zh ? '收起工作台' : 'Close workspace') : (zh ? '打开工作台' : 'Open workspace')}${zh ? '：融资方与审查人的角色待办' : ': borrower and reviewer responsibilities'}`} aria-expanded={rolesOpen} aria-controls="financing-role-entry" onClick={() => setShowRoles(!rolesOpen)}>{rolesOpen ? (zh ? '收起工作台' : 'Close workspace') : (zh ? '打开工作台' : 'Open workspace')} <span aria-hidden="true">{rolesOpen ? '−' : '↓'}</span></button></div><div id="financing-role-entry" hidden={!rolesOpen}><RoleWorkspace zh={zh} status={status} wallet={wallet} /></div></div>
        <div className="finance-directory-toolbar">
          <div><h2>{zh ? '浏览资金池' : 'Explore funding pools'}</h2><p>{zh ? '查看状态、资金流转与每个池的完整条款。' : 'Review each pool’s status, cash movements, and terms.'}</p></div>
          <form className="finance-pool-lookup" onSubmit={(event) => { event.preventDefault(); if (!busy && /^[1-9]\d{0,8}$/u.test(lookup)) { setReview(null); setPage({ from: Number(lookup), pool_id: Number(lookup) }); } }}>
            <label htmlFor="funding-pool-lookup">{zh ? '指定池编号' : 'Pool ID'}</label><div><input id="funding-pool-lookup" inputMode="numeric" placeholder={zh ? '例如 25' : 'e.g. 25'} value={lookup} onChange={(event) => setLookup(event.target.value)} /><button type="submit" disabled={busy || !/^[1-9]\d{0,8}$/u.test(lookup)}>{zh ? '查找' : 'Find pool'}</button></div>
          </form>
        </div>
        {listing?.failures?.length > 0 && <p role="alert">{zh ? '尚未读到的池' : 'Unread pools'}: {listing.failures.map((row) => `#${row.pool_id}`).join(', ')}</p>}
        {pending && <div className="controlled-pending"><p role="status">{zh ? '已保存待对账操作，暂停重复发送。' : 'A saved operation needs reconciliation. Repeated sending is paused.'} <button type="button" disabled={busy || !pending.intent_id} onClick={reconcile}>{zh ? '核对原交易' : 'Reconcile original transaction'}</button></p>
          <label>{zh ? '原钱包交易哈希' : 'Original wallet transaction hash'} <input value={originalHash} onChange={(event) => setOriginalHash(event.target.value)} /></label>
          <button type="button" disabled={busy || !pending.intent_id || !/^0x[a-fA-F0-9]{64}$/u.test(originalHash)} onClick={attachOriginal}>{zh ? '附加原交易并核对' : 'Attach and reconcile original transaction'}</button>
          {pending.status === 'draft' && <button type="button" disabled={busy} onClick={() => { localStorage.removeItem(storageKey()); setPending(null); setNotice(zh ? '已取消本地未广播草稿；审计记录保留。' : 'Local unbroadcast draft dismissed; audit history retained.'); }}>{zh ? '取消未广播草稿' : 'Dismiss unbroadcast draft'}</button>}
        </div>}
        {offers.filter((offer) => offer.pool_id === selectedPool).map((offer) => <section ref={detailPanel} tabIndex={-1} key={offer.pool_id} id="funding-pool-detail" className="funding-detail" aria-label={zh ? '融资详情' : 'Financing details'}>
          <div className="finance-detail-head"><h2>{zh ? '资金池' : 'Funding pool'} #{offer.pool_id} · {offerLabel(offer)}</h2><button type="button" onClick={() => { setSelectedPool(null); detailOpener.current?.focus(); }}>{zh ? '关闭详情' : 'Close details'}</button></div>
          <p>{blockedReason(offer)}</p>
          <dl><div><dt>{zh ? '资产与责任' : 'Asset and responsibility'}</dt><dd>{zh ? '以完整公开条款中的货物、路线和责任主体为准；哈希不证明真实货权。' : 'Read the cargo, route and responsible parties in the full public terms. A hash does not prove real title.'}</dd></div>
            <div><dt>{zh ? '募集 / 放款截止 / 到期' : 'Subscription / disbursement deadline / maturity'}</dt><dd>{[offer.subscription_deadline, offer.disbursement_deadline, offer.maturity].map(isoTime).join(' / ')}</dd></div>
            <div><dt>{zh ? '进度' : 'Progress'}</dt><dd>{offer.subscribed} / {offer.shares} {zh ? '份；实收与回款见上表。' : 'shares; actual cash amounts appear above.'}</dd></div>
            <div><dt>{zh ? '退出责任' : 'Cash exit'}</dt><dd>{zh ? '出资人自行退款或领取；融资方实际回款。处置与异议按已签条款执行。' : 'Investors refund or claim for themselves; the borrower sends actual repayments. Resolution and disputes follow the signed terms.'}</dd></div></dl>
          <p>{zh ? '目标兑付不是预测收益；可能损失本金。公开条款在每次钱包授权前独立核验。' : 'Target redemption is not a return forecast; principal may be lost. Full terms are independently checked before wallet authorization.'}</p>
          <div className="finance-detail-actions">
        <label className="controlled-shares">{zh ? '认购份额' : 'Subscription shares'} <input inputMode="numeric" value={shares} onChange={(event) => { setShares(event.target.value); setReview(null); }} /></label>
          <div className="controlled-actions controlled-steps"><button type="button" disabled={busy || loading || demo || !wallet || !offer.subscription_open || Boolean(pending)} onClick={() => startReview('acknowledge', offer)}><span className="step-badge" aria-hidden="true">1</span>{zh ? '阅读并同意条款' : 'Read and accept terms'}</button>
          <button type="button" className="finance-button-primary" disabled={busy || loading || demo || !wallet || !offer.subscription_open || Boolean(pending) || !/^[1-9]\d{0,8}$/u.test(shares)} onClick={() => startReview('subscribe', offer)}><span className="step-badge" aria-hidden="true">2</span>{zh ? '审阅认购' : 'Review subscription'}</button></div></div>
          <p className="small muted">{zh ? '第 1 步只在链上记录你同意当前条款，不转移资金；报价更新后需要重新同意。第 2 步才会请求代币授权并认购。' : 'Step 1 only records on chain that you accept these terms; no funds move, and a new quote needs a new acceptance. Step 2 asks for the token approval and the subscription.'}</p>
          <button type="button" disabled={busy || loading} onClick={() => readPublicTerms(offer)}>{zh ? '只读查看完整条款' : 'Read full terms without signing'}</button>
          {publicTerms?.pool_id === offer.pool_id && <ReadableTerms pack={publicTerms.pack} zh={zh} />}
        </section>)}
        <div className="controlled-table-wrap" role="region" aria-label={zh ? '资金池表格，可横向滚动' : 'Funding pool table, scroll horizontally'} tabIndex={0}><table><caption className="sr-only">{zh ? '链上资金池' : 'On-chain funding pools'}</caption><thead><tr><th>{zh ? '池与状态' : 'Pool and state'}</th><th>{zh ? '每份价格 / 兑付' : 'Price / redemption per share'}</th><th>{zh ? '募集 / 放款 / 回收' : 'Raised / disbursed / recovered'}</th><th>{zh ? '操作' : 'Actions'}</th></tr></thead>
          <tbody>{offers.map((offer) => <tr key={offer.pool_id}><td>#{offer.pool_id} · <span className={`finance-state finance-state-${closedLabel(offer) ? 'closed' : String(offer.state).toLowerCase()}`}>{offerLabel(offer)}</span><br />{offer.subscribed}/{offer.shares}<br />{zh ? '到期 ' : 'Maturity '}<time>{isoTime(offer.maturity).slice(0, 10)}</time></td>
            <td>{amount(offer.issue_price_atomic)} / {amount(offer.redemption_per_share_atomic)} TEST_USDC</td><td>{amount(offer.raised_atomic)} / {amount(offer.disbursed_atomic)} / {amount(offer.recovered_atomic)}</td>
            <td><button type="button" className="finance-pool-link" aria-label={`${zh ? '查看详情' : 'View details'} #${offer.pool_id}`} aria-expanded={selectedPool === offer.pool_id} aria-controls="funding-pool-detail" onClick={() => { detailOpener.current = document.activeElement; setSelectedPool(selectedPool === offer.pool_id ? null : offer.pool_id); }}>{zh ? '查看详情' : 'View details'} <span aria-hidden="true">{selectedPool === offer.pool_id ? '−' : '↑'}</span></button></td></tr>)}</tbody></table></div>
        {!offers.length && listing && listing.complete !== false && <p>{zh ? '此实例尚无发行。' : 'This instance has no offerings.'}</p>}
        <nav className="finance-pagination" aria-label={zh ? '资金池分页与查找' : 'Funding pool pages and lookup'}>
          <span>{zh ? '当前范围' : 'Current range'}: {!listing?.total_pools ? '—' : page.pool_id ? `#${page.pool_id}` : `${page.from}–${Math.min(page.from + 9, listing.total_pools)}`} / {listing?.total_pools ?? '—'}</span>
          <div className="controlled-actions"><button type="button" disabled={busy || loading || !listing?.snapshot || (!page.pool_id && page.from === 1)} onClick={() => navigate(1)}>{zh ? '首页' : 'First page'}</button>
          <button type="button" disabled={busy || loading || !listing?.snapshot || Boolean(page.pool_id) || (page.from ?? 1) <= 1} onClick={() => navigate(Math.max(1, page.from - 10))}>{zh ? '上一页' : 'Previous page'}</button>
          <button type="button" disabled={busy || loading || !listing?.next_cursor || !listing?.snapshot} onClick={() => navigate(listing.next_cursor)}>{zh ? '下一页' : 'Next page'}</button>
          <button type="button" disabled={busy || loading || !listing?.snapshot || !listing?.total_pools || (!page.pool_id && !listing.next_cursor)} onClick={() => navigate(Math.floor((listing.total_pools - 1) / 10) * 10 + 1)}>{zh ? '末页' : 'Last page'}</button></div>
        </nav>
        <div className="finance-data-context"><p>{zh ? '翻页沿用当前快照。要查看新增资金池，请回到最新首页。' : 'Pages use the same snapshot. Return to the latest first page to discover new pools.'}</p><button type="button" onClick={() => { setReview(null); setError(''); setPage({ from: 1 }); setRefresh((n) => n + 1); }} disabled={busy}>{zh ? '刷新与对账' : 'Refresh and reconcile'}</button></div>
        <div className="finance-instance-meta"><p className="controlled-instance">{zh ? '协议实例' : 'Protocol instance'} <code>{status.config.chainIdDecimal}:{status.config.contracts.RWAOfferingPool}</code></p>
        {listing?.snapshot && <p className="controlled-snapshot" role="status">{zh ? '快照区块 / 总池数' : 'Snapshot block / total pools'}: #{listing.snapshot.block_number} / {listing.total_pools} · <code>{listing.snapshot.block_hash}</code></p>}</div>
        <h2 className="positions-heading">{zh ? '我的持仓与退出' : 'My positions and exits'}</h2>
        {!wallet && <p>{zh ? '连接钱包后读取自己的持仓和退出权利。' : 'Connect your wallet to read your positions and exits.'}</p>}
        {wallet && !loading && !positionError && !positions.length && <p>{zh ? '此钱包在当前实例没有已发现的持仓。' : 'No positions were found for this wallet in this instance.'}</p>}
        {positionError && <p role="alert">{pick(positionError)}</p>}
        {positions.map((position) => <div key={position.position_id} className="controlled-position"><p>#{position.chain_pool_id} · {stateLabel(position.chain_state ?? position.status)} · {zh ? '持有' : 'Shares'} {position.shares} · {zh ? '可领取' : 'Claimable'} {amount(position.claimable_atomic)} TEST_USDC · {position.reconciled ? (zh ? '已对账' : 'Reconciled') : (zh ? '对账中' : 'Reconciling')}</p>
          <p>{zh ? '实付 / 已领取 / 已退款' : 'Paid / claimed / refunded'}: {amount(position.cost_atomic)} / {amount(position.claimed_atomic)} / {amount(position.refunded_atomic)} TEST_USDC</p>
          {position.recovery_rights_retained && <p>{zh ? '份额销毁后仍保留后续回款受益权；有新增回款时可再次领取。' : 'Recovery rights survive share redemption. You can claim again when later payments arrive.'}</p>}
          <button type="button" disabled={busy || demo || Boolean(pending) || !position.reconciled || (BigInt(position.shares) === 0n && BigInt(position.claimable_atomic ?? 0) === 0n) || !['Repaid', 'LossSettled'].includes(position.chain_state)} onClick={() => setReview({ kind: 'claim', position })}>{zh ? '审阅领取' : 'Review claim'}</button>
          <button type="button" disabled={busy || demo || Boolean(pending) || !position.reconciled || BigInt(position.shares) === 0n || !['Open', 'Subscribed', 'Repriced', 'Paused', 'Frozen', 'Cancelled', 'Liquidation'].includes(position.chain_state)} onClick={() => setReview({ kind: 'refund', position })}>{zh ? '审阅退款资格' : 'Review refund eligibility'}</button></div>)}
        {review && <section ref={confirmation} tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setReview(null); }} className="controlled-confirm" aria-label={zh ? '钱包操作确认' : 'Wallet action confirmation'}><p>{zh ? '操作' : 'Action'}: {({ acknowledge: zh ? '同意条款' : 'Accept terms', subscribe: zh ? '认购' : 'Subscribe', claim: zh ? '领取' : 'Claim', refund: zh ? '退款' : 'Refund' })[review.kind]} · #{review.offer?.pool_id ?? review.position.chain_pool_id}</p>
          {review.offer && <><p>{zh ? '条款承诺' : 'Terms commitment'}: <code>{review.offer.terms_hash}</code></p><p>{zh ? '报价版本' : 'Quote version'}: {review.offer.quote_version}</p></>}
          {review.pack && <><ReadableTerms pack={review.pack} zh={zh} /><label><input type="checkbox" checked={termsRead} onChange={(event) => setTermsRead(event.target.checked)} />{zh ? '我已核对责任主体、截止、零费、损失及退出条款' : 'I reviewed the parties, deadlines, zero fees, losses and exit terms'}</label></>}
          {review.kind === 'subscribe' && <p>{review.shares} × {amount(review.offer.issue_price_atomic)} = {amount(BigInt(review.shares) * BigInt(review.offer.issue_price_atomic))} TEST_USDC</p>}
          <p>{confirmationCopy(review, zh)}</p>
          {review.kind === 'claim' && <p>{zh ? '本次可领取' : 'Claimable now'}: {amount(review.position.claimable_atomic)} TEST_USDC</p>}
          {review.kind === 'refund' && <p>{zh ? '退回实付成本' : 'Cost to return'}: {amount(review.position.cost_atomic)} TEST_USDC</p>}
          <button type="button" disabled={busy || demo || (Boolean(review.offer) && !termsRead)} onClick={confirm}>{zh ? '确认并前往钱包' : 'Confirm and continue to wallet'}</button><button type="button" disabled={busy} onClick={() => setReview(null)}>{zh ? '取消' : 'Cancel'}</button></section>}
      </>}
      {busy && <p role="status">{zh ? '正在处理，请保留当前交易记录…' : 'Processing. Keep the current transaction record…'}</p>}
      {error && <p role="alert" className="finance-alert">{error}{shownProblem.session && status?.active && <> <button type="button" className="finance-inline-action" onClick={verifyIdentity}>{zh ? '重新验证身份' : 'Verify identity again'}</button></>}</p>}{notice && <p role="status" className="controlled-notice">{notice}</p>}
    </details>
  </aside>;
}
