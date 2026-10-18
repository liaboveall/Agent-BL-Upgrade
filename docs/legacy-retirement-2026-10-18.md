# 历史实验全量退役结果

日期：2026-10-18（Asia/Singapore）。本轮完成当前运行目录的历史协议、签名入口、实验脚本、专用测试与过期文档退役。当前融资主线收敛为离线 Demo 和受控 v5 测试网实例；历史证据可独立恢复。

本轮是代码与入口清理，不是链上迁移、协议漏洞修复或生产上线。

## 1. 交付版本与范围

- 基线提交：`b8db411de044b1132f14419a432be6da6ff1501b`，分支 `feat/w2-capital-ledger`。
- 交付为未提交工作区；没有 commit、push 或更新远端部署。
- 当前技术源码清单：576 个文件，SHA-256 `214be96b6f196280b30e28066dc4384746dd73c78d15b1a68d9dd838e5dd1373`。
- 清单覆盖应用、前端、合约、脚本、测试、数据夹具、依赖锁文件和构建输入，排除密钥、runtime、文档与证据。完整文件摘要见 [source-manifest.json](evidence/legacy-retirement-2026-10-18/source-manifest.json)。
- 所有外部链上操作均为公开配置下的只读查询；外部交易广播数为 0。集成测试中的交易仅在独立本地 EVM 执行。

## 2. 清理内容

共退役 **119 个原跟踪文件**，逐项路径、原工作区大小和摘要见 [retired-files.json](evidence/legacy-retirement-2026-10-18/retired-files.json)。

| 类别 | 本轮处理 |
|---|---|
| 历史合约 | 移除 AgentBLRWA、EBLRegistry、旧 RWAOfferingPool、旧 RWAToken/RWATokenV5、RiskPricingOracle、InvestorComplianceGate 等历史实现 |
| 历史部署 | 移除旧部署地址配置、单独部署脚本、v3 部署/验证/迁移、Wave B 门禁和旧字节码验证入口 |
| Agent 签名执行 | 移除旧链执行器、链监听、自动开池、自动结算、owner CLI、Live smoke 提案与旧交易计划 |
| 外围实验 | 移除 Injective bank/exchange 预编译及对冲实验；移除旧单证样例和旧身份映射 |
| 测试与文档 | 历史协议专用测试、无运行调用的旧合约模拟器及其测试、旧阶段计划与报告移入基线归档；原证据保持原位 |
| 前端 | 移除旧铸造和 repricing 钱包动作、owner 签名控制；Live 发行统一引导受控融资。Demo 模拟发行仍保留 |
| MCP/CLI | 移除旧 Oracle 写入工具及所有活动调用方；Demo 助手改为调用 4 个当前工具，MCP 保留 14 个工具与 5 个资源 |
| 配置与验收 | 新建唯一应用配置及当前架构/部署说明；更新 smoke、preflight、覆盖率、浏览器和集成测试；后续 validate 写入新的验证目录 |

旧 Oracle API、旧 Agent 开池映射、Live smoke 提案和交易附加入口返回退役错误；旧公开配置路径不再存在。审批记录中的历史状态枚举保留用于解释记录，不提供对应签名执行能力。

## 3. 当前保留的功能与数据边界

- 六份受控核心合约源码未修改：RightsGovernance、AssetIdentityHub、CommittedEBLRegistry、RightsController、RWAOfferingPoolV5、ControlledRWAToken。
- PaymentOracle 和当前 AgentDecisionLog 是共享支付/证据服务，继续保留；不是旧融资协议的恢复入口。
- 确定性定价、材料分析、来源证据、独立 x402 支付、受控融资和持仓、治理、对账、备份与恢复继续保留。
- 新公开配置为 `public/application-config.json`，融资配置拒绝旧协议及非 1439 网络。它与 `public/rights-instance.json` 的当前地址一致。
- Demo 账本使用 `demo-ledger/`，研究 Agent 使用 `research-agent/`，不自动导入旧根目录账本或旧池映射。受控账本继续按原资金池地址隔离。
- Live Agent 记录分析，不签融资交易；参与者钱包通过受控路由准备和核验融资操作。可选证据锚定使用专用 `AGENT_ANCHOR_PRIVATE_KEY`。
- 没有读取真实 `.env` 或删除真实 runtime、密钥、持仓、付款授权、恢复记录、历史链上资产占用。链上合约和交易不能由本地文件清理抹除。

## 4. 历史资料保存验证

完整已提交基线保存在 [agentbl-before-retirement-b8db411.zip](archive/agentbl-before-retirement-b8db411.zip)，大小 33,553,462 字节，SHA-256：

`81c3e2865e880d7a5edbe66a9092ec9a4601361bc903811dcc0528395ec3003a`

Git 归档会规范化三份 Windows 文本的换行，故另外保存 [baseline-byte-overrides.zip](archive/baseline-byte-overrides.zip)，SHA-256：

`b7f759c5005a98cdaa7ad3c89bde5ca34679756fb9109b116ed90593834505e0`

核验结果：119 个退役路径均存在于完整基线包；覆盖字节补充包后，原冻结清单的 **649/649** 份源码摘要一致；此前本轮综合评估的 **30/30** 份证据摘要保持一致。详细记录见 [preservation-verified.json](evidence/legacy-retirement-2026-10-18/preservation-verified.json)。

