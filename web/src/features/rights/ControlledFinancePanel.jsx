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
import { ChainTime } from './ChainTime.jsx';

const amount = (v) => v == null ? '—' : `${BigInt(v) / 1000000n}.${(BigInt(v) % 1000000n).toString().padStart(6, '0')}`;
const SUBSCRIBABLE = ['Open', 'Subscribed', 'Repriced'];
// Why nobody can subscribe right now, in the order a reader should fix or understand it (src/rights/offerings.js).
const BLOCKERS = {
  legacy_instance: ['旧实例只退出', 'Legacy instance, exits only'], state_closed: ['当前状态不接受认购', 'State does not accept subscriptions'],
  deadline_passed: ['募集已截止', 'Subscription ended'], fully_subscribed: ['已募满', 'Fully subscribed'],
  intake_stopped: ['发行进件已暂停', 'Intake is stopped'], screening_expired: ['来源审查已过期', 'Screening has expired'],
  valuation_expired: ['估值已过期', 'Valuation has expired'], valuer_inactive: ['估值人权限已撤销', 'Valuer permission revoked'],
  title_inactive: ['单证已失效', 'Title is inactive'], asset_not_allowed: ['结算资产未获准', 'Settlement asset not allowed'],
  eligibility_unverified: ['认购条件未能核实', 'Subscription conditions could not be verified']
};
// Directory filters (src/rights/offerings.js): the server scans one snapshot forward, so a filtered page continues from its cursor.
const FILTERS = [['all', ['全部池', 'All pools']], ['open', ['可认购', 'Open to subscribe']], ['active', ['资金在池', 'Money in the pool']], ['closed', ['已结束或无人认购', 'Ended or never subscribed']]];
const CLAIMABLE_STATES = ['Repaid', 'LossSettled'], REFUNDABLE_STATES = ['Open', 'Subscribed', 'Repriced', 'Paused', 'Frozen', 'Cancelled', 'Liquidation'];
const canClaim = (position) => position.reconciled && CLAIMABLE_STATES.includes(position.chain_state) && BigInt(position.claimable_atomic ?? 0) > 0n;
const blockerTexts = (offer, zh) => (offer.subscription_blockers ?? []).filter((code) => code !== 'state_closed').map((code) => BLOCKERS[code]?.[zh ? 0 : 1] ?? code);
// Refunds burn shares but the pool keeps its historical subscribed count; a refunded raise must not read as held shares.
function progressText(offer, zh) {
  if (offer.state === 'Cancelled' && BigInt(offer.raised_atomic ?? 0) === 0n && BigInt(offer.subscribed) > 0n) return zh ? `0/${offer.shares}（${offer.subscribed} 份已全部退款）` : `0/${offer.shares} (${offer.subscribed} refunded)`;
  return `${offer.subscribed}/${offer.shares}`;
}
/** Where a default or liquidation stands and who may move it next. */
function ResolutionStatus({ offer, zh }) {
  const r = offer.resolution;
  if (!['Defaulted', 'Liquidation', 'LossSettled'].includes(offer.state)) return null;
  if (!r) return <div className="finance-resolution" role="note"><strong>{zh ? '处置进度' : 'Resolution'}</strong>
    <p>{zh ? '尚未公告处置方案。到期后，持有份额的出资人或融资方可在角色工作台“到期发起现金退出”，按已签条款进入有硬截止的现金处置。' : 'No resolution has been notified. After maturity, an investor holding shares or the borrower can start a cash exit in the role workspace, which follows the signed terms to a hard deadline.'}</p></div>;
  return <div className="finance-resolution" role="note"><strong>{zh ? '处置进度' : 'Resolution'}</strong>
    <dl><div><dt>{zh ? '通知期截止' : 'Notice ends'}</dt><dd><ChainTime value={r.notice_until} zh={zh} /></dd></div>
      <div><dt>{zh ? '硬截止' : 'Hard deadline'}</dt><dd><ChainTime value={r.hard_deadline} zh={zh} /></dd></div>
      <div><dt>{zh ? '状态' : 'Status'}</dt><dd>{r.finalized ? (zh ? '已终局' : 'Finalized') : [r.reviewed ? (zh ? '已独立复核' : 'Independently reviewed') : (zh ? '待独立复核' : 'Awaiting independent review'),
        r.disputed ? (zh ? '有未决异议' : 'Dispute pending') : r.dispute_used ? (zh ? '异议已处理' : 'Dispute resolved') : (zh ? '无异议' : 'No dispute')].join(' · ')}</dd></div></dl>
    {!r.finalized && <p>{r.cash_only_exit
      ? (zh ? '这是到期现金退出：硬截止后任何人可终局，按实际回收金额分配。' : 'This is a cash-only exit at maturity: anyone can finalize it after the hard deadline, distributing what was actually recovered.')
      : (zh ? '处置负责人提出、独立审查人复核且无异议时，通知期结束后可终局；否则硬截止后任何人可终局。通知期内持有份额者可在角色工作台提出一次异议。' : 'With the disposer’s notice reviewed and undisputed, it can be finalized when the notice ends; otherwise anyone can finalize it after the hard deadline. Shareholders can raise one dispute in the role workspace during the notice.')}</p>}
    {r.finalized && <p>{zh ? '已按实际回收结算，出资人在下方持仓中领取；迟到回款仍可再次领取。' : 'Settled on actual recovery. Investors claim below; later recoveries remain claimable.'}</p>}</div>;
}
/** What the pool needs next when it is not taking subscriptions. */
function stateGuidance(offer, zh) {
  if (offer.finalize_funding_available) return zh ? '募集期已结束且达到最低募集额：需先“关闭已达最低额的募集”（任一业务角色可在工作台操作，链上任何人可调用），之后才能放款。' : 'The raise ended above its minimum: it must be finalized first (any business role can do this in the workspace; anyone can on chain) before a draw.';
  if (offer.empty_expired) return zh ? '募集截止时无人认购。单证仍质押在资金池，需运营方在工作台“取消无人认购的发行”后释放。' : 'Nobody subscribed before the deadline. The title stays pledged until the operator cancels the offering in the workspace.';
  return ({ Funded: ['募集已完成，等待放款或回款。', 'Fully raised; awaiting the draw or repayment.'], InTransit: ['货物在途，等待回款与到货证明。', 'Cargo in transit; awaiting repayment and arrival evidence.'],
    Paused: ['发行已暂停。已有持仓可按条件退款或等待恢复。', 'Paused. Existing positions may refund under the conditions or wait for resumption.'], Frozen: ['资金池已冻结，等待治理处理。', 'Frozen pending governance.'],
    Repaid: ['已结清，出资人在下方持仓中领取。', 'Repaid. Investors claim in their positions below.'], Cancelled: ['已取消。仍有实付成本的出资人可在下方持仓中退款。', 'Cancelled. Investors with a remaining paid cost can refund in their positions below.'] })[offer.state]?.[zh ? 0 : 1] ?? null;
}
// Each wallet action says what it moves; a refund or claim must never read like a subscription.
function confirmationCopy(review, zh) {
  switch (review.kind) {
    case 'acknowledge': return zh ? '只在链上记录你同意上述条款与报价版本，不转移任何资金。之后仍需单独审阅认购；报价更新会使本次同意失效。' : 'Records on chain that you accept these terms and this quote version. No funds move. Review the subscription separately afterwards; a new quote voids this acceptance.';
    case 'subscribe': return zh ? '钱包会依次请求代币授权和认购。资金进入上述池；本金与回报可能损失。结清后仍须单独领取；募集失败时可按链上条件退款。' : 'Your wallet asks for a token approval and then the subscription. Funds enter the pool above; principal and returns may be lost. Settlement needs a separate claim; a failed raise can be refunded under the chain conditions.';
    case 'claim': return zh ? '把你在该池的可领取回款转入当前钱包。首次领取会销毁份额，之后的迟到回款仍可再次领取。' : 'Moves your claimable payments from this pool to this wallet. The first claim burns your shares; later recoveries remain claimable.';
    default: return zh ? '募集未成功或池已取消时，退回你的实付成本并销毁对应份额；链上会再次核对退款条件，不满足时不会转移资金。' : 'If the raise failed or the pool was cancelled, returns what you paid and burns those shares. The chain checks the refund conditions again; nothing moves if they are not met.';
  }
}
/**
 * What this wallet should look at first, from the positions already read: money it can claim, cancelled pools it can
 * refund from, a saved operation to reconcile, and every pool it holds. The full directory stays below.
 */
