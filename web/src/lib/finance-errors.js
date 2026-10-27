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

// [zh, en]; `session: true` offers the identity check in the role workspace.
const COPY = Object.freeze({
  rights_session_required: { session: true, text: ['业务会话已过期或尚未验证。请在“融资方与审查人”工作台用登记钱包重新验证身份，然后重试。', 'Your business session has expired or was never verified. Verify your identity with the enrolled wallet in the borrower and reviewer workspace, then retry.'] },
  rights_challenge_invalid: { session: true, text: ['身份验证请求已过期，请重新发起验证。', 'The identity check expired. Start it again.'] },
  execution_context_changed: { text: ['会话、钱包或执行环境已变化，请重新审阅本次操作。', 'The session, wallet or execution context changed. Review this operation again.'] },
  controlled_intent_not_found: { session: true, text: ['当前钱包和身份找不到这笔操作。请确认连接的是登记钱包，并重新验证身份。', 'This wallet and identity have no such operation. Connect the enrolled wallet and verify your identity again.'] },
  operations_not_ready: { text: ['服务暂停接收新的融资操作，已有退出不受影响。请稍后重试。', 'The service is not accepting new financing actions right now; existing exits are unaffected. Retry later.'] },
  financing_terms_changed: { text: ['链上条款或报价已变化，请重新阅读最新条款。', 'The chain terms or quote changed. Read the latest terms again.'] },
  financing_disclosure_unverified: { text: ['条款与已发布版本不一致，已停止操作。', 'The terms differ from the published version, so the action stopped.'] },
  ACTION_REJECTED: { text: ['你在钱包中拒绝了请求，资金没有移动。', 'You rejected the request in your wallet. No funds moved.'] },
  REJECTED: { text: ['你在钱包中拒绝了请求，资金没有移动。', 'You rejected the request in your wallet. No funds moved.'] },
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
  TransferTaxNotSupported: { text: ['结算代币的实际到账金额与转账金额不符，已拒绝。', 'The settlement token delivered a different amount than sent, so it was refused.'] }
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

/** { message, session } for display; `session` means re-verifying the business identity may fix it. */
export function describeFinanceError(failure, zh) {
  const code = failure?.code === 4001 ? 'ACTION_REJECTED' : failure?.code;
  const key = COPY[code] ? code : revertName(failure);
  const entry = key ? COPY[key] : null;
  if (!entry) return { message: failure?.message ?? String(failure), session: false };
  return { message: entry.text[zh ? 0 : 1], session: Boolean(entry.session) };
}
