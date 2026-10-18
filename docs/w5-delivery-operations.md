# W5 交付、运营与最终验收

本轮覆盖综合报告 C04–C07，以及 W1–W4 的最终集成。交付层级为**受控 Injective 测试网应用**：实际测试代币托管 / 放款 / 回款 / 退款 / 领取，模拟单证、研究身份和估值。真实企业身份、承运人权利、法律处置和商业准入仍保持外部门槛。

用户在 2026-10-18 直接授权部署、必要交易、测试、提交和推送。规范见 [W5 设计](superpowers/specs/2026-10-18-w5-delivery-operations-design.md)。运行结果见 [W5 证据](evidence/w5-2026-10-18/)；GitHub checks 和 artifacts 记录提交后同 SHA 的 CI 与独立主机恢复，不能由提交前文档预先宣称通过。

## 操作范围

1. Demo：内存演示、固定样本和模拟收据；链上失败不会自动改成模拟成功。
2. 历史实验 / v3：保留 `public/chain-config.json` 地址和记录；旧协议不会因新源码而升级。
3. 受控融资：显式 `AGENTBL_RIGHTS_CONFIG` 指向 [rights-instance.json](../public/rights-instance.json)，逐次核对链、六份 runtime、治理、EIP-712 域及 owner / oracle / gate / minter，实际绑定通过才显示已连接。

受控融资面板展示实例、条款 / 报价版本、募集、放款、回收、持仓、可领取、已领取和退款。中英文桌面支持 1280 / 1440、键盘和焦点。资格及条款同意通过后才可认购；Live 钱包操作单独确认，以 6 位原子金额核对成本。结清与投资者实际领取分别记账。

受控融资可独立选择 Live；x402 付费报告的配置和来源验收单独判断。治理有三个地址、两把不同密钥批准和实际 3,600 秒延时。本轮研究密钥由同一操作员保管，不能解释为三个独立真实组织。

## 监控与停止

| 入口 | 语义 / 权限 |
|---|---|
| `/api/health` | 进程存活；不等于可以接收新操作 |
| `/api/ready` | 非敏感就绪、范围及版本；异常返回 503 |
| `/api/ops/status` | 管理员认证；存储、控制实例 / 账本、来源时效、链确认、积压、审计、证据覆盖 |
| `/api/ops/metrics` | 管理员认证；Prometheus 文本指标 |
| `ops-alerts.jsonl` | 持久告警；状态变化与恢复分别记录 |

空间 / durable 写入失败、启动失败、关键历史缺失、链确认未知、控制实例改变、账务不平、来源失效和积压会停止新增认购 / 发行 / 放款和新收费。已付授权恢复、读取、对账和已有领取 / 退款入口保持可达；链上暂停及退出条件仍有最终约束。

`AGENTBL_ALERT_WEBHOOK` / `AGENTBL_ALERT_TOKEN` 在操作员明确配置接收端时使用。测试验证实际 HTTP 接收、去重和恢复；外部值班人员及组织流程需要另行实测，自动接收端不等于人工确认。

每个 runtime 仅一个应用进程。`.runtime-lease` 也约束停机备份，不能抢占未知远端持有者。首次配置完成后设 `AGENTBL_REQUIRE_EXISTING_RUNTIME=true`，丢失 volume 时拒绝空历史。`ops-required-history.json` 单调记录初始化材料、关键账本 / 审批 / 决策和 key sidecar，缺件即停止新增操作。

停止容器使用 `docker stop -t 30 <container>`，确认 exit 0 及租约释放后再备份。若进程被强制终止且租约来自另一个容器 hostname，必须核对该容器确已退出、没有其他挂载写入者，再保留旧 owner 记录并人工退役租约；不能因“目录看起来空闲”而抢占未知持有者。备份前重新核验初始化材料，恢复后重新对账。

## 资金与中断恢复

`/api/controlled/status`、`/offerings` 提供核对后的实例和同一规范块报价；`/positions?wallet=...` 从实际事件及余额对账。`/subscription-intents`、`/claim-intents`、`/refund-intents` 保存未签名意图。`/intents/:id/broadcast` 在 allowance 准备后固定 nonce 和起始块，`/transaction` 只接受完全匹配的原交易。

