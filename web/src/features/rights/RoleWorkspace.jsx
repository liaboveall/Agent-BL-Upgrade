import { useEffect, useRef, useState } from 'react';
import { appStore } from '../../state/app-store.js';
import { useApp } from '../../state/hooks.js';
import { connectedAddress, currentWalletSession, loadEthers } from '../../lib/web3.js';
import { clearRightsSession, openRightsSession, rightsRequest, rightsSessionToken } from '../../lib/rights-session.js';
import { describeFinanceError } from '../../lib/finance-errors.js';
import { sendRightsPlan } from '../../lib/rights.js';
import { ReadableTerms } from './ReadableTerms.jsx';
import { toAtomic, toUnixSeconds } from '../../lib/units.js';

const labels = {
  investor_wallet: ['待批准出资钱包', 'Investor wallet to approve'], subjectHash: ['主体身份承诺', 'Subject identity commitment'], distribution_hash: ['分配方案承诺', 'Distribution commitment'], quote_version: ['报价版本', 'Quote version'],
  eblId: ['单证登记编号', 'Registered title ID'], exporter: ['固定融资收款方', 'Fixed borrower recipient'], feeRecipient: ['费用收款方（本版零费）', 'Fee recipient (zero fees)'], supply: ['份额上限', 'Share supply'], issuePrice: ['每份实付原子金额', 'Price per share (atomic)'], target: ['每份目标原子金额', 'Target per share (atomic)'], minRaise: ['最低募集原子金额', 'Minimum raise (atomic)'], maturity: ['债务到期（Unix秒）', 'Maturity (Unix seconds)'], subscribeUntil: ['募集截止（Unix秒，含）', 'Subscription deadline (Unix seconds, inclusive)'], disburseUntil: ['放款截止（Unix秒，不含）', 'Disbursement deadline (Unix seconds, exclusive)'], maxFee: ['费用上限原子金额', 'Fee cap (atomic)'], policyHash: ['退出政策承诺', 'Exit policy commitment'], disclosureHash: ['完整条款承诺', 'Complete disclosure commitment'],
  operation: ['操作', 'Action'], pool_id: ['资金池编号', 'Funding pool'], amount_atomic: ['精确原子金额', 'Exact atomic amount'], chain_id: ['网络编号', 'Network ID'],
  wallet: ['授权钱包', 'Authorizing wallet'], destination: ['调用合约', 'Contract called'], recipient: ['资金收款方', 'Funds recipient'], settlement_asset: ['测试结算资产', 'Test settlement asset'],
  material_id: ['材料编号', 'Material ID'], revision: ['材料版本', 'Material revision'], terms_hash: ['条款承诺', 'Terms commitment'], evidence_hash: ['材料承诺', 'Evidence commitment'],
  title_contents: ['虚构单证内容', 'Fictional title contents'], asset: ['测试代币', 'Test token'], spender: ['额度使用合约', 'Allowance spender'],
  assetKey: ['稳定资产承诺', 'Stable asset commitment'], documentHash: ['单证材料承诺', 'Title material commitment'], issuerOrg: ['签发主体承诺', 'Issuer organization commitment'],
  termsHash: ['条款承诺', 'Terms commitment'], settlementAsset: ['测试结算资产', 'Test settlement asset'], netValue: ['研究净处置值（原子）', 'Research net disposal value (atomic)'],
  coverageBps: ['研究覆盖率（基点）', 'Research coverage (bps)'], valuedAt: ['估值时间（Unix秒）', 'Valuation time (Unix seconds)'], validUntil: ['授权截止（Unix秒）', 'Authorization deadline (Unix seconds)'],
  previousHash: ['前序单证承诺', 'Previous title commitment'], nonce: ['一次性授权编号', 'One-time authorization nonce'],

  issuer: ['签发主体', 'Issuer'], holder: ['单证持有人 / 融资方', 'Holder / borrower'], investor: ['出资人', 'Investor'], reviewer: ['独立审查人', 'Independent reviewer'],
  compliance: ['资格审查人', 'Compliance'], operator: ['融资运营方', 'Operator'], custodian: ['托管运营方', 'Custodian'], valuer: ['研究估值人', 'Valuer'], attestor: ['回款证明人', 'Attestor'], disposer: ['处置负责人', 'Disposer'], governance: ['治理', 'Governance'],
  document: ['建立私有单证', 'Create private title'], title: ['签发与登记', 'Issue and register'], terms: ['完整条款与独立审核', 'Terms and independent review'], consent: ['持有人同意质押', 'Holder consent'],
  issue: ['发行融资', 'Create offering'], eligibility: ['资格与来源核验', 'Eligibility and screening'], fund: ['审阅、同意与认购', 'Review, accept and subscribe'], draw: ['固定收款人放款', 'Disburse to fixed borrower'],
  repay: ['回款或有界处置', 'Repayment or bounded resolution'], exit: ['退款 / 独立领取', 'Refund / independent claim'],
  complete: ['已完成', 'Complete'], pending: ['待处理', 'Pending'], unknown: ['尚未核验', 'Not verified'], check_each_investor: ['逐位核对资格', 'Check each investor'], claim_available: ['可独立领取', 'Claim available'], check_refund_or_wait: ['核对退款条件或等待结清', 'Check refund conditions or wait'],
  create_material: ['保存研究单证', 'Save research title'], disclosure: ['导入完整条款', 'Import complete terms'], review_material: ['批准当前单证与条款', 'Approve current title and terms'], publish: ['发布已审条款', 'Publish approved terms'],
  register_title: ['登记已签单证', 'Register signed title'], pledge: ['同意本池质押', 'Consent to this pledge'], create_offering: ['发行已审融资', 'Create approved offering'],
  disburse: ['放款', 'Disburse'], repay_action: ['回款', 'Repay'], approve_repayment: ['批准精确回款额度', 'Approve exact repayment allowance'], set_eligibility: ['核准出资钱包', 'Approve investor eligibility'], refresh_screening: ['更新来源审查', 'Refresh screening'],
  mark_in_transit: ['记录发运', 'Record departure'], record_payment: ['记录回款证明', 'Record payment evidence'], record_arrival: ['记录到货证明', 'Record arrival evidence'], settle: ['正常结清', 'Settle repayment'],
  notify_resolution: ['公告处置', 'Notify resolution'], review_resolution: ['独立审核处置', 'Review resolution'], finalize_resolution: ['终局现金分配', 'Finalize cash distribution'], start_exit: ['到期发起现金退出', 'Start cash exit'], dispute_resolution: ['提交一次异议', 'Submit one dispute'],
  sign_issuance: ['钱包签发单证', 'Sign title issuance'], sign_valuation: ['钱包签署估值', 'Sign valuation']
};
const actions = [
  ['create_material', ['issuer']], ['disclosure', ['issuer']], ['review_material', ['reviewer']], ['publish', ['issuer']],
  ['sign_issuance', ['issuer']], ['register_title', ['issuer']], ['pledge', ['holder']], ['sign_valuation', ['valuer']], ['create_offering', ['issuer']],
  ['set_eligibility', ['compliance']], ['refresh_screening', ['compliance']], ['disburse', ['operator', 'custodian']], ['approve_repayment', ['holder']], ['repay_action', ['holder']],
  ['mark_in_transit', ['operator', 'custodian']], ['record_payment', ['attestor']], ['record_arrival', ['attestor']], ['settle', ['operator', 'custodian']],
  ['notify_resolution', ['disposer', 'custodian']], ['review_resolution', ['reviewer']], ['start_exit', ['holder', 'investor', 'reviewer', 'custodian']],
  ['dispute_resolution', ['holder', 'investor', 'reviewer']], ['finalize_resolution', ['holder', 'investor', 'reviewer', 'custodian']]
];
const atomic = (value) => `${BigInt(value ?? 0) / 1000000n}.${(BigInt(value ?? 0) % 1000000n).toString().padStart(6, '0')}`;
const subjectKey = (wallet) => `agentbl.rights-subject:${wallet.toLowerCase()}`;
function exportJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RoleWorkspace({ zh, status, wallet }) {
  const generation = useApp((s) => s.modeGeneration), demo = useApp((s) => s.demoMode), text = (key) => labels[key]?.[zh ? 0 : 1] ?? key;
  const [subjectId, setSubjectId] = useState(''), [principal, setPrincipal] = useState(null), [materials, setMaterials] = useState([]), [materialId, setMaterialId] = useState(''), [workflow, setWorkflow] = useState(null);
  const [operation, setOperation] = useState(''), [file, setFile] = useState(null), [documentText, setDocumentText] = useState(''), [amountText, setAmountText] = useState(''), [evidence, setEvidence] = useState(''), [distribution, setDistribution] = useState('');
  const [investorWallet, setInvestorWallet] = useState(''), [validUntilLocal, setValidUntilLocal] = useState(''), [plan, setPlan] = useState(null), [pending, setPending] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const viewContext = useRef(null), selectedMaterial = useRef('');
  // People enter TEST_USDC and a local date-time; the exact atomic amount and Unix seconds are derived and shown.
  const amount = toAtomic(amountText), validUntil = toUnixSeconds(validUntilLocal);
  const [approved, setApproved] = useState(false), [originalHash, setOriginalHash] = useState('');
  viewContext.current = { wallet, generation, materialId, operation, file, amount, evidence, distribution, investorWallet, validUntil, documentText };
  const capture = () => { const saved = { ...viewContext.current }; return () => { if (!Object.entries(saved).every(([name, value]) => viewContext.current[name] === value)) throw new Error('Wallet, mode, material or action changed. Review again.'); }; };
  const key = status?.active && wallet ? `agentbl.role-plan:${status.config.chainIdDecimal}:${status.config.contracts.RWAOfferingPool.toLowerCase()}:${wallet.toLowerCase()}` : null;
  // A new wallet, mode generation or protocol instance ends the business session and every preview built on it.
  // The display language is not part of that identity: switching it keeps the session, materials and inputs.
  useEffect(() => {
    selectedMaterial.current = ''; clearRightsSession(); setPrincipal(null); setMaterials([]); setWorkflow(null); setPlan(null); setApproved(false); setOperation(''); setFile(null);
    try { setPending(key ? JSON.parse(localStorage.getItem(key) ?? 'null') : null); } catch { setPending({ invalid: true }); }
  }, [wallet, generation, key]);
  // The enrolled identity ID is not a credential (login still needs the wallet's signature); remember it per wallet.
  useEffect(() => {
    let saved = null;
    try { saved = wallet ? localStorage.getItem(subjectKey(wallet)) : null; } catch {}
    setSubjectId(saved ?? '');
  }, [wallet]);
  // The reviewer confirmed the preview as it read in the previous language; ask for that one confirmation again.
  useEffect(() => { setApproved(false); }, [zh]);
  const run = async (work) => { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (failure) { setError(failure); } finally { setBusy(false); } };
  const reload = async () => { setMaterials((await rightsRequest('materials')).materials); if (materialId) setWorkflow(await rightsRequest(`materials/${materialId}/workflow`)); };
  const login = (exitOnly = false) => run(async () => { const value = await openRightsSession(subjectId, { exitOnly }); setPrincipal(value);
    try { localStorage.setItem(subjectKey(wallet), subjectId); } catch {} setMaterials(value.exit_only ? [] : (await rightsRequest('materials')).materials); });
  const chooseMaterial = (id) => { selectedMaterial.current = id; setMaterialId(id); setWorkflow(null); setPlan(null); setApproved(false); if (id) run(async () => { const result = await rightsRequest(`materials/${id}/workflow`); if (selectedMaterial.current === id && rightsSessionToken()) setWorkflow(result); }); };
  const pack = workflow?.disclosure;
  const inputFor = () => {
    if (['register_title', 'create_offering'].includes(operation)) {
      if (!file) throw new Error(zh ? '请导入对应的签署材料文件。' : 'Import the corresponding signed package.');
      return { operation, material_id: materialId, payload: operation === 'create_offering' ? { ...file, terms: pack?.terms } : file };
    }
    if (!workflow) throw new Error(zh ? '请先选择材料。' : 'Choose a material first.');
    if (operation === 'pledge') return { operation, material_id: materialId, terms_hash: workflow.terms_hash, valid_until: pack.terms.subscribeUntil, payload: { ebl_id: pack.terms.eblId } };
    return { operation: operation === 'repay_action' ? 'repay' : operation, pool_id: String(workflow.pool_id ?? ''), material_id: materialId,
      ...(['disburse', 'repay_action', 'settle', 'record_payment', 'notify_resolution'].includes(operation) ? { amount_atomic: amount } : {}),
      ...(evidence ? { evidence_hash: evidence } : {}), ...(distribution ? { distribution_hash: distribution } : {}),
      ...(['set_eligibility', 'refresh_screening'].includes(operation) ? { valid_until: validUntil } : {}),
      ...(operation === 'set_eligibility' ? { payload: { wallet: investorWallet, subject_hash: file?.subject_hash } } : {}) };
  };
  const prepare = () => run(async () => {
    const assertContext = capture();
    setPlan(null); setApproved(false);
    if (!rightsSessionToken()) throw new Error(zh ? '业务会话已失效，请重新验证角色。' : 'Business session expired. Verify your role again.');
    if (operation === 'create_material') {
      if (!documentText.trim()) throw new Error(zh ? '请填写虚构研究单证。' : 'Enter a fictional research title.');
      setPlan({ local: operation, preview: { title_contents: documentText }, input: { material: { research_title: documentText }, public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 30, terms_hash: `0x${'00'.repeat(32)}`, risk_flags: ['simulated_title', 'test_asset', 'capital_at_risk'] } } }); return;
    }
    if (['disclosure', 'review_material', 'publish'].includes(operation)) {
      if (operation === 'disclosure' && !file) throw new Error(zh ? '请导入完整公开条款文件。' : 'Import the complete public terms file.');
      const input = operation === 'disclosure' ? (() => { const { schema: _schema, policy: _policy, ...value } = file.document ?? file; return value; })() : file;
      const disclosurePreview = operation === 'disclosure' ? await rightsRequest(`materials/${materialId}/financing-disclosure-preview`, input) : pack;
      assertContext();
      setPlan({ local: operation, preview: { material_id: materialId, revision: workflow?.revision, documentHash: workflow?.document_hash,
        terms_hash: disclosurePreview?.terms_hash ?? workflow?.terms_hash }, disclosurePreview, input }); return;
    }
    if (operation.startsWith('sign_')) {
      if (!file) throw new Error(zh ? '请导入待签研究材料。' : 'Import the research signing package.');
      const signing = await rightsRequest(`materials/${materialId}/signing-request`, { kind: operation === 'sign_issuance' ? 'issuance' : 'valuation', value: file });
      assertContext(); setPlan({ signing, preview: signing.value }); return;
    }
    if (operation === 'approve_repayment') {
      if (!pack || !/^[1-9]\d*$/u.test(amount)) throw new Error(zh ? '请核对测试资产和金额（最多 6 位小数）。' : 'Check the test asset and a positive amount (up to six decimals).');
      setPlan({ allowance: true, preview: { asset: pack.terms.settlementAsset, spender: status.config.contracts.RWAOfferingPool, amount_atomic: amount } }); return;
    }
    const saved = await rightsRequest('transaction-plans', inputFor());
    assertContext(); setPlan(saved); const recovery = { plan_id: saved.plan_id, status: 'draft' }; localStorage.setItem(key, JSON.stringify(recovery)); setPending(recovery);
  });
  const confirm = () => run(async () => {
    const assertContext = capture();
    const selected = plan, session = currentWalletSession(), token = rightsSessionToken(), mode = appStore.get().modeGeneration;
    const assertCurrent = () => { assertContext(); if (!token || token !== rightsSessionToken() || session !== currentWalletSession() || mode !== appStore.get().modeGeneration || demo || connectedAddress()?.toLowerCase() !== principal.wallet) throw new Error('Wallet, role or mode changed. Review again.'); };
    assertCurrent();
    if (selected.local) {
      const route = selected.local === 'create_material' ? 'materials' : `materials/${materialId}/${({ disclosure: 'financing-disclosure', review_material: 'review', publish: 'publish' })[selected.local]}`;
      const body = selected.local === 'review_material' ? { document_hash: workflow.document_hash, terms_hash: workflow.terms_hash } : selected.input ?? {};
      const result = await rightsRequest(route, body); assertCurrent();
      if (selected.local === 'disclosure') await rightsRequest(`materials/${materialId}/terms`, { terms_hash: result.terms_hash });
      setNotice(zh ? '材料操作已记录。' : 'Material action recorded.'); await reload();
    } else if (selected.signing) {
      const { domain, types, value, kind } = selected.signing; const signature = await session.signer.signTypedData(domain, types, value); assertCurrent();
      exportJson(kind === 'issuance' ? { issuance: value, signature } : { valuation: value, valuer: principal.wallet, signature }, `research-${kind}-signed.json`);
      setNotice(zh ? '已导出签署材料；尚未发送链上交易。' : 'Signed package exported. No chain transaction sent.');
    } else if (selected.allowance) {
      const { Contract } = await loadEthers(), network = await session.signer.provider.getNetwork(); assertCurrent();
      if (Number(network.chainId) !== status.config.chainIdDecimal) throw new Error('Wallet network changed');
      const asset = new Contract(selected.preview.asset, ['function approve(address,uint256) returns(bool)'], session.signer);
      const tx = await asset.approve(selected.preview.spender, selected.preview.amount_atomic); await tx.wait(status.config.confirmations ?? 1);
      setNotice(`${zh ? '额度回执' : 'Allowance receipt'}: ${tx.hash}`);
    } else {
      const result = await sendRightsPlan(selected, { session, ethersFn: loadEthers, assertCurrent,
        beforeBroadcast: async (value) => { const checked = await rightsRequest(`transaction-plans/${value.plan_id}/broadcast`, {}); const recovery = { plan_id: value.plan_id, status: checked.status }; localStorage.setItem(key, JSON.stringify(recovery)); setPending(recovery); return checked; },
        attachTransaction: (id, hash) => rightsRequest(`transaction-plans/${id}/transaction`, { tx_hash: hash }) });
      setNotice(`${zh ? '原交易状态' : 'Original transaction status'}: ${result.status} · ${result.tx_hash}`);
      if (result.status === 'confirmed') { localStorage.removeItem(key); setPending(null); }
      await reload();
    }
    setPlan(null); setApproved(false);
  });
  const recover = () => run(async () => {
    if (originalHash) await rightsRequest(`transaction-plans/${pending.plan_id}/transaction`, { tx_hash: originalHash });
    const result = await rightsRequest(`transaction-plans/${pending.plan_id}`);
    setNotice(`${zh ? '原交易状态' : 'Original transaction status'}: ${result.status} · ${result.tx_hash ?? '—'}`);
    if (['confirmed', 'reverted'].includes(result.status)) { localStorage.removeItem(key); setPending(null); }
    else { const saved = { plan_id: result.plan_id, status: result.status }; localStorage.setItem(key, JSON.stringify(saved)); setPending(saved); }
  });
  return <section className="role-workspace" aria-label={zh ? '融资角色工作台' : 'Financing role workspace'}>
    <h3>{zh ? '融资角色工作台' : 'Financing role workspace'}</h3>
    <p>{zh ? '虚构铜货物 · Singapore → Shanghai · 六位小数测试代币。先验证已登记业务角色，再逐项审阅与钱包授权。' : 'Fictional copper · Singapore → Shanghai · six-decimal test assets. Verify an enrolled role, then review each action and authorize it in your wallet.'}</p>
    {!principal ? <><label>{zh ? '管理员发放的业务身份编号' : 'Enrolled business identity ID'} <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} /></label><button type="button" disabled={busy || !wallet || !/^[a-f0-9-]{36}$/u.test(subjectId)} onClick={() => login()}>{zh ? '用当前钱包验证角色' : 'Verify role with this wallet'}</button><button type="button" disabled={busy || !wallet || !/^[a-f0-9-]{36}$/u.test(subjectId)} onClick={() => login(true)}>{zh ? '仅验证既有退款与领取' : 'Verify existing refunds and claims only'}</button></> : <>
      {principal.exit_only && <p role="status">{zh ? '仅退出会话：业务身份撤销不会取消已有退款与领取。请在下方持仓操作；本会话不能读取私有材料或增加风险。' : 'Exit-only session: revoked enrollment does not cancel existing refunds or claims. Use positions below; this session cannot read private material or add risk.'}</p>}
      <p>{principal.organization} · {principal.roles.map(text).join(' / ')} · <code>{principal.wallet}</code></p><button type="button" onClick={() => { clearRightsSession(); setPrincipal(null); setWorkflow(null); setMaterials([]); setPlan(null); }}>{zh ? '退出业务会话' : 'Sign out of business session'}</button>
      <label>{zh ? '本组织材料' : 'Organization materials'} <select value={materialId} onChange={(e) => chooseMaterial(e.target.value)}><option value="">{zh ? '选择材料' : 'Choose material'}</option>{materials.map((m) => <option key={m.material_id} value={m.material_id}>{m.material_id} · v{m.revision}</option>)}</select></label>
      {workflow && <><p className="role-next" role="status">{zh ? '你的待办' : 'Your next steps'}: {workflow.steps.filter((step) => step.assigned_to_you && step.status !== 'complete').map((step) => text(step.id)).join(' → ') || (zh ? '当前没有分配给你的待办；可核对下方责任与条件。' : 'No action is currently assigned to you. Check responsibilities and conditions below.')}</p><p>{zh ? '当前独立审批' : 'Current independent approvals'}: {workflow.approvals ?? 0}/2 · {workflow.published ? (zh ? '已发布当前版本' : 'Current revision published') : (zh ? '当前版本尚未发布' : 'Current revision unpublished')}</p><ol>{workflow.steps.map((step) => <li key={step.id}><strong>{text(step.id)}</strong> · {step.roles.map(text).join(' / ')} · {text(step.status)}{step.assigned_to_you && ` · ${zh ? '你的职责' : 'Your responsibility'}`}</li>)}</ol>
        {workflow.warning && <p role="alert">{zh ? '流程信息不完整，请核对材料或重试链上查询。' : 'Workflow information is incomplete. Check the material or retry chain reads.'}</p>}
        {workflow.snapshot && <p>{zh ? '规范区块' : 'Canonical block'} #{workflow.snapshot.block_number} · <code>{workflow.snapshot.block_hash}</code></p>}
        {pack && <ReadableTerms pack={{ ...pack, pool_id: workflow.pool_id }} zh={zh} />}</>}
      <p>{zh ? '认购、退款和独立领取在下方资金池与持仓中办理。角色登记不替代链上权限；每项操作准备时会重新检查。' : 'Use the funding pools and positions below for subscriptions, refunds and independent claims. Enrolled roles also require current on-chain permission, checked when preparing each action.'}</p>
      {pending && <div role="status"><p>{zh ? '已保存操作，先核对原交易。' : 'Saved operation: reconcile the original transaction first.'} {pending.plan_id}</p><label>{zh ? '原钱包交易哈希（可选）' : 'Original wallet hash (optional)'} <input value={originalHash} onChange={(e) => setOriginalHash(e.target.value)} /></label><button type="button" disabled={busy || pending.invalid} onClick={recover}>{zh ? '核对原操作' : 'Reconcile original operation'}</button>{pending.status === 'draft' && <button type="button" disabled={busy} onClick={() => { localStorage.removeItem(key); setPending(null); setPlan(null); }}>{zh ? '取消未广播预览' : 'Dismiss unbroadcast preview'}</button>}</div>}
      <label>{zh ? '本次操作' : 'Next action'} <select value={operation} onChange={(e) => { setOperation(e.target.value); setPlan(null); setApproved(false); setFile(null); }}><option value="">{zh ? '选择操作' : 'Choose action'}</option>{actions.filter(([, roles]) => roles.some((role) => principal.roles.includes(role))).map(([name]) => <option key={name} value={name}>{text(name)}</option>)}</select></label>
      {operation === 'create_material' ? <label>{zh ? '虚构研究单证内容' : 'Fictional research title contents'} <textarea value={documentText} onChange={(e) => { setDocumentText(e.target.value); setPlan(null); }} /></label> : <>
        {['register_title', 'create_offering', 'disclosure', 'sign_issuance', 'sign_valuation', 'set_eligibility'].includes(operation) && <label>{zh ? '研究材料文件（JSON）' : 'Research package file (JSON)'} <input type="file" accept="application/json,.json" onChange={(e) => { const selected = e.target.files[0]; setPlan(null); setApproved(false); run(async () => { if (!selected) return; if (selected.size > 1048576) throw new Error('File exceeds 1 MiB'); setFile(JSON.parse(await selected.text())); }); }} /></label>}
        {['disburse', 'repay_action', 'approve_repayment', 'settle', 'record_payment', 'notify_resolution'].includes(operation) && <><label>{zh ? '金额（TEST_USDC，最多 6 位小数）' : 'Amount (TEST_USDC, up to 6 decimals)'} <input inputMode="decimal" aria-describedby="role-amount-exact" value={amountText} onChange={(e) => { setAmountText(e.target.value); setPlan(null); }} /></label>
          <small id="role-amount-exact" className="role-exact">{amount ? `= ${amount} ${zh ? '原子单位（链上精确值）' : 'atomic units (exact on-chain value)'}` : amountText ? (zh ? '请输入大于 0、最多 6 位小数的金额' : 'Enter an amount above 0 with at most six decimals') : (zh ? '1 TEST_USDC = 1,000,000 原子单位' : '1 TEST_USDC = 1,000,000 atomic units')}</small></>}
        {['disburse', 'mark_in_transit', 'record_payment', 'record_arrival', 'notify_resolution', 'review_resolution', 'dispute_resolution', 'set_eligibility', 'refresh_screening'].includes(operation) && <label>{zh ? '审查材料承诺' : 'Evidence commitment'} <input value={evidence} onChange={(e) => { setEvidence(e.target.value); setPlan(null); }} /></label>}
        {operation === 'notify_resolution' && <label>{zh ? '分配方案承诺' : 'Distribution commitment'} <input value={distribution} onChange={(e) => { setDistribution(e.target.value); setPlan(null); }} /></label>}
        {operation === 'set_eligibility' && <label>{zh ? '待审查出资钱包' : 'Investor wallet to approve'} <input value={investorWallet} onChange={(e) => { setInvestorWallet(e.target.value); setPlan(null); }} /></label>}
        {['set_eligibility', 'refresh_screening'].includes(operation) && <><label>{zh ? '有效截止（本地时间）' : 'Valid until (local time)'} <input type="datetime-local" aria-describedby="role-valid-exact" value={validUntilLocal} onChange={(e) => { setValidUntilLocal(e.target.value); setPlan(null); }} /></label>
          <small id="role-valid-exact" className="role-exact">{validUntil ? `= Unix ${validUntil} · ${new Date(Number(validUntil) * 1000).toISOString().replace('.000Z', 'Z')}` : (zh ? '链上以 Unix 秒记录' : 'Recorded on chain in Unix seconds')}</small></>}
      </>}
      <button type="button" disabled={busy || demo || !operation || Boolean(pending) || operation !== 'create_material' && !materialId} onClick={prepare}>{zh ? '准备可读预览' : 'Prepare readable preview'}</button>
      {plan && <section className="controlled-confirm" aria-label={zh ? '角色操作预览' : 'Role action preview'}><h4>{text(operation)}</h4>{plan.disclosurePreview && <ReadableTerms pack={plan.disclosurePreview} zh={zh} />}<dl>{Object.entries(plan.preview ?? {}).filter(([, value]) => value != null).map(([name, value]) => <div key={name}><dt>{text(name)}</dt><dd><code>{name === 'operation' ? text(value) : String(value)}</code></dd></div>)}</dl>
        {plan.preview?.amount_atomic && <p>{atomic(plan.preview.amount_atomic)} TEST_USDC</p>}
        <p>{zh ? '授权仅针对以上身份、实例、材料版本和本次操作。研究签名不证明真实货物或偿付能力。' : 'Authorization applies to the identity, instance, material revision and action above. Research signatures do not prove real cargo or repayment capacity.'}</p>
        <label><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />{zh ? '我已核对本次预览' : 'I reviewed this action'}</label>
        <button type="button" disabled={busy || !approved || demo} onClick={confirm}>{zh ? '确认本次操作' : 'Confirm this action'}</button><button type="button" disabled={busy} onClick={() => setPlan(null)}>{zh ? '关闭预览' : 'Close preview'}</button></section>}
    </>}
    {pending?.invalid && <p role="alert">{zh ? '原操作记录损坏，请保留钱包记录并人工核对。' : 'Saved operation is corrupt. Keep the wallet record for manual reconciliation.'}</p>}
    {error && <p role="alert">{describeFinanceError(error, zh).message}</p>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">{zh ? '正在核验…' : 'Verifying…'}</p>}
  </section>;
}
