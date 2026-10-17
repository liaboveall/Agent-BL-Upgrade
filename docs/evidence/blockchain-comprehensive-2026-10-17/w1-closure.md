# W1 关闭记录（A01–A08、A10）

日期：2026-10-17，Asia/Singapore。范围：报告第 11 部分 W1；A09 与 W2–W5 不在本轮。

状态说明：以下条目为 **IMPLEMENTED**（本地源码与正式回归），不是 **VERIFIED**。A01/A02/A05/A06/A07/A08 与 A10 的事件/ABI 变更都需要独立审查和**新的链上部署**；已部署 v3 地址的行为未改变。本轮没有广播交易、迁移旧资产或重写历史回执。

## 交付摘要

| ID | 设计 | 主要文件 | 正式回归 |
|---|---|---|---|
| A01 | `recordLiquidationRecovery` 逐笔记录回收；`resolveLiquidation` 为唯一收尾：足额→`Repaid`，不足→`LossSettled`，无认购者→`Cancelled`；收尾前不释放质押 | `hardhat/contracts/RWAOfferingPool.sol` | `hardhat/test/protocolV4.test.js`（部分 / 足额 / 零回收 / 无认购者 / 重复收尾） |
| A02 | Frozen 显式出口：无认购者取消、足额核验后结算、到期欠款违约、有证据解冻；Frozen 仍可录入迟到回收 | `RWAOfferingPool.sol`、`src/agent/runtime/poolRules.js` | `protocolV4.test.js`、`offeringModel.test.js` 随机模型 |
| A03 | `Defaulted` / `Frozen` 下允许 `RECORD_PAYMENT`、`RECORD_ADDITIONAL_PAYMENT`、`RECORD_ARRIVAL`、`SETTLE`；`markDefault` / `settleLoss` / `resolveLiquidation` / `unfreezeOffering` 仍为人工 owner 操作 | `poolRules.js`、`settlementPipeline.js`、`chainExecutor.js`、`ownerTxPlan.js` | `tests/w1CrossLayer.test.js` |
| A04 | 多笔回收逐笔核验：按 `(tx_hash, log_index)` 去重、独立核对资产/付款方/收款方/金额/规范区块，汇总必须等于链上累计值且包含首笔证明；新增 `RECORD_ADDITIONAL_PAYMENT` 计划 | `src/agent/pipelines/settlementPipeline.js`、`ownerTxPlan.js` | `w1CrossLayer.test.js`（两笔成功、重复、总额不符、首笔缺失） |
| A05 | `createOfferingWithTerms` 原子绑定 `maturityAt` 与 `subscriptionDeadline`；开盘计划使用报价 tenor；`setMaturity` 发 `OfferingTermsSet`，缩短期限同时缩短截止 | `RWAOfferingPool.sol`、`src/agent/runtime/openingPlan.js` | `protocolV4.test.js`、`tests/agentOpening.test.js` |
| A06 | 每个池保存 `subscriptionDeadline`，所有认购入口在链上检查；截止/期限不一致的创建被拒绝 | `RWAOfferingPool.sol` | `protocolV4.test.js`（截止秒成功、下一块失败）、随机模型 |
| A07 | Oracle 报价要求 `expectedQuoteVersion`、`validUntil`（≤30 天）和严格递增 `decisionSeq`；decision id 绑定 `chainId + oracle + pool`；执行器和 MCP 从链读取并持久化前置条件 | `RiskPricingOracle.sol`、`src/core/oracle.js`、`chainExecutor.js`、`src/mcp/tools.js` | `protocolV4.test.js`（过期/超远/版本/重放/乱序）、`agentExecutors.test.js` |
| A08 | `subscribeWithTerms` 原子检查 `maxUnitPrice`、`expectedQuoteVersion`、用户与协议截止；浏览器在 v4 地址使用该入口，v3 地址明确返回 `termsBound=false` | `RWAOfferingPool.sol`、`web/src/lib/web3.js` | `protocolV4.test.js`（价格/版本/截止漂移与调价后旧版本） |
| A10 | 冻结不再发 `OfferingPaused`；新增 terms/deadline/frozen/unfrozen/default/loss/additional-recovery/liquidation 事件并纳入 watcher；文档区分已部署 v3 与本地 v4；ABI 合并仅用于计划/核验，不声称已部署 | `docs/contracts.md`、`src/chain/protocolV4Abi.js`、`chainWatcher.js`、`liveSmokeVerification.js` | `w1CrossLayer.test.js`、`agentChainWatcher.test.js`、`agentLiveSmoke.test.js` |