function MyTasks({ zh, positions, pending, busy, demo, onOpen, onClaim, onReconcile }) {
  const claimable = positions.filter(canClaim), refundable = positions.filter((position) => position.reconciled && position.chain_state === 'Cancelled' && BigInt(position.shares) > 0n);
  const pools = [...new Set(positions.map((position) => Number(position.chain_pool_id)))].sort((a, b) => a - b);
  return <section className="finance-tasks" aria-label={zh ? '与我有关' : 'For this wallet'}>
    <h2>{zh ? '与我有关' : 'For this wallet'}</h2>
    <ul>
      {pending && <li><strong>{zh ? '待核对原交易' : 'Reconcile the saved transaction'}</strong> <button type="button" aria-label={zh ? '核对原交易（与我有关）' : 'Reconcile original transaction (for this wallet)'} disabled={busy || !pending.intent_id} onClick={onReconcile}>{zh ? '核对原交易' : 'Reconcile original transaction'}</button></li>}
      {claimable.map((position) => <li key={`claim-${position.position_id}`}><strong>{zh ? '可领取' : 'Claimable'}</strong> #{position.chain_pool_id} · {amount(position.claimable_atomic)} TEST_USDC
        <button type="button" aria-label={`${zh ? '审阅领取' : 'Review claim'} #${position.chain_pool_id}`} disabled={busy || demo || Boolean(pending)} onClick={() => onClaim(position)}>{zh ? '审阅领取' : 'Review claim'}</button></li>)}
      {refundable.map((position) => <li key={`refund-${position.position_id}`}><strong>{zh ? '已取消，可退款' : 'Cancelled, refund available'}</strong> #{position.chain_pool_id}
        <button type="button" aria-label={`${zh ? '查看资金池' : 'Open pool'} #${position.chain_pool_id}`} disabled={busy} onClick={() => onOpen(Number(position.chain_pool_id))}>{zh ? '查看资金池' : 'Open pool'}</button></li>)}
      {!pending && !claimable.length && !refundable.length && <li>{zh ? '当前没有待你领取、退款或核对的事项。' : 'Nothing to claim, refund or reconcile right now.'}</li>}
    </ul>
    {pools.length > 0 && <p>{zh ? '持有份额的资金池' : 'Pools you hold'}: {pools.map((poolId) => <button key={poolId} type="button" className="finance-pool-link" disabled={busy} onClick={() => onOpen(poolId)}>#{poolId}</button>)}</p>}
  </section>;
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
  const openAfterRead = useRef(null);
  // Messages are kept language-neutral ([zh, en] pairs or the original failure) and localized at render, so a
  // language switch re-labels the panel without re-reading the chain or closing an open review.
  const pick = (message) => Array.isArray(message) ? message[zh ? 0 : 1] : message;
  // Codes and contract reverts become a localized next step; unknown failures keep their own message.
  const shownProblem = problem?.failure ? describeFinanceError(problem.failure, zh) : problem ? { message: pick(problem.message), session: false } : null;
  const error = shownProblem?.message ?? '';
  const setError = useCallback((message) => setProblem(message ? { message } : null), []);
  // `scope` is the pool whose detail started the action: its failure is shown there, next to the button.
  const fail = useCallback((failure, scope = null) => setProblem({ failure, scope }), []);
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
        const query = new URLSearchParams(Object.entries(page).filter(([key, value]) => key !== 'back' && !(key === 'status' && value === 'all')).map(([key, value]) => [key, String(value)]));
        const endpoint = page.pool_id ? `offerings/${page.pool_id}` : `offerings${page.from === 1 && !page.block_number && !query.has('status') ? '' : `?${query}`}`;
        const offerResponse = await fetch(`/api/controlled/${endpoint}`, { signal: abort.signal }), listing = await offerResponse.json();
        if (!offerResponse.ok) throw Object.assign(new Error(listing.error ?? 'Controlled offering read failed'), { code: listing.code });
        if (abort.signal.aborted) return; setOffers(listing.offerings); setListing(listing);
        if (openAfterRead.current != null && listing.offerings.some((offer) => offer.pool_id === openAfterRead.current)) setSelectedPool(openAfterRead.current);
        openAfterRead.current = null;
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
  // Pages keep the filter and the snapshot; a filtered page's previous cursor cannot be computed, so it is remembered.
  const filter = page.status ?? 'all';
  const navigate = (from, back = [...(page.back ?? []), page.from]) => { setReview(null); setPage({ from, status: filter, back, block_number: listing.snapshot.block_number, block_hash: listing.snapshot.block_hash }); };
  const previousPage = () => page.back?.length ? navigate(page.back.at(-1), page.back.slice(0, -1)) : navigate(Math.max(1, page.from - 10), []);
  const chooseFilter = (status) => { setReview(null); setSelectedPool(null); setPage({ from: 1, status }); };
  const openPool = (poolId) => { setReview(null); setLookup(String(poolId)); openAfterRead.current = poolId; setPage({ from: poolId, pool_id: poolId }); };
  const blockedReason = (offer) => demo ? (zh ? 'Demo 只读；Live 测试网操作需钱包逐次授权。' : 'Demo is read only; Live testnet actions require wallet approval.')
    : !wallet ? (zh ? '先连接钱包，再核对资格与条款。' : 'Connect a wallet, then verify eligibility and terms.')
    : pending ? (zh ? '先核对原交易，避免重复发送。' : 'Reconcile the original transaction before another send.')
    : !offer.subscription_open ? `${zh ? '当前不接受新认购' : 'New subscriptions are closed'}${blockerTexts(offer, zh).length ? `${zh ? '：' : ': '}${blockerTexts(offer, zh).join(zh ? '、' : ', ')}` : ''}${zh ? '。已有持仓仍可按条件退出。' : '. Existing positions retain their exits.'}`
    : (zh ? '下一步：完整阅读并同意条款，再审阅认购；链上仍核验资格与额度。' : 'Next: read and accept the full terms, then review a subscription. Eligibility and limits are checked on chain.');
  // A subscribable chain state is not an open subscription: the server closes it at the snapshot block's deadline or at full supply.
  const closedLabel = (offer) => offer.subscription_open !== false || !SUBSCRIBABLE.includes(offer.state) ? null
    : offer.finalize_funding_available ? (zh ? '待关闭募集' : 'Awaiting finalization')
    : offer.empty_expired ? (zh ? '零认购已截止' : 'Ended unsubscribed')
    : Number(offer.subscription_deadline) < Number(listing?.snapshot?.block_timestamp) ? (zh ? '募集已截止' : 'Subscription ended')
    : BigInt(offer.subscribed) >= BigInt(offer.shares) ? (zh ? '已募满' : 'Fully subscribed')
    : blockerTexts(offer, zh)[0] ?? (zh ? '不接受认购' : 'Not accepting subscriptions');
  const offerLabel = (offer) => closedLabel(offer) ?? stateLabel(offer.state);
  const storageKey = () => `agentbl.controlled-intent:${status.config.contracts.RWAOfferingPool.toLowerCase()}:${wallet.toLowerCase()}`;
  const onIntent = (intent) => { const value = { intent_id: intent.intent_id, operation: intent.operation }; localStorage.setItem(storageKey(), JSON.stringify(value)); setPending(value); };
  const connect = async () => { try { await connectWallet('metamask'); setError(''); } catch (failure) { fail(failure); } };
  // Accepting or subscribing needs terms that are current as well as intact; reading them only needs them intact.
  const currentTerms = async (offer) => {
    const pack = await verifyReadableTerms(await controlledRequest(`offerings/${offer.pool_id}/terms`), offer, status);
    if (pack.current?.ok === false) throw Object.assign(new Error('Terms are no longer current'), { code: 'financing_terms_changed', reasons: pack.current.reasons });
    return pack;
  };
  const startReview = async (kind, offer) => {
    reviewOpener.current = document.activeElement;
    const snapshot = { wallet: connectedAddress(), session: currentWalletSession(), generation: appStore.get().modeGeneration };
    setBusy(true); setReview(null); setTermsRead(false); setError('');
    try {
      const pack = await currentTerms(offer);
      const current = appStore.get();
      if (snapshot.wallet !== connectedAddress() || snapshot.session !== currentWalletSession() || snapshot.generation !== current.modeGeneration || current.demoMode) throw Object.assign(new Error('Wallet or mode changed. Review again.'), { code: 'CONTEXT_CHANGED' });
      setReview({ kind, offer, shares, pack, generation: snapshot.generation });
    } catch (failure) { fail(failure, offer.pool_id); } finally { setBusy(false); }
  };
  const readPublicTerms = async (offer) => {
    const version = readGeneration.current;
    setBusy(true); setError(''); setPublicTerms(null);
    try {
      const pack = await verifyReadableTerms(await controlledRequest(`offerings/${offer.pool_id}/terms`), offer, status, { history: true });
      if (version === readGeneration.current) setPublicTerms({ pool_id: offer.pool_id, pack });
    } catch (failure) { if (version === readGeneration.current) fail(failure, offer.pool_id); }
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
        if (selected.offer) await currentTerms(selected.offer);
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
        {/* One clear first step; the other paths are alternatives, not three equal calls to action. */}
        <div className="finance-start">
          <button type="button" className="finance-button-primary" onClick={() => setView('agent')}>{t('finance_start_demo')}</button>
          <span>{t('finance_start_demo_hint')}</span>
        </div>
        <p className="finance-paths-label">{t('finance_paths_label')}</p>
        <div className="finance-paths">
          {[['market', 'finance_path_market'], ['mint', 'finance_path_mint']].map(([view, key]) => (
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
        {wallet && !loading && (pending || positions.length > 0) && <MyTasks zh={zh} positions={positions} pending={pending} busy={busy} demo={demo} onOpen={openPool}
          onClaim={(position) => setReview({ kind: 'claim', position })} onReconcile={reconcile} />}
        <div className="finance-filters" role="group" aria-label={zh ? '按状态筛选资金池' : 'Filter pools by status'}>
          {FILTERS.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} disabled={busy || loading} onClick={() => chooseFilter(value)}>{label[zh ? 0 : 1]}</button>)}
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
            <div><dt>{zh ? '募集截止' : 'Subscription deadline'}</dt><dd><ChainTime value={offer.subscription_deadline} zh={zh} utc /></dd></div>
            <div><dt>{zh ? '放款截止' : 'Disbursement deadline'}</dt><dd><ChainTime value={offer.disbursement_deadline} zh={zh} utc /></dd></div>
            <div><dt>{zh ? '到期' : 'Maturity'}</dt><dd><ChainTime value={offer.maturity} zh={zh} utc /></dd></div>
            {offer.valuation_valid_until && <div><dt>{zh ? '估值有效至' : 'Valuation valid until'}</dt><dd><ChainTime value={offer.valuation_valid_until} zh={zh} utc /></dd></div>}
            <div><dt>{zh ? '进度' : 'Progress'}</dt><dd>{progressText(offer, zh)} {zh ? '份；实收与回款见下表。' : 'shares; actual cash amounts appear in the table.'}</dd></div>
            <div><dt>{zh ? '退出责任' : 'Cash exit'}</dt><dd>{zh ? '出资人自行退款或领取；融资方实际回款。处置与异议按已签条款执行。' : 'Investors refund or claim for themselves; the borrower sends actual repayments. Resolution and disputes follow the signed terms.'}</dd></div></dl>
          <p>{zh ? '目标兑付不是预测收益；可能损失本金。公开条款在每次钱包授权前独立核验。' : 'Target redemption is not a return forecast; principal may be lost. Full terms are independently checked before wallet authorization.'}</p>
          <ResolutionStatus offer={offer} zh={zh} />
          {!SUBSCRIBABLE.includes(offer.state) || offer.finalize_funding_available || offer.empty_expired ? stateGuidance(offer, zh) && <p className="finance-next-step" role="note">{stateGuidance(offer, zh)}</p> : <>
          <div className="finance-detail-actions">
        <label className="controlled-shares">{zh ? '认购份额' : 'Subscription shares'} <input inputMode="numeric" value={shares} onChange={(event) => { setShares(event.target.value); setReview(null); }} /></label>
          <div className="controlled-actions controlled-steps"><button type="button" disabled={busy || loading || demo || !wallet || !offer.subscription_open || Boolean(pending)} onClick={() => startReview('acknowledge', offer)}><span className="step-badge" aria-hidden="true">1</span>{zh ? '阅读并同意条款' : 'Read and accept terms'}</button>
          <button type="button" className="finance-button-primary" disabled={busy || loading || demo || !wallet || !offer.subscription_open || Boolean(pending) || !/^[1-9]\d{0,8}$/u.test(shares)} onClick={() => startReview('subscribe', offer)}><span className="step-badge" aria-hidden="true">2</span>{zh ? '审阅认购' : 'Review subscription'}</button></div></div>
          <p className="small muted">{zh ? '第 1 步只在链上记录你同意当前条款，不转移资金；报价更新后需要重新同意。第 2 步才会请求代币授权并认购。' : 'Step 1 only records on chain that you accept these terms; no funds move, and a new quote needs a new acceptance. Step 2 asks for the token approval and the subscription.'}</p></>}
          <button type="button" disabled={busy || loading} onClick={() => readPublicTerms(offer)}>{zh ? '只读查看完整条款' : 'Read full terms without signing'}</button>
          {problem?.scope === offer.pool_id && error && <p role="alert" className="finance-alert finance-alert-inline">{error}</p>}
          {publicTerms?.pool_id === offer.pool_id && <ReadableTerms pack={publicTerms.pack} zh={zh} />}
        </section>)}
        <div className="controlled-table-wrap" role="region" aria-label={zh ? '资金池表格，可横向滚动' : 'Funding pool table, scroll horizontally'} tabIndex={0}><table><caption className="sr-only">{zh ? '链上资金池' : 'On-chain funding pools'}</caption><thead><tr><th>{zh ? '池与状态' : 'Pool and state'}</th><th>{zh ? '每份实付 / 目标兑付' : 'Paid / target redemption per share'}</th><th>{zh ? '实际募集 / 放款 / 回收' : 'Actual raised / disbursed / recovered'}</th><th>{zh ? '操作' : 'Actions'}</th></tr></thead>
          <tbody>{offers.map((offer) => <tr key={offer.pool_id}><td>#{offer.pool_id} · <span className={`finance-state finance-state-${closedLabel(offer) ? 'closed' : String(offer.state).toLowerCase()}`}>{offerLabel(offer)}</span><br />{progressText(offer, zh)}<br />{zh ? '到期 ' : 'Maturity '}<ChainTime value={offer.maturity} zh={zh} dateOnly /></td>
            <td>{amount(offer.issue_price_atomic)} / {amount(offer.redemption_per_share_atomic)} TEST_USDC</td><td>{amount(offer.raised_atomic)} / {amount(offer.disbursed_atomic)} / {amount(offer.recovered_atomic)}</td>
            <td><button type="button" className="finance-pool-link" aria-label={`${zh ? '查看详情' : 'View details'} #${offer.pool_id}`} aria-expanded={selectedPool === offer.pool_id} aria-controls="funding-pool-detail" onClick={() => { detailOpener.current = document.activeElement; setSelectedPool(selectedPool === offer.pool_id ? null : offer.pool_id); }}>{zh ? '查看详情' : 'View details'} <span aria-hidden="true">{selectedPool === offer.pool_id ? '−' : '↑'}</span></button></td></tr>)}</tbody></table></div>
        {!offers.length && listing && listing.complete !== false && <p>{filter === 'all' ? (zh ? '此实例尚无发行。' : 'This instance has no offerings.')
          : listing.next_cursor ? (zh ? `扫描到 #${listing.next_cursor - 1} 仍未找到符合筛选的池，可继续下一页。` : `No matching pool up to #${listing.next_cursor - 1}; continue with the next page.`)
          : (zh ? '没有符合此筛选的池。' : 'No pool matches this filter.')}</p>}
        <nav className="finance-pagination" aria-label={zh ? '资金池分页与查找' : 'Funding pool pages and lookup'}>
          <span>{zh ? '当前范围' : 'Current range'}: {!listing?.total_pools ? '—' : page.pool_id ? `#${page.pool_id}` : filter !== 'all' ? `${zh ? '已扫描' : 'scanned'} #${page.from}–#${(listing.next_cursor ?? listing.total_pools + 1) - 1}` : `${page.from}–${Math.min(page.from + 9, listing.total_pools)}`} / {listing?.total_pools ?? '—'}</span>
          <div className="controlled-actions"><button type="button" disabled={busy || loading || !listing?.snapshot || (!page.pool_id && page.from === 1)} onClick={() => navigate(1, [])}>{zh ? '首页' : 'First page'}</button>
          <button type="button" disabled={busy || loading || !listing?.snapshot || Boolean(page.pool_id) || (page.from ?? 1) <= 1} onClick={previousPage}>{zh ? '上一页' : 'Previous page'}</button>
          <button type="button" disabled={busy || loading || !listing?.next_cursor || !listing?.snapshot} onClick={() => navigate(listing.next_cursor)}>{zh ? '下一页' : 'Next page'}</button>
          <button type="button" disabled={busy || loading || !listing?.snapshot || !listing?.total_pools || filter !== 'all' || (!page.pool_id && !listing.next_cursor)} onClick={() => navigate(Math.floor((listing.total_pools - 1) / 10) * 10 + 1, [])}>{zh ? '末页' : 'Last page'}</button></div>
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
          <button type="button" disabled={busy || demo || Boolean(pending) || !position.reconciled || (BigInt(position.shares) === 0n && BigInt(position.claimable_atomic ?? 0) === 0n) || !CLAIMABLE_STATES.includes(position.chain_state)} onClick={() => setReview({ kind: 'claim', position })}>{zh ? '审阅领取' : 'Review claim'}</button>
          <button type="button" disabled={busy || demo || Boolean(pending) || !position.reconciled || BigInt(position.shares) === 0n || !REFUNDABLE_STATES.includes(position.chain_state)} onClick={() => setReview({ kind: 'refund', position })}>{zh ? '审阅退款资格' : 'Review refund eligibility'}</button></div>)}
        {review && <section ref={confirmation} tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setReview(null); }} className="controlled-confirm" aria-label={zh ? '钱包操作确认' : 'Wallet action confirmation'}><p>{zh ? '操作' : 'Action'}: {({ acknowledge: zh ? '同意条款' : 'Accept terms', subscribe: zh ? '认购' : 'Subscribe', claim: zh ? '领取' : 'Claim', refund: zh ? '退款' : 'Refund' })[review.kind]} · #{review.offer?.pool_id ?? review.position.chain_pool_id}</p>
          {review.offer && <><p>{zh ? '条款承诺' : 'Terms commitment'}: <code>{review.offer.terms_hash}</code></p><p>{zh ? '报价版本' : 'Quote version'}: {review.offer.quote_version}</p></>}
          {review.pack && <><ReadableTerms pack={review.pack} zh={zh} /><label><input type="checkbox" checked={termsRead} onChange={(event) => setTermsRead(event.target.checked)} />{zh ? '我已核对责任主体、截止、零费、损失及退出条款' : 'I reviewed the parties, deadlines, zero fees, losses and exit terms'}</label></>}
          {review.kind === 'subscribe' && <p>{review.shares} × {amount(review.offer.issue_price_atomic)} = {amount(BigInt(review.shares) * BigInt(review.offer.issue_price_atomic))} TEST_USDC</p>}
          {review.kind === 'subscribe' && <p className="small muted">{zh ? '同一钱包在同一资金池最多可分 32 次认购（合约上限）；较少、较大的认购可避免达到上限。' : 'One wallet can subscribe to a pool in at most 32 separate lots (a contract limit); fewer, larger subscriptions avoid reaching it.'}</p>}
          <p>{confirmationCopy(review, zh)}</p>
          {review.kind === 'claim' && <p>{zh ? '本次可领取' : 'Claimable now'}: {amount(review.position.claimable_atomic)} TEST_USDC</p>}
          {review.kind === 'refund' && <p>{zh ? '退回实付成本' : 'Cost to return'}: {amount(review.position.cost_atomic)} TEST_USDC</p>}
          <button type="button" disabled={busy || demo || (Boolean(review.offer) && !termsRead)} onClick={confirm}>{zh ? '确认并前往钱包' : 'Confirm and continue to wallet'}</button><button type="button" disabled={busy} onClick={() => setReview(null)}>{zh ? '取消' : 'Cancel'}</button></section>}
      </>}
      {busy && <p role="status">{zh ? '正在处理，请保留当前交易记录…' : 'Processing. Keep the current transaction record…'}</p>}
      {error && !(problem?.scope != null && problem.scope === selectedPool) && <p role="alert" className="finance-alert">{error}{shownProblem.session && status?.active && <> <button type="button" className="finance-inline-action" onClick={verifyIdentity}>{zh ? '重新验证身份' : 'Verify identity again'}</button></>}</p>}{notice && <p role="status" className="controlled-notice">{notice}</p>}
    </details>
  </aside>;
}
