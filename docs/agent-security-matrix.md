# Agent 权限矩阵与人工恢复

2026-10-15。本文件对应 WP5.7；实际实现见 `runtime/policy.js`、`runtime/agentService.js`、`runtime/executors/chainExecutor.js` 和 `scripts/lib/agent-approve.mjs`。

| 模式 / 自主级别 | 只记录的动作 | 可逆状态动作 | 付款记录 / 不可逆动作 | 签名 |
|---|---|---|---|---|
| Demo / off | 拒绝 | 拒绝 | 拒绝 | 无 |
| Demo / observe | 只记录 | 只记录 | 只记录 | 无 |
| Demo / propose | 记录 WARNING / HOLD / REJECT | 需审批，随后模拟执行 | 分别审批，随后模拟执行 | 无 |
| Demo / auto（默认） | 记录 | 通过来源、冷却、限次、价格与合规规则后模拟执行 | RECORD_PAYMENT、SETTLE、FREEZE、LIQUIDATE、CANCEL 需审批 | 无 |
| Live / off | 拒绝 | 拒绝 | 拒绝 | 无 |
| Live / observe | 只记录 | 只记录 | 只记录 | 无 |
| Live / propose（默认） | 记录 | 每个动作需人工审批 | 每个动作需人工审批，受保护池禁止终态动作 | 见下表 |
| Live / auto | 启动时降为 propose | 同 propose | 同 propose | 同 propose |

Demo 的 `AGENT_ALLOW_UNATTENDED_IRREVERSIBLE=true` 是显式演示开关；Live 永不采用此豁免。信息动作不创建无意义的签名审批。过期、未来时间、缺失来源时间或来源不可用的证据不能自动执行；已排队/已批准的动作发送前再次检查，到期后需刷新证据并创建新提案。Live 风险监控的 fixture 回退不推进滞回计数，也不能恢复暂停中的池子。

| 动作 | Live 签名路线 | 没有对应角色/密钥 |
|---|---|---|
| REPRICE / PAUSE / RESUME / OPEN_WITH_WARNING / FREEZE / LIQUIDATE | 审批后服务器使用专用 `PRICING_UPDATER_PRIVATE_KEY`；staticCall、nonce 串行和回执核验 | 失败或保持待处理；不回落到 owner |
| MARK_IN_TRANSIT / RECORD_PAYMENT / RECORD_ARRIVAL / SETTLE | 默认本机 owner CLI，逐笔 `--step N --confirm`；可选已授权的 AGENT_EXECUTOR | 服务器发布计划，等待本机签名 |
| mintEBLV2 / pledge / createOffering / cancelOffering / correctImporterPayment | owner 专属；服务器不能代签 | 等待 owner 操作 |
| 只记录的 WARNING / HOLD_FOR_REVIEW / REJECT | 无签名 | 仍可记录 |

Web 服务器保持 `SIGNER_KEYS_STRICT`；不得用部署者密钥补齐缺失的执行者/定价角色。pool #2 的 FREEZE、LIQUIDATE、SETTLE、CANCEL 由策略和 CLI 拒绝。测试网冒烟工具只允许 REPRICE → PAUSE → RESUME，独立开关 `AGENT_LIVE_SMOKE_ENABLED=true` 和管理员令牌同时满足后才可生成 Live 冒烟提案。

| 接口 / 操作 | Demo | Live |
|---|---|---|
| 状态、脱敏决策、追踪 | 公开读取 | 公开读取 |
| MCP 状态/决策/策略/解释 | 公开；剔除私有重放快照 | 公开；剔除私有重放快照 |
| MCP 外部事件 | 默认 dry-run 不入队；实际提交必须 approved=true + 带外 MCP_HUMAN_APPROVAL_TOKEN，入队后依 Demo 自主级别模拟 | 同样验证令牌，仍受 Live 事件类型、来源/新鲜度和独立决策审批限制 |
| MCP 无状态推荐、MCP/A2A/HTTP 委托报价 | 公开；报价/报告来源不授权付款、认购或执行 | 公开的指示性计算；不授权链上写入；缓存报告不代表本次重验实链 |
| 决策重放 | 公开、只读 | 管理员、只读 |
| 控制、事件注入、审批队列/批准/拒绝/回填 | 配置管理员令牌后需验证；无令牌时便于本机演示 | 必须配置并验证管理员令牌 |
| 上传和出口商偏好 | Demo 接入 | 管理员 |
| 四场景后台演示 | 只在 Demo，可要求管理员 | 禁止 |
| 冒烟提案 | 禁止 | 显式开关 + 管理员 + 固定动作 + 受保护的已核验 pool #2 |

人工兜底：通过控制台或 `POST /api/agent/control` 启用紧急停止，停止后仅允许降低敞口的 PAUSE 和信息记录；链上紧急停止不可被本地解除覆盖。对未确认广播保留 EXECUTING 和已有哈希，只读对账；不得重新发送来“修复”。owner CLI 的 uncertain journal 需要明确附加交易哈希并核验，不能删除历史记录绕过。缺少新鲜证据时重新采集并创建新提案。

审计与隐私：公开决策、活动和追踪对钱包缩写、密钥字段脱敏，不保存单证原文。运行时恢复所需的完整地址/输入以 AES-256-GCM 存放在经认证的 `_private` 字段中，密钥为同目录 `*.key`（创建时请求 0600 权限）。这用于防止日志泄露；拥有整个运行目录读取权限的主机管理员仍可解密。部署时需限制卷/Windows ACL，并同时备份日志与 key。源文件在专用 `uploads/` 中供作业重跑使用，不属于公开审计日志；不能把原始上传目录对外开放。

`AGENT_RETENTION_DAYS` / `AGENT_MAX_DECISIONS` 由周期 tick 清理终态决策及活动/追踪；处理中、待审批、待 owner 签名和待对账的决策保留。事件高水位保留以阻止旧事件再次触发，死信保留供人工检查。保留上限不承诺无限保存所有历史证明，审计导出应在过期前完成。尚未部署的 WP7.1 链上锚定不由本地重放替代。
Phase 7 补充：新 `AgentDecisionLog` 的版本注册和 anchorer 授权仅限 owner CLI；服务器不能登记版本或授权自己。批次广播复用专用 `PRICING_UPDATER` 和既有串行队列，无 owner-key 回退。`AGENT_ANCHOR_ENABLED` 默认关闭，部署与首次广播单独授权；公开证明 API 和校验 CLI 不能付款或执行贸易动作。证明只承诺记录一致性，不认证输入事实或操作人的外部身份。见 [Phase 7 指南](phase7-decision-anchoring.md)。
