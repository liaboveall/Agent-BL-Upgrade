// Failures reach the financing panel from three places: the API (a stable `code`), the wallet (EIP-1193 4001,
// ethers ACTION_REJECTED or a web3.js code) and contract reverts (a 4-byte custom-error selector; the app ABI
// carries no error fragments). Known ones become a sentence in the reader's language that says what happened
// and what to do next. Anything else keeps its original message, so nothing is hidden.

const REVERT_NAMES = Object.freeze({
  '0xf8eb54de': 'NotEligible',
  '0xaee4c2bc': 'SubscriptionDeadlineElapsed',
  '0xddafad98': 'NotOpen',
  '0x2d573a55': 'ExceedsSupply',
  '0xc5c21493': 'QuoteVersionChanged',
  '0x9abb50fa': 'PriceAboveUserLimit',
  '0x60c6d188': 'UserDeadlineElapsed',
  '0x3742d1f6': 'NotRefundable',
  '0x2eb35430': 'DeadlineNotPassed',
  '0x8dfbde27': 'RaiseSucceeded',
  '0x70bc8fea': 'FundingAlreadyFinalized',
  '0xf76aef65': 'NothingToRefund',
  '0x6247a84e': 'NotClaimable',
  '0xb317087b': 'NoShares',
  '0x90b8ab88': 'InsufficientEscrow',
  '0xbf4e9a8d': 'LotLimit',
  '0x4763c4eb': 'EmergencyStopped',
  '0xdaec864b': 'TransferTaxNotSupported'
});

