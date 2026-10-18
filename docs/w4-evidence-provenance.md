# W4 证据与来源

范围为 B11、C01–C03。实现基于保留的 W2/W3 工作区；当前测试网地址没有因此升级。[验收证据](evidence/w4-local-2026-10-17/README.md)区分本地实际 EVM、配置端点观测、公共数据与未满足的业务条件。

## 证据、隐私与离线验证（B11）

`agentbl-evidence-v1` 分别描述原始材料、估值、发行条款、审批、执行和付款。金额为精确整数单位字符串，时间为带毫秒的 UTC ISO 字符串，缺值显式为 null。canonical JSON 排序对象键，保留数组顺序和原始 Unicode；拒绝非有限数、浮点数、负零、隐式 undefined、自定义对象和过深结构。研究计算快照先把数值转成无运算/无舍入的字符串。SHA-256 域隔离承诺绑定完整内容、版本、私盐和依赖引用。原始单证另复算 W3 的加盐文档承诺。

W3 材料对应证据保存在同一个 AES-GCM vault 中，每次 HTTP / 私人 MCP / A2A 请求重新检查组织、角色、会话、保留期和对象权限。依赖必须属于同一组织、同一材料，完整包最多 100 项；缺件、篡改、过期、未知 schema、循环依赖和不符的预期根均失败。没有隐式“最新文件”替换不可变引用的行为。

运行时通过 `DecisionEvidenceArchive` 在最终决策捕获时保存完整结构化输入、报价、审批、执行和 replay 快照，并将加盐材料承诺加入新 `agentbl-decision-anchor-v2` 叶子。新叶子隐藏 case / event / pool / 审核主体明文标识，保留动作、结果、交易、版本及证据承诺；旧 v1 叶子继续按旧格式核验。旧链上明文不可能撤回。未配置独立 key 时，包含证明仍可存在，但状态明确显示没有材料归档，不能称材料可取回。

归档永久绑定捕获时的 workspace 所有者，日志裁剪或 case 元数据丢失不使私人材料变公开。已初始化 vault / archive / 付款历史缺失时拒绝空初始化。配置 key 后归档失败会阻止锚定采集继续及依赖它的保留清理。现有 workspace cookie 仍属于研究原型能力，不代表企业身份提供方验收。

| 路径 | 权限与行为 |
|---|---|
| GET `/api/evidence/status` | 公开技术范围、待验状态及锚定覆盖率，不含私人原文 |
| POST `/api/rights/evidence` | W3 有效会话；绑定 `material_id`，创建六类证据之一 |
| GET `/api/rights/evidence/:id/download` | 同对象权限，递归取回完整依赖包并复算 |
| GET `/api/agent/decisions/:id/evidence` | 捕获时 workspace / 管理员权限；加密运行时材料包与独立 anchor 投影 |
| POST `/api/rights/evidence/:id/review` | 请求人工接管；记录原因、材料修订、证据承诺和当前运行时版本 |
| POST `/api/rights/evidence-reviews/:id/resolve` | 独立 reviewer；精确 context 指纹，批准研究复核或拒绝，结论不可覆盖 |

私人 MCP `tools/call` 的 `read_evidence` 使用 `{evidence_id}`，A2A 使用 `{operation:"read_evidence", evidence_id}`。它们共用 W3 权限，不注册为公开匿名材料工具。

下载的授权包可在没有原服务、wallet、RPC 或 `.env` 的新进程验证：

```sh
npm run evidence:verify -- authorized-package.json
npm run evidence:verify -- authorized-package.json --expected-root 0x...64hex...
npm run evidence:verify -- authorized-package.json --anchor authorized-anchor.json
```

第一条仅证明包内完整性；使用从可信渠道获得的预期根或包含证明才建立承诺绑定。离线 Merkle 包含不等于当前规范链确认，输出始终区分 `anchor_chain_verified=false` 与源材料真实性。现有 `agent:verify-anchor` 继续只读核对部署、精确交易、规范回执及链上包含。

锚定状态分别列出当前可见源日志终态数、遗漏、归档材料数、已确认数、待批次数与最老未分批延迟。覆盖率仅针对仍可见的源日志，不能凭空发现已删除的源事件。重组或 RPC 无法复核时，旧确认转入 `receipt_history`，取消“已确认”状态；未知广播只定位原交易。当前 code / policy / 请求模型注册不匹配时拒绝广播，不把旧注册自动重命名为新源码。

## 行情、期限与校准（C01）

`agentbl-research-calibration-v1` 固定参数版本、ACT/365、FAST/BALANCED/LOW_COST 基础年率、异常阈值及来源。风险 bps 是风险压力，不是违约概率；没有实际资金服务时不承诺到账 SLA。

适用性检查独立于 fetch 成功，检查 benchmark、品级、单位、地区、币种、现货/期货基差来源、市场日历版本、变现成本、保险扣除、观测时间、跨源冲突和极端变动。缺失或异常输出 REVIEW；正常参考也只是 REFERENCE_ONLY，仍要求人工核对，不能代替独立净回收估值。Live 报价缺少已批准来源时暂停；不把缺数据计入风险恢复的 quiet ticks。

显式给出出资与到期时间时，报价使用实际剩余天数，避免把 30 天研究下限当作已发生的融资期限。金额和费用按相同时间轴计算年化，期限/费用也进入承诺。调用方时间必须再绑定规范资金回执，不能仅凭传入 `funded_at` 声称实际已经放款。

