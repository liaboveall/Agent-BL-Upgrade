# 首次远端 CI 的问题与修复

首次提交为 `50eedb8f1706a9227058b3049381f7d397e7304c`，对应 [CI 39035730890](https://github.com/liaboveall/Agent-BL-Upgrade/actions/runs/39035730890)。十个作业中八项通过，Linux Node 22 和 Windows Node 22 的应用测试分别失败一项。两个原始作业日志归档为 `ci-39035730890-linux-node22.log` 和 `ci-39035730890-windows-node22.log`，不以重跑掩盖该结果。

Linux 的链监听器测试把初始化与挂起的 `getLogs` 合计限制在真实时间 30ms 内。繁忙 runner 可能在创建游标前超时，随后测试错误地解引用空游标。现用可控 `Date`/`setTimeout`，等待目标请求实际进入后再推进同样的 30ms；分别验证初始上下文挂起时游标仍为空、已有游标后的日志挂起不改变快照。两种情况都要求无新增观察、保留原游标且链安全状态未知，不修改生产超时逻辑。

Windows 的失败暴露 Wave B 真实执行问题：W1 新增的定价有效期在每次 `buildPlan()` 时按当前秒重新生成，初始化、签名前复核、最终读取之间跨秒就会误报 `plan_changed` 或最终状态不匹配。同次 CLI 执行现在只生成一次有效期，后续计划继续读取最新价格、报价版本和决策序号，同时复用该有效期；链状态变化仍拒绝发送，静态调用和合约有效期检查仍执行。测试替身改为核对实际已审阅计划的全部参数。

专项回归结果：

- 链监听器：Windows Node 26.8.1 与 Linux Node 22.23.3 各 56/56。
- Wave B：两平台各 14/14，包含时间推进五秒后有效期及决策 ID 保持一致、价格变化仍在发送前拒绝的用例。
- 对首次提交的旧实现运行新增的跨秒用例，按预期复现 `plan_changed`，见 `wave-b-expiry-before-fix-reproduction.log`；测试结束后立即恢复修复源码。
- 修复后 `npm run lint`、`npm run check` 均通过。

`ci-fix-source-manifest.json` 按暂存区 Git blob 记录 524 个输入，与首次提交清单相比仅四个源码/测试文件变化：`src/chain/waveBGate.js`、`scripts/wave-b-gate.mjs`、`tests/agentChainWatcher.test.js`、`tests/waveBGate.test.js`。证据文件哈希另见 `ci-fix-evidence-manifest.json`。

此记录在修复提交前写入；完整应用、覆盖率、合约、EVM/HTTP、浏览器和容器回归还需由修复提交对应的全新 CI 运行确认。所有本地测试使用注入的离线接口或隔离链，没有发送真实交易。