// [zh, en]; `session: true` offers the identity check in the role workspace. `funds` says what may have happened to
// money: 'none' (nothing was sent, or the chain refused before any transfer) or 'check' (a transaction may be out:
// reconcile the original before anything else).
const COPY = Object.freeze({
  rights_session_required: { session: true, text: ['业务会话已过期或尚未验证。请在“融资方与审查人”工作台用登记钱包重新验证身份，然后重试。', 'Your business session has expired or was never verified. Verify your identity with the enrolled wallet in the borrower and reviewer workspace, then retry.'] },
  rights_challenge_invalid: { session: true, text: ['身份验证请求已过期，请重新发起验证。', 'The identity check expired. Start it again.'] },
  execution_context_changed: { text: ['会话、钱包或执行环境已变化，请重新审阅本次操作。', 'The session, wallet or execution context changed. Review this operation again.'] },
  controlled_intent_not_found: { session: true, text: ['当前钱包和身份找不到这笔操作。请确认连接的是登记钱包，并重新验证身份。', 'This wallet and identity have no such operation. Connect the enrolled wallet and verify your identity again.'] },
  operations_not_ready: { text: ['服务暂停接收新的融资操作，已有退出不受影响。请稍后重试。', 'The service is not accepting new financing actions right now; existing exits are unaffected. Retry later.'] },
  financing_terms_changed: { text: ['链上条款或报价已变化，请重新阅读最新条款。', 'The chain terms or quote changed. Read the latest terms again.'] },
  financing_disclosure_unverified: { text: ['条款与已发布版本不一致，已停止操作。', 'The terms differ from the published version, so the action stopped.'] },
  ACTION_REJECTED: { funds: 'none', text: ['你在钱包中拒绝了请求，资金没有移动。', 'You rejected the request in your wallet. No funds moved.'] },
  REJECTED: { funds: 'none', text: ['你在钱包中拒绝了请求，资金没有移动。', 'You rejected the request in your wallet. No funds moved.'] },
  // A transaction left the wallet but its outcome is not known yet.
  subscription_reconciliation_required: { funds: 'check', text: ['交易已发出，但还没有确认结果（可能仍在打包，也可能失败）。请用“核对原交易”查看结论，不要重复发送。', 'The transaction was sent but its outcome is not confirmed yet (still pending, or failed). Use “Reconcile original transaction” for the result; do not send again.'] },
  claim_reconciliation_required: { funds: 'check', text: ['领取交易已发出，但还没有确认结果。请用“核对原交易”查看结论，不要重复发送。', 'The claim was sent but its outcome is not confirmed yet. Use “Reconcile original transaction” for the result; do not send again.'] },
  RECONCILIATION_REQUIRED: { funds: 'check', text: ['退款交易已发出，但还没有确认结果。请用“核对原交易”查看结论，不要重复发送。', 'The refund was sent but its outcome is not confirmed yet. Use “Reconcile original transaction” for the result; do not send again.'] },
  wallet_reconciliation_required: { funds: 'check', text: ['此钱包还有一笔没有结论的操作，为避免重复付款，新的发送已暂停。请先核对原交易；如果钱包确实没有发出，可选择“钱包没有发送，释放记录”。', 'This wallet has an operation without an outcome, so new sends are paused to avoid paying twice. Reconcile the original first; if the wallet really did not send it, choose “The wallet did not send it: release”.'] },
  released_operation_mined: { funds: 'check', text: ['你此前报告“钱包未发送”的操作实际已上链。请先核对持仓，确认是否还要再操作一次。', 'An operation you reported as not sent was mined after all. Check your positions before deciding to do it again.'] },
  transaction_pending: { funds: 'check', text: ['原交易仍在等待打包，不能释放。可在钱包中加速或取消它，打包后再核对。', 'The original transaction is still pending, so it cannot be released. Speed it up or cancel it in the wallet, then reconcile once it is mined.'] },
  wallet_nonce_pending: { funds: 'check', text: ['钱包里有一笔使用相同 nonce 的待处理交易。等它打包后先核对原交易，再重新操作。', 'A pending wallet transaction uses the saved nonce. Once it is mined, reconcile the original before trying again.'] },
  wallet_nonce_reserved: { funds: 'check', text: ['已释放的操作仍预留着 nonce，请先核对原交易再发送。', 'A released operation still reserves its nonce. Reconcile the original before sending.'] },
  intent_state_conflict: { text: ['这笔操作的状态刚刚变化，请刷新后再核对。', 'The state of this operation just changed. Refresh and reconcile again.'] },
  CONTEXT_CHANGED: { text: ['钱包或运行模式已变化，请重新审阅。', 'The wallet or mode changed. Review again.'] },
  WALLET_CHANGED: { text: ['钱包已切换，请用当前钱包重新审阅。', 'The wallet changed. Review again with the current wallet.'] },
  INTENT_CHANGED: { text: ['保存的操作与当前条款不一致，已停止发送。请重新审阅。', 'The saved operation no longer matches the terms, so nothing was sent. Review again.'] },
  QUOTE_CHANGED: { text: ['报价版本已更新，请重新同意条款后再认购。', 'The quote version changed. Accept the terms again before subscribing.'] },
  NotEligible: { text: ['链上资格核验未通过：钱包未登记、资格或审查已过期，或尚未完成第 1 步“阅读并同意条款”。', 'The chain eligibility check failed: the wallet is not enrolled, its eligibility or screening expired, or step 1 (accept the terms) is not done.'] },
  SubscriptionDeadlineElapsed: { text: ['认购已截止。', 'The subscription period has ended.'] },
  NotOpen: { text: ['该池当前不接受认购。', 'This pool is not accepting subscriptions.'] },
  ExceedsSupply: { text: ['认购份额超过剩余额度，请减少份额。', 'These shares exceed what is left. Subscribe fewer shares.'] },
  QuoteVersionChanged: { text: ['报价版本已更新，请重新同意条款后再认购。', 'The quote version changed. Accept the terms again before subscribing.'] },
  PriceAboveUserLimit: { text: ['链上价格高于你审阅时的价格，已拒绝成交。', 'The chain price is above the one you reviewed, so the subscription was refused.'] },
  UserDeadlineElapsed: { text: ['审阅已超时，请重新审阅。', 'Your review timed out. Review again.'] },
  NotRefundable: { text: ['当前状态不能退款。', 'Refunds are not available in this state.'] },
  DeadlineNotPassed: { text: ['认购截止前不能退款。', 'Refunds open after the subscription deadline.'] },
  RaiseSucceeded: { text: ['募集已成功，不能退款；请等待结清后领取。', 'The raise succeeded, so there is no refund. Claim after settlement.'] },
  FundingAlreadyFinalized: { text: ['募集已确认，不能退款；请等待结清后领取。', 'Funding is final, so there is no refund. Claim after settlement.'] },
  NothingToRefund: { text: ['此钱包在该池没有可退款的成本。', 'This wallet has nothing to refund in this pool.'] },
  NotClaimable: { text: ['该池尚未结清，暂不能领取。', 'This pool is not settled yet, so nothing can be claimed.'] },
  NoShares: { text: ['此钱包在该池没有可领取的份额或回款。', 'This wallet has no shares or payments to claim in this pool.'] },
  InsufficientEscrow: { text: ['池内托管余额不足，已停止领取。请联系运营方核对。', 'The pool escrow is short, so the claim stopped. Ask the operator to reconcile.'] },
  LotLimit: { text: ['此钱包在该池的分次认购已达上限（32 段），请联系运营方。', 'This wallet reached the limit of 32 separate subscriptions in this pool. Contact the operator.'] },
  EmergencyStopped: { text: ['资金池处于紧急停止状态。', 'The pool is under an emergency stop.'] },
  TransferTaxNotSupported: { text: ['结算代币的实际到账金额与转账金额不符，已拒绝。', 'The settlement token delivered a different amount than sent, so it was refused.'] },
  // Server codes from the controlled financing and rights routes.
  financing_disclosure_missing: { text: ['这个资金池的完整条款暂时无法读取，请不要签名。稍后重试，或请运营方提供已批准的条款。', 'The full terms of this pool cannot be read right now, so do not sign. Retry later or ask the operator for the approved terms.'] },
  financing_review_required: { text: ['条款或报价已更新，请重新阅读完整条款后再操作。', 'The terms or the quote changed. Read the full terms again before continuing.'] },
  rights_not_configured: { text: ['此服务未配置身份与条款存储，暂时无法读取完整条款，也不能发起业务操作。', 'This service has no identity and terms store configured, so it cannot show the full terms or start business actions.'] },
  rights_vault_missing: { text: ['服务的身份与条款存储不可用，已停止新的操作。请联系运营方恢复。', 'The identity and terms store of this service is unavailable, so new actions are stopped. Ask the operator to restore it.'] },
  rights_vault_busy: { text: ['服务正忙，请稍后重试。', 'The service is busy. Retry shortly.'] },
  rights_plan_busy: { text: ['保存的操作刚刚发生变化，请重试。', 'The saved operation changed just now. Retry.'] },
  legacy_exit_only: { text: ['这是旧版本实例，只保留退款、领取等既有退出操作。', 'This is a superseded instance; only existing exits such as refunds and claims remain.'] },
  rights_legacy_exit_only: { text: ['这是旧版本实例，只保留退款、领取等既有退出操作。', 'This is a superseded instance; only existing exits such as refunds and claims remain.'] },
  live_mode_required: { text: ['钱包操作只能在 Live 模式下发起。', 'Wallet actions can only start in Live mode.'] },
  controlled_instance_unavailable: { text: ['此服务未配置受控测试网实例。', 'No controlled testnet instance is configured on this service.'] },
  rights_chain_unavailable: { text: ['链上实例核验未通过或暂不可用，已停止操作。请稍后重试。', 'The on-chain instance could not be verified right now, so the action stopped. Retry later.'] },
  rights_chain_not_configured: { text: ['链上实例核验未通过或暂不可用，已停止操作。请稍后重试。', 'The on-chain instance could not be verified right now, so the action stopped. Retry later.'] },
  rpc_read_unavailable: { text: ['链上读取暂时不完整，请重试；缺失的数据不代表余额为零。', 'Chain reads are incomplete right now. Retry; missing data is not a zero balance.'] },
  rpc_read_timeout: { text: ['链上读取超时，请重试。', 'A chain read timed out. Retry.'] },
  rpc_read_busy: { text: ['链上读取排队已满，请稍后重试。', 'Too many chain reads are queued. Retry shortly.'] },
  chain_reconciliation_required: { text: ['链上快照已变化（可能发生重组），请刷新后重试。', 'The chain snapshot changed (possibly a reorganization). Refresh and retry.'] },
  controlled_pool_not_found: { text: ['此实例中没有这个资金池。', 'This instance has no such funding pool.'] },
  quote_changed: { text: ['价格、报价版本或剩余份额已变化，请重新审阅。', 'The price, quote version or remaining shares changed. Review again.'] },
  invalid_deadline: { text: ['认购截止已过，或审阅超过 15 分钟，请重新审阅。', 'The subscription deadline passed or the review is older than 15 minutes. Review again.'] },
  pool_unavailable: { text: ['该资金池当前不接受此钱包认购（状态、资格或额度不符）。', 'This pool is not accepting a subscription from this wallet now (state, eligibility or remaining shares).'] },
  position_not_claimable: { text: ['此持仓目前没有可领取的金额。', 'This position has nothing to claim right now.'] },
  intent_transaction_mismatch: { text: ['这笔交易与保存的操作不一致，未被记入。', 'This transaction does not match the saved operation, so it was not recorded.'] },
  nonce_consumed_by_other_transaction: { funds: 'check', text: ['保存的 nonce 已被另一笔交易使用。请在钱包中核对，确认没有重复付款。', 'Another transaction used the saved nonce. Check your wallet and confirm nothing was paid twice.'] },
  manual_reconciliation_required: { text: ['无法自动找到原交易。请在下方填写原钱包交易哈希后核对。', 'The original transaction could not be found automatically. Enter its wallet transaction hash below to reconcile.'] },
  rights_manual_reconciliation_required: { text: ['无法自动找到原交易。请填写原钱包交易哈希后核对。', 'The original transaction could not be found automatically. Enter its wallet transaction hash to reconcile.'] },
  rights_preflight_failed: { text: ['链上状态或权限拒绝了这笔操作，未发送任何交易。', 'The chain state or permissions reject this operation; nothing was sent.'] },
  rights_role_required: { text: ['当前业务身份没有这项操作的权限。', 'Your business identity is not allowed to do this.'] },
  rights_material_archived: { text: ['这份材料已过保留期并归档，只能阅读，不能再追加证据、审核或发起操作。', 'This material is archived after its retention period. It can be read, but no evidence, review or action can be added.'] },
  rights_material_expired: { text: ['这份材料的归档期已结束，已不再保存。', 'This material’s archive period has ended and it is no longer kept.'] },
  identity_lookup_invalid: { text: ['身份查找请求已过期或签名不属于当前钱包，请重新查找。', 'The identity lookup expired or the signature is not from this wallet. Look up again.'] },
  // Controller require() reasons an investor can meet.
  'terms changed': { text: ['链上条款或报价版本已变化，请重新阅读并同意最新条款。', 'The chain terms or quote version changed. Read and accept the latest terms again.'] },
  'invalid acceptance expiry': { text: ['同意有效期无效（已过期或晚于募集截止），请重新审阅。', 'The acceptance expiry is invalid (past, or after the subscription deadline). Review again.'] }
});