本批次自行获取了 [FRED / IMF 铜价公开观测](https://fred.stlouisfed.org/series/PCOPPUSDM)，冻结 2026-03 至 2026-07 五个**月均参考值**。四组“以上月值预测下月”的持平基线 MAPE 为约 1.9424%、RMSE 约 360.183 USD/MT；截至本轮读取，五项均不满足当前观测时效。这些数字只属于该基准，`cargo_valuation_error=null`，不能改称项目的货物估值准确率。品级和期货单位参考 [CME 铜合约说明](https://www.cmegroup.com/trading/metals/files/copper-futures-and-options.pdf)。

## 提供方、样本和人工接管（C02）

样本固定至 DCSA 官方 [Conformance-Gateway](https://github.com/dcsaorg/Conformance-Gateway/tree/ffa064b01a452ab4fcd34e08086b53cf41635aa6) 的提交 `ffa064b...`：三份 Apache-2.0 公共测试样本保留原字节、许可和摘要，转成明确标识的抽取输入；另创建缺成本、中文缺字段、注入、错页冲突与损坏文本五项故障样本。它们不是承运人实际签发单证，也不是独立业务验收集。标签不会传给解析器或模型。

真实配置端点与本地确定性回归分别出报告。真实端点请求模型为 `x-test-2`；连接探针成功，早期单证响应出现重复且无效的 document_hash 等字段，最近完整评测的七次抽取均超时；另将单份公共样本的超时上限扩至 60 秒，约 23.1 秒收到的响应仍因无效 schema 被拒绝。没有可采用的模型结果。全部转人工；17 个已评分字段的零错误来自确定性回退，不能据此宣称模型准确率 100%。报告列出请求数、有效响应数、字段错误、证据不支持、版本漂移、误放行、人工率及可评分样本数。当前没有业务批准阈值，也没有可清样本的统计基数；不计算一个虚假的真实业务通过率。配置端点的响应不独立证明背后实际执行了所声称的模型。

真实官方名单源已实际下载并冻结：[OFAC Sanctions List Service](https://ofac.treasury.gov/sanctions-list-service)。本轮源含 19,457 条主名称记录，来源响应、Last-Modified、gzip 原字节和 SHA-256 一并保存。适配器支持 CSV 引号/换行和该源的末尾 DOS EOF 标记；三项公开名称探针分别记录来源命中或无精确主名称命中。这个探针不覆盖别名、受益所有权、非 SDN 名单或其他法域；**无命中不返回 CLEAR，也不授予资格**。商业合规服务仍未配置，不能把来源连通性当作完整筛查效果验收。

界面提供授权材料下载、来源与版本查看、人工接管理由、独立批准/拒绝。服务端将复核绑定证据承诺、材料修订和正在运行的 Agent 版本；自审、材料变更、策略版本变化、撤销会话、过期和覆盖已作结论均拒绝。研究批准不会启用真实业务。

## 独立付款与恢复（C03）

Live 付款在解锁或 PaymentOracle attestation 前，独立检查 RPC 链 ID、指定 token 代码/名称/版本/6 位精度、EIP-712 签名、执行时间窗、精确授权 calldata、成功规范回执、块哈希、确认深度、该资产的 AuthorizationUsed 和精确 Transfer。当前支持直接 ERC-3009 token 调用；未审查 wrapper 明确拒绝。资产/收款人/金额/nonce/网络不符及任意 hash 都不能解锁。参考 [ERC-3009](https://eips.ethereum.org/EIPS/eip-3009)。

付款身份为 chain / asset / payer / nonce，签名不同不创造新付款。请求正文另绑定资源；同授权不能在并发、重启或修改正文后购买另一份报告。文件事务跨进程加锁，持久意图先于 settle；facilitator verify 可以有界重读，settle 不自动重发。

SETTLING 不明结果进入 RECONCILING。按资产的授权事件在最多 500 块中定位，再验证精确回执；范围外要求人工对账。已消费授权不能重收。重组或规范回执不可取会阻止再取报告，并保留旧证明；原付款重新确认后可以恢复。未广播前的临时预检失败可重试相同授权。

报告生成失败后复用原付款。准备好的报告/信封在 attestation 前认证加密落盘，成功报告也在收据历史内加密保存，避免重试生成另一份报告或再次收费。Live 不再写明文短期 report cache；旧明文历史未被静默删除。Live GET `/api/x402/report/:id` 需要原 PAYMENT-SIGNATURE，重新核验当前链事实；即使原授权已到期，实际已付报告仍可免费取回。报告数据的定价 TTL 仍有效，取回不延长它。

浏览器在 sessionStorage 写入原授权后才发送；断网或页面刷新优先复用原 nonce，不再弹出另一笔付款签名。未处理的同服务付款会阻止换正文重新买。CLI 使用加密 `ClientPaymentJournal`，进程重启亦重用原授权。Live 服务端和 CLI 均要求外部管理的 `AGENTBL_RIGHTS_KEY`；缺 key 或已初始化历史丢失会在新收费前拒绝。不会从管理员 token 派生密钥，也不会把 key 生成在 runtime 旁。

报告付款收据不进入融资现金分录，不计为 RWA 认购或进口商回款。本轮只有隔离 EVM 的测试 token 发生移动，没有真实 USDC 或测试网付款。

## 运行和剩余条件

```sh
npm run test:w4
npm run eval:w4
npm run eval:w4 -- --live
npm run eval:w4:market
npm run eval:w4:screening
npm run validate:w4
node scripts/freeze-w4-evidence.mjs
```

`evidence:corpus` 是显式重新获取公共语料的操作，固定官方提交；平时评测使用冻结语料。真实请求会保留独立时间戳报告，失败记录不覆盖为成功。

本地实际 EVM/HTTP、离线新进程与浏览器自动化可以验证实现；真实签发/货物估值、独立业务样本、提供方质量、外部身份、生产规模和源机器丢失后的异机恢复仍需对应材料。首次测试网锚定及 code/policy/model 注册需要明确逐笔授权，本轮没有启用后台锚定、部署、旧资产迁移、提交、推送或远端 CI。
