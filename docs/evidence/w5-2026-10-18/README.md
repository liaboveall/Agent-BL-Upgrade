# W5 交付验收证据

验收范围是研究 / 受控 Injective 测试网应用，真实业务门槛关闭。实际时间以 UTC 收据为准，目录日期为新加坡批次日期。

最终技术源码 SHA-256：`725d539245e2d75d30c67df136234dff570ce1c342bddd95114558a335ec8885`。逐文件内容见 [source-manifest.json](source-manifest.json)，综合结果见 [validation.json](validation.json)。该摘要覆盖应用、合约、脚本、测试、原始 fixture、配置、锁文件、CI 和镜像输入，不包含密钥、运行目录、文档和证据自身。

| 检查 | 实际结果 / 证据 |
|---|---|
| 应用 | 1,382 项，1,380 通过、0 失败、2 项 W4 EVM 场景另跑 |
| 覆盖率 | 行 93.60%、分支 84.32%、函数 91.18%，门槛 88 / 72 / 86 |
| Solidity | 151 项通过，未放宽标准合约大小限制 |
| 实际 EVM / HTTP | W2 6、W3 3、W4 21、W5 13 项通过，均无跳过 |
| 浏览器 | 18 项通过，包含 zh / en、1280 / 1440、键盘、钱包变更及支付恢复 |
| 构建 / 安全 | lint、check、web build、Agent gates、离线 preflight、两个依赖审计及两次干净构建通过 |
| 容量 | 20 并发、2,000 请求、0 失败、p95 37.47 ms；1,000 日志及重复重放无双计 |
| 持续检查 | 至少 600 秒、600 次观察、0 失败；本机离线 Demo 容量，不是公共 RPC 商业 SLA |

完整运行收据见 [runs/2026-10-17T19-00-49-630Z](runs/2026-10-17T19-00-49-630Z/receipts.json)。该次原始 `passed=false` 保留：唯一失败为新增证据 runner 的 `prefer-const` 警告，其余 16 命令通过，源码始终未变。仅修正证据 runner 数组绑定后，全仓 lint 重新通过，见 [补充收据](lint-supplement.json)。汇总没有改写原失败记录。提交后同 SHA CI 再次执行正式门槛。

| 实链 / 恢复 | 证据及范围 |
|---|---|
| 新控制实例 / 角色 | [deployment.json](testnet/deployment.json)，逐笔签名哈希持久化、规范块及 3 确认、两人批准、真实 3,600 秒延时 |
| 旧实例 | [只读盘点](testnet/legacy-readonly-inventory.json)，不重铸或自动迁移旧 ID |
| 融资 | [资金验收](testnet/financing-acceptance.json)：8 测试币实付 / 放款、4+6 回款、单独领取 10；失败募集 2.4 原额退款 |
| 公共支付 | [公共 x402](testnet/public-gateway-acceptance.json)：官方 facilitator、规范测试 USDC、实际 PaymentOracle、0.001 扣款一次、重复报告一致 |
| 隐私锚定 | [anchor-acceptance.json](testnet/anchor-acceptance.json)：新审计合约、当前源码版本、完整加密材料可取回、规范链包含证明 |
| 源目录离线恢复 | [Linux 替代容器](recovery/2026-10-17T19-01-41-827Z/receipt.json)：仅加密备份和单独密钥、原发行人研究签名会话、材料核验、账 / 份额重建，约 8 秒，零广播；同物理机隔离 |
| 独立主机 | 最终提交的 GitHub `W5 independent host recovery` check 和 `w5-independent-host-recovery` artifact；远端只恢复材料 / 账，未提供原交易签名私钥 |

失败尝试、源码改变期间的 rehearsal、旧 artifact 和诊断日志均保留，见 [attempts.md](attempts.md)、`runs/` 和 `logs/`。最初资金执行收据另保留于 [financing-first-execution.json](testnet/financing-first-execution.json)；最终只读对账可更新确认高度，不重新广播已完成步骤。

最终 Git SHA、全部 CI 和独立主机恢复结论读取该提交的 GitHub checks / artifacts。提交后收据下载至忽略的 runtime，不为归档 CI 改写已验证源码。临时恢复 secrets 在完成后清除，密钥 / 明文运行历史不进入 Git。

真实货权、企业身份、独立估值、完整商业合规、组织独立密钥和外部人工值班未被本次技术测试证明。研究资料、模拟到港和确定性报告明确保留其标签；W4 未通过的实际模型质量记录保持原样。

发布脚本的补充修复：完整本地回归基线为 `8a9d1ad8a47b41f10bbff720a0891fc6ace993d7fd221205233cfe387a431ea5`，最终只修改 `scripts/remote-recovery-w5.mjs` 的加密分片大小与中途失败清理。应用 / 合约 / UI 文件逐字未变；新源码重新执行 lint、check、干净构建及真实锚定，见 [W5 证据汇总](validation.json)。最终全部回归与独立主机恢复仍以同 SHA GitHub checks 为准。