const hexData = (value) => typeof value === 'string' && /^0x[0-9a-f]{8}/iu.test(value) ? value.slice(0, 10).toLowerCase() : null;

/** The custom-error name in a failed call or transaction, or null. */
export function revertName(failure) {
  const candidates = [failure?.data, failure?.error?.data, failure?.info?.error?.data, failure?.error?.data?.data, failure?.revert?.selector];
  for (const candidate of candidates) {
    const selector = hexData(candidate);
    if (selector && REVERT_NAMES[selector]) return REVERT_NAMES[selector];
  }
  return failure?.revert?.name ?? null;
}

// Why signed terms no longer accept new operations (src/rights/financingReview.js `current.reasons`).
const TERMS_REASONS = Object.freeze({
  legacy_exit_only: ['旧版本实例只保留退出', 'superseded instance, exits only'], offering_changed: ['链上发行价格或份额已与签署条款不同', 'the on-chain price or supply differs from the signed terms'],
  holder_changed: ['单证持有人已变更', 'the title holder changed'], governance_changed: ['治理地址已变更', 'governance changed'], valuer_changed: ['估值人已变更', 'the valuer changed'],
  issuer: ['签发方', 'issuer'], operator: ['放款运营方', 'operator'], valuer: ['估值方', 'valuer'], compliance: ['资格审查方', 'compliance'], disposer: ['处置提议方', 'disposer'], reviewer: ['处置审核方', 'reviewer']
});
/** The reasons as one localized phrase, e.g. "the valuer's role was revoked; the title holder changed". */
export function termsReasons(reasons, zh) {
  return (reasons ?? []).map((reason) => {
    const role = /^(\w+)_revoked$/u.exec(reason)?.[1];
    if (role && TERMS_REASONS[role]) return zh ? `签约角色“${TERMS_REASONS[role][0]}”已被撤销` : `the ${TERMS_REASONS[role][1]} role was revoked`;
    return TERMS_REASONS[reason]?.[zh ? 0 : 1] ?? reason;
  }).join(zh ? '；' : '; ');
}

