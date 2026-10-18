import { useEffect, useState } from 'react';
import { useApp, useLang } from '../../state/hooks.js';
import { appStore } from '../../state/app-store.js';
import { connectWallet, connectedAddress, currentWalletSession } from '../../lib/web3.js';
import { controlledRequest, controlledIntentOptions, acknowledgeControlledTerms, subscribeControlled, claimControlled, refundControlled } from '../../lib/controlled.js';

const amount = (v) => v == null ? '—' : `${BigInt(v) / 1000000n}.${(BigInt(v) % 1000000n).toString().padStart(6, '0')}`;
export function ControlledFinancePanel() {
  const zh = useLang() === 'zh', demo = useApp((s) => s.demoMode), generation = useApp((s) => s.modeGeneration);
  const stateLabel = (state) => zh ? ({ Open: '开放募集', Subscribed: '募集中', Funded: '募集成功', InTransit: '运输中', Repriced: '已更新报价', Paused: '暂停', Frozen: '冻结', Repaid: '已结清', Liquidation: '处置中', Cancelled: '已取消', Defaulted: '已违约', LossSettled: '损失结算' })[state] ?? state : state;
  const [wallet, setWallet] = useState(connectedAddress()), [status, setStatus] = useState(null), [offers, setOffers] = useState([]), [positions, setPositions] = useState([]);
  const [refresh, setRefresh] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false), [review, setReview] = useState(null), [pending, setPending] = useState(null), [notice, setNotice] = useState('');
  const [shares, setShares] = useState('1');
  const [originalHash, setOriginalHash] = useState('');
  useEffect(() => {
    const change = () => { setWallet(connectedAddress()); setReview(null); setPositions([]); setPending(null); setRefresh((n) => n + 1); };
    window.addEventListener('agentbl:walletchange', change); return () => window.removeEventListener('agentbl:walletchange', change);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const load = async () => {
      try {
        const statusResponse = await fetch('/api/controlled/status', { signal: abort.signal }), value = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(value.error ?? 'Controlled status unavailable');
        if (abort.signal.aborted) return;
        setStatus(value);
        if (!value.active) return;
        const offerResponse = await fetch('/api/controlled/offerings', { signal: abort.signal }), listing = await offerResponse.json();
        if (!offerResponse.ok) throw new Error(listing.error ?? 'Controlled offering read failed');
        if (abort.signal.aborted) return; setOffers(listing.offerings);
        if (wallet) {
          const response = await fetch(`/api/controlled/positions?wallet=${encodeURIComponent(wallet)}`, { signal: abort.signal }), data = await response.json();
          if (!response.ok) throw new Error(data.error ?? 'Position reconciliation failed');
          if (abort.signal.aborted) return; setPositions(data.positions);
          const saved = localStorage.getItem(`agentbl.controlled-intent:${value.config.contracts.RWAOfferingPool.toLowerCase()}:${wallet.toLowerCase()}`);
          if (saved) setPending(JSON.parse(saved));
          if (data.warning) setError(zh ? '链上持仓尚待对账。' : 'Chain positions need reconciliation.');
        }
      } catch (failure) { if (!abort.signal.aborted) setError(failure.message); }
    };
    load(); return () => abort.abort();
  }, [wallet, refresh, zh]);
  const storageKey = () => `agentbl.controlled-intent:${status.config.contracts.RWAOfferingPool.toLowerCase()}:${wallet.toLowerCase()}`;
  const onIntent = (intent) => { const value = { intent_id: intent.intent_id, operation: intent.operation }; localStorage.setItem(storageKey(), JSON.stringify(value)); setPending(value); };
  const connect = async () => { try { await connectWallet('metamask'); setError(''); } catch (failure) { setError(failure.message); } };
  const confirm = async () => {
    if (!review || busy || demo || !wallet) return;
    const snapshot = { wallet, generation, demo }, session = currentWalletSession(), selected = review;
    const assertCurrent = () => {
      const current = appStore.get();
      if (current.modeGeneration !== snapshot.generation || current.demoMode !== false || connectedAddress() !== snapshot.wallet || currentWalletSession() !== session) throw new Error('Wallet or execution mode changed. Review the operation again.');
    };
    setBusy(true); setError(''); setNotice('');
    try {
      assertCurrent(); const options = { ...controlledIntentOptions(status.config, onIntent, assertCurrent), onIntent };
      let result;
      if (selected.kind === 'acknowledge') result = await acknowledgeControlledTerms(selected.offer, status, assertCurrent);
      else if (selected.kind === 'subscribe') result = await subscribeControlled(selected.offer, selected.shares, status, options);
      else if (selected.kind === 'claim') result = await claimControlled(selected.position, options);
      else result = await refundControlled(selected.position, status.config, options);
      if (selected.kind !== 'acknowledge') { localStorage.removeItem(storageKey()); setPending(null); }
      setNotice(`${zh ? '规范回执已确认' : 'Canonical receipt confirmed'}: ${result.txHash}`); setReview(null); setRefresh((n) => n + 1);
    } catch (failure) {
      if (failure.code === 'ACTION_REJECTED' || failure.code === 4001) { localStorage.removeItem(storageKey()); setPending(null); }
      setError(failure.message); setReview(null);
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
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  const attachOriginal = async () => {
    setBusy(true); setError('');
    try { await controlledRequest(`intents/${pending.intent_id}/transaction`, { tx_hash: originalHash }); await reconcile(); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <aside id="controlled-finance" className="controlled-panel" aria-label={zh ? '受控测试网融资' : 'Controlled testnet financing'}>
    <details><summary>{zh ? '受控测试网融资与持仓' : 'Controlled testnet financing and positions'}</summary>
      <p>{zh ? '模拟单证、测试代币。资格与条款同意通过后才可认购；募集款进入独立资金池。' : 'Simulated titles and test assets. Eligibility and accepted terms are required; subscription funds enter a dedicated pool.'}</p>
      {!status?.active ? <p role="status">{zh ? '当前未连接可核验的受控融资实例。' : 'No verified controlled financing instance is connected.'}</p> : <>
        <p className="controlled-instance">{zh ? '协议实例' : 'Protocol instance'}: <code>{status.config.chainIdDecimal}:{status.config.contracts.RWAOfferingPool}</code></p>
        <p>{demo ? (zh ? '当前为 Demo；切换至 Live 后可准备钱包操作。' : 'Demo mode. Switch to Live before preparing a wallet action.') : (zh ? 'Live 测试网；每笔操作需钱包确认。' : 'Live testnet. Each action requires wallet confirmation.')}</p>
        <div className="controlled-actions"><button type="button" onClick={connect} disabled={busy}>{wallet ? `${wallet.slice(0, 8)}…${wallet.slice(-4)}` : (zh ? '连接 EVM 钱包' : 'Connect EVM wallet')}</button>
          <button type="button" onClick={() => { setReview(null); setError(''); setRefresh((n) => n + 1); }} disabled={busy}>{zh ? '刷新与对账' : 'Refresh and reconcile'}</button></div>
        {pending && <div className="controlled-pending"><p role="status">{zh ? '已保存待对账操作，暂停重复发送。' : 'A saved operation needs reconciliation. Repeated sending is paused.'} <button type="button" disabled={busy} onClick={reconcile}>{zh ? '核对原交易' : 'Reconcile original transaction'}</button></p>
          <label>{zh ? '原钱包交易哈希' : 'Original wallet transaction hash'} <input value={originalHash} onChange={(event) => setOriginalHash(event.target.value)} /></label>
          <button type="button" disabled={busy || !/^0x[a-fA-F0-9]{64}$/u.test(originalHash)} onClick={attachOriginal}>{zh ? '附加原交易并核对' : 'Attach and reconcile original transaction'}</button>
          {pending.status === 'draft' && <button type="button" disabled={busy} onClick={() => { localStorage.removeItem(storageKey()); setPending(null); setNotice(zh ? '已取消本地未广播草稿；审计记录保留。' : 'Local unbroadcast draft dismissed; audit history retained.'); }}>{zh ? '取消未广播草稿' : 'Dismiss unbroadcast draft'}</button>}
        </div>}
        <label className="controlled-shares">{zh ? '认购份额' : 'Subscription shares'} <input inputMode="numeric" value={shares} onChange={(event) => { setShares(event.target.value); setReview(null); }} /></label>
        <div className="controlled-table-wrap"><table><caption>{zh ? '链上资金池' : 'On-chain funding pools'}</caption><thead><tr><th>{zh ? '池与状态' : 'Pool and state'}</th><th>{zh ? '每份价格 / 兑付' : 'Price / redemption per share'}</th><th>{zh ? '募集 / 放款 / 回收' : 'Raised / disbursed / recovered'}</th><th>{zh ? '操作' : 'Actions'}</th></tr></thead>
          <tbody>{offers.map((offer) => <tr key={offer.pool_id}><td>#{offer.pool_id} · {stateLabel(offer.state)}<br />{offer.subscribed}/{offer.shares}<br />{zh ? '到期 ' : 'Maturity '}<time>{new Date(Number(offer.maturity) * 1000).toISOString().slice(0, 10)}</time></td>
            <td>{amount(offer.issue_price_atomic)} / {amount(offer.redemption_per_share_atomic)} TEST_USDC</td><td>{amount(offer.raised_atomic)} / {amount(offer.disbursed_atomic)} / {amount(offer.recovered_atomic)}</td>
            <td><div className="controlled-actions"><button type="button" disabled={busy || demo || !wallet || !offer.subscription_open || Boolean(pending)} onClick={() => setReview({ kind: 'acknowledge', offer })}>{zh ? '审阅并同意条款' : 'Review and accept terms'}</button>
              <button type="button" disabled={busy || demo || !wallet || !offer.subscription_open || Boolean(pending) || !/^[1-9]\d{0,8}$/u.test(shares)} onClick={() => setReview({ kind: 'subscribe', offer, shares })}>{zh ? '审阅认购' : 'Review subscription'}</button></div></td></tr>)}</tbody></table></div>
        {!offers.length && <p>{zh ? '此实例尚无发行。' : 'This instance has no offerings.'}</p>}
        {positions.map((position) => <div key={position.position_id} className="controlled-position"><p>#{position.chain_pool_id} · {stateLabel(position.chain_state ?? position.status)} · {zh ? '持有' : 'Shares'} {position.shares} · {zh ? '可领取' : 'Claimable'} {amount(position.claimable_atomic)} TEST_USDC · {position.reconciled ? (zh ? '已对账' : 'Reconciled') : (zh ? '对账中' : 'Reconciling')}</p>
          <p>{zh ? '实付 / 已领取 / 已退款' : 'Paid / claimed / refunded'}: {amount(position.cost_atomic)} / {amount(position.claimed_atomic)} / {amount(position.refunded_atomic)} TEST_USDC</p>
          <button type="button" disabled={busy || demo || Boolean(pending) || !position.reconciled || BigInt(position.shares) === 0n || !['Repaid', 'LossSettled'].includes(position.chain_state)} onClick={() => setReview({ kind: 'claim', position })}>{zh ? '审阅领取' : 'Review claim'}</button>
          <button type="button" disabled={busy || demo || Boolean(pending) || !position.reconciled || BigInt(position.shares) === 0n || !['Open', 'Subscribed', 'Repriced', 'Paused', 'Frozen', 'Cancelled', 'Liquidation'].includes(position.chain_state)} onClick={() => setReview({ kind: 'refund', position })}>{zh ? '审阅退款资格' : 'Review refund eligibility'}</button></div>)}
        {review && <section className="controlled-confirm" aria-label={zh ? '钱包操作确认' : 'Wallet action confirmation'}><p>{zh ? '操作' : 'Action'}: {({ acknowledge: zh ? '同意条款' : 'Accept terms', subscribe: zh ? '认购' : 'Subscribe', claim: zh ? '领取' : 'Claim', refund: zh ? '退款' : 'Refund' })[review.kind]} · #{review.offer?.pool_id ?? review.position.chain_pool_id}</p>
          {review.offer && <><p>{zh ? '条款承诺' : 'Terms commitment'}: <code>{review.offer.terms_hash}</code></p><p>{zh ? '报价版本' : 'Quote version'}: {review.offer.quote_version}</p></>}
          {review.kind === 'subscribe' && <p>{review.shares} × {amount(review.offer.issue_price_atomic)} = {amount(BigInt(review.shares) * BigInt(review.offer.issue_price_atomic))} TEST_USDC</p>}
          <p>{zh ? '资金进入上述池；本金与回报可能损失。结清后仍须单独领取；退款以链上募集条件为准。' : 'Funds enter the pool above. Principal and returns may be lost. Settlement requires a separate claim; refunds depend on chain funding conditions.'}</p>
          <button type="button" disabled={busy || demo} onClick={confirm}>{zh ? '确认并前往钱包' : 'Confirm and continue to wallet'}</button><button type="button" disabled={busy} onClick={() => setReview(null)}>{zh ? '取消' : 'Cancel'}</button></section>}
      </>}
      {busy && <p role="status">{zh ? '正在处理，请保留当前交易记录…' : 'Processing. Keep the current transaction record…'}</p>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status" className="controlled-notice">{notice}</p>}
    </details>
  </aside>;
}