## 验证命令与结果

```text
npm --prefix hardhat test
  -> 102 passing

node --test --test-concurrency=2 tests/w1CrossLayer.test.js tests/agentExecutors.test.js \
  tests/agentLiveSmoke.test.js tests/agentSettlement.test.js tests/agentOpening.test.js \
  tests/waveBGate.test.js tests/contractParity.test.js tests/docsConsistency.test.js \
  tests/oracle.test.js tests/agentApprovals.test.js tests/agentChainWatcher.test.js
  -> 182 passing

npm run lint      -> clean (eslint . --max-warnings=0)
npm run build     -> vite production build succeeded
npm run check     -> check passed
```

未运行：完整 1311 项 Node 套件、Chromium、远程 CI、负载/灾备、真实提供方和真实链上闭环。上述结果只支持本地 v4 候选的实现结论。

## 部署与恢复边界

1. v4 不是代理升级。需要冻结源码与 artifact、独立审查、干净重建、部署新的 `RWAOfferingPool` / `RiskPricingOracle` 并重新生成 `public/chain-config.json` 的 ABI 与地址。
2. 旧 v3 池、旧资产、旧审批和旧回执保留在原地址；不得以新 Registry 重铸旧提单，也不得把旧 `poolId` 含义带到新地址。
3. 历史 v3 的 6 参数 `updatePricing` 回执仍通过 `legacy` 决策域核验；新回执使用 9 参数域名。
4. A09（Live 持仓统一视图）仍为 OPEN，属于 W2。资金托管、募集/退款/兑付、证据与运营门槛未在本轮实现。

## 逐项关闭记录（供 issue-register 引用）

- A01：改动 `RWAOfferingPool.sol`；回归 `protocolV4.test.js`；剩余边界：新部署与处置权利的链下证据。
- A02：改动 `RWAOfferingPool.sol`、`poolRules.js`；回归 `protocolV4.test.js`、`offeringModel.test.js`；剩余边界：新部署与争议流程定义。
- A03：改动 `poolRules.js`、`settlementPipeline.js`、`chainExecutor.js`、`ownerTxPlan.js`；回归 `w1CrossLayer.test.js`、`agentSettlement.test.js`；无需新部署。
- A04：改动 `settlementPipeline.js`、`ownerTxPlan.js`；回归 `w1CrossLayer.test.js`；无需新部署。
- A05：改动 `RWAOfferingPool.sol`、`openingPlan.js`；回归 `protocolV4.test.js`、`agentOpening.test.js`；剩余边界：期限起点的业务确认与新部署。
- A06：改动 `RWAOfferingPool.sol`；回归 `protocolV4.test.js`；剩余边界：新部署。
- A07：改动 `RiskPricingOracle.sol`、`oracle.js`、`chainExecutor.js`、`mcp/tools.js`；回归 `protocolV4.test.js`、`agentExecutors.test.js`；剩余边界：新 Oracle/Pool 部署与 ABI 同步。
- A08：改动 `RWAOfferingPool.sol`、`web/web3.js`；回归 `protocolV4.test.js`；剩余边界：新部署；接入付款腿时需联合验收。
- A10：改动 `docs/contracts.md`、`protocolV4Abi.js`、`chainWatcher.js`、`liveSmokeVerification.js`；回归 `w1CrossLayer.test.js`、`agentChainWatcher.test.js`、`agentLiveSmoke.test.js`；剩余边界：v4 部署后重新生成配置并复验。