旧报告中已经退役的源码链接，应按 [归档说明](archive/README.md) 在独立目录恢复后查阅。旧证据属于各自原始版本，不代表清理后版本的验收。

## 5. 本地验证

| 检查 | 最终结果 | 证据 |
|---|---|---|
| ESLint / 完整性 / 前端构建 | 通过 | `lint-accepted.txt`、`check-accepted.txt`、`build-accepted.txt` |
| 应用测试及覆盖率 | 1,108 通过、2 跳过、0 失败；行 92.50%、分支 84.13%、函数 90.54%，超过 88/72/86 门槛 | `coverage-accepted.txt` |
| Solidity | 清理构建缓存后编译 14 个 Solidity 文件；当前合约套件 66 通过 | `compile-clean.txt`、`preflight-accepted.txt` |
| W2 资金层集成 | 5 通过，覆盖本地 EVM、HTTP、钱包、未知交易、重组、亏损分配 | `w2-accepted.txt` |
| W3 权利控制集成 | 3 通过，使用完整受控实例，覆盖业务会话、钱包计划、真实本地回执与篡改拒绝 | `w3-accepted.txt` |
| W4 证据/支付 | 21 通过，包括独立付款核验与本地 EVM 路径 | `w4-accepted.txt` |
| W5 运营/恢复 | 13 通过，包括完整受控本地生命周期及独立进程备份恢复 | `w5-accepted.txt` |
| 浏览器 | 系统 Microsoft Edge，18 通过、0 跳过、0 flaky | `browser-accepted.json` 与 `browser-artifacts/` |
| Preflight | 66 PASS、0 WARN、4 SKIP、0 FAIL，共 70 项 | `preflight-accepted.json` |
| 相对依赖及命令目标 | 443 个源码文件、1,522 条相对导入、两份 npm 配置、119 条退役路径检查，无缺失目标 | `dependency-check.json` |
| 依赖审计 | 应用生产依赖与合约工具链均为 0 个已报告漏洞 | `audit-production.json`、`audit-contract-toolchain.json` |
| 补丁格式 | `git diff --check` 通过；保留 Git 的换行提示 | `diff-check.txt` |

以上证据均位于 [清理证据目录](evidence/legacy-retirement-2026-10-18/README.md)。普通应用测试中的两项跳过为显式启用的本地 EVM 集成路径，另由 W4 与 preflight 执行。Preflight 的四项跳过分别是 Live 配置前置条件、facilitator 可达性、公开 RPC 就绪检查和钱包 gas 余额；本轮没有真实钱包支付或外部模型质量验收。

测试数量减少来自对应历史代码及其专用测试退役；不能把删除测试后的通过率视为协议质量提升。W2 中旧 owner CLI 用例同时退役，当前受控生命周期保留独立 W3/W5 验证。部分资金层单元测试使用新的 MockCapitalRegistry 隔离夹具；这不能替代完整受控实例测试。

Preflight 中已有的 `source_sha256` 是 Agent 评估语料范围的摘要，和覆盖前端/合约的技术源码摘要范围不同。两者分别复算一致，不能混称同一摘要；见 [source-bindings.json](evidence/legacy-retirement-2026-10-18/source-bindings.json)。

## 6. 公开实例只读复核

在 Injective 测试网 1439 的区块 `144292923`（hash `0x0b9333ca0f1e4d8102c6e2fdf216054c4c512c699c5e5b4e27e956e01a43c06a`），受控实例代码、绑定和版本核验通过，公开钱包配置指向相同资金池；读取后该区块仍属规范链。

- 当前 AgentDecisionLog 完整运行时代码与本地 artifact 一致，现有 3 批记录保持可读。
- 共享 PaymentOracle 的 Solidity CBOR 元数据不同，**不是完整运行时代码逐字节一致**。它的可执行部分一致，完整链上 runtime 摘要也与原冻结证据中的精确 pin 一致。两项条件同时成立才接受该共享服务。
- 本轮没有重新部署、注册锚定版本或迁移链上实例。当前清理后的源码摘要也没有自动获得链上版本注册。

复核详情见 [read-only-instance-check.json](evidence/legacy-retirement-2026-10-18/read-only-instance-check.json)。

## 7. 初次失败与仍未解决的问题

初次应用、浏览器、smoke、preflight 和编译并行失败记录没有被后续通过覆盖。旧断言与已移除调用方已按当前行为更新；两个并行 Hardhat 构建曾发生缓存文件竞争，此后构建串行执行。

`coverage-final-verified.txt` 还保留一次 MCP 付费报告本地 fetch 失败。该调用当时直接使用随机端口，而本机临时端口区间覆盖 Fetch 禁止端口；现已复用项目已有的 `listenOnUsablePort`，最后整套覆盖率与 preflight 均通过。原日志没有记录失败端口，因此只能将禁止端口列为有依据的可能原因，不能宣称已直接证明此次失败根因。

本轮没有改变评估报告中的合约规则，仍须处理：到期/估值过期后放款、微额回款反复打断处置、重复争议、费用与领取顺序。条款可读性、池列表分页和主页面移动端布局也未在本轮整改。问题及验收建议见 [当前版本综合评估](project-current-assessment-2026-10-18.md)。

当前结果证明本地退役后的应用路径可以构建和回归，不代表已完成 CI、容器发布、真实组织准入、法律权利、真实资金或生产灾难恢复验收。