GET 意图只读查找原 nonce / calldata，不重新签名或扣款。重组撤销确认并保留历史；超过 500 块需附加原钱包哈希。前端先保存意图，刷新后暂停重复发送；未广播草稿可取消本地提示，服务器审计保留。钱包明确拒绝会退出确认。

资金账本从规范回执中的实际 ERC-20 Transfer 解析放款和费用，兼容控制器 / 治理包装调用。正式回归覆盖实际 EVM / HTTP / 钱包、违约后多笔回款、独立领取、失败募集退款、漏存 hash、nonce 和重组。

## 备份、恢复与密钥

```sh
npm run runtime:backup -- create --directory <stopped-runtime> --key-file <separate-backup-key> --output <new-encrypted-backup> --configuration <public-instance-json> --revision <source-revision>
npm run runtime:backup -- restore --directory <new-target> --key-file <separate-backup-key> --input <encrypted-backup>
```

先停应用及同目录 CLI。只支持停机一致性快照；摘要、initialized 标记、历史和配置一起加密。备份、vault 和签名密钥分别管理。错密钥、篡改、路径逃逸、重复 / 大小写冲突、符号链接、已有目标和中断恢复标记均拒绝。整包校验后才写新目录，旧历史和旧恢复收据保留。

`npm run recover:w5 -- <same-source-image>` 使用实际测试网账本和材料：源目录改名离线，新 Linux 容器只获得加密包和独立挂载的密钥，重开会话、验证材料、重建链账并比较金额 / 份额。RPO 为最后完成的停机快照，RTO 目标 5 分钟。此容器结果单列为同物理机隔离证据。

独立 GitHub runner 的 `offhost-recovery` 通过临时分片 secrets 获得加密快照，另获解密配置，未接收原交易签名私钥。在无源主机路径 / 网络依赖时恢复 vault、建立新的研究恢复操作员会话、核验原材料及规范持仓，整个过程零广播。配置只匹配指定 release SHA，完成后运行 `node scripts/remote-recovery-w5.mjs cleanup` 清理。原研究签名密钥接管由本地加密恢复演练另证，真实组织独立密钥保管仍需外部材料。

## 构建、容量及发布

```sh
npm run validate:w5
npm run deploy:w5 -- --status
```

验收按顺序保存 lint、check、构建、应用 / 覆盖率、Solidity、W2–W5 实际 EVM、浏览器、Agent gates、离线 preflight、两个依赖审计、两次干净构建、容量 / 连续运行的时间、退出码和源码摘要。普通 Node 套件单列 W4 两个实际 EVM 场景；W4 / W5 独立入口和 preflight 不能用跳过代替实际集成。

锁文件固定 Solidity 0.8.24 / Paris / viaIR / 200 runs / OpenZeppelin 5.1.0，比较前端字节、ABI、creation / runtime 和 immutable 范围，仅归一化 solc AST 编号。源码固定 LF，供应商资源和历史证据保留原字节。标准 EVM 大小限制未放宽。

镜像从同源码编译并带六份 W3 artifact，使用非 root、只读根、tmpfs、cap-drop ALL、no-new-privileges。运行版本及 OCI label 绑定提交 / 源摘要。旧审计产物仍带旧 5.6.1 构建 metadata 的问题已保留原产物并强制重编译，新审计实例使用最终产物。

容量目标预先固定为 20 并发、2,000 次请求、错误率 <= 1%、p95 <= 1 秒；资金日志 1,000 条及重复重放；10 分钟至少 600 次检查。吞吐测量关闭每 IP 限流并记录实际机器，默认限流由安全回归另验。短测不构成商业 SLA。

提交前本地收据及测试网回执进入仓库；提交后的同 SHA CI / 独立恢复由 GitHub checks / artifacts 保存，本机副本在 runtime。避免为归档 CI 结果再改写被验证的源码版本。