const FUNDS = Object.freeze({
  none: ['资金：没有移动。', 'Funds: nothing moved.'],
  check: ['资金：可能已有交易发出，请先核对原交易，不要重复发送。', 'Funds: a transaction may be out. Reconcile the original first; do not send again.']
});
/**
 * { message, session, funds } for display; `session` means re-verifying the business identity may fix it, `funds`
 * (when known) says in one line whether money could have moved. A contract revert before sending moved nothing.
 */
export function describeFinanceError(failure, zh) {
  const code = failure?.code === 4001 ? 'ACTION_REJECTED' : failure?.code;
  const reason = failure?.reason ?? failure?.revert?.args?.[0];
  const reverted = revertName(failure);
  const key = [code, reverted, reason].find((candidate) => typeof candidate === 'string' && Object.hasOwn(COPY, candidate)) ?? null;
  const entry = key ? COPY[key] : null;
  const fundsKey = entry?.funds ?? (failure?.txHash ? 'check' : reverted ? 'none' : null);
  const funds = fundsKey ? FUNDS[fundsKey][zh ? 0 : 1] : null;
  if (!entry) return { message: failure?.message ?? String(failure), session: false, funds };
  const detail = termsReasons(failure?.reasons ?? failure?.details?.reasons, zh);
  return { message: detail ? `${entry.text[zh ? 0 : 1]}${zh ? '原因：' : ' Reason: '}${detail}${zh ? '。' : '.'}` : entry.text[zh ? 0 : 1], session: Boolean(entry.session), funds };
}
