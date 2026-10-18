# W3 本地实现与验收

日期：2026-10-17，Asia/Singapore。接手 HEAD：`e3d926af7b5da078a59436fd1602fe3e4ad38293`；接手时工作区干净。W3 覆盖综合报告 B04–B10，沿 W2 资金与账本实现研究 / 模拟单证 / 测试代币候选。

**B04–B10 已全部进入 `IMPLEMENTED`，在本地实际 EVM 与应用范围完成验证。现有测试网部署没有升级；没有新增提交、推送、远端 CI、测试网广播、真实资金或旧资产迁移。** 真实来源、法律控制、企业身份和独立恢复仍保留外部准入条件。

最终技术源码摘要：`f64743e1eb6aafdf02285703e503d4ee6a607ba36da92b68a2073dc7d62959ac`，覆盖 581 个源码、测试、脚本、公开样本 / 资源与构建 / CI 配置文件；不含 runtime、密钥和证据材料。逐文件摘要见 [source-manifest.json](source-manifest.json)。机器可读结果见 [validation.json](validation.json)。当前 HEAD 本身不包含这些未提交实现。

## 验证结果

| 检查 | 最终结果 | 收据 |
|---|---|---|
| 全量应用与覆盖率 | 1345 通过、0 失败、0 跳过 | [coverage-final-3.log](logs/coverage-final-3.log) |
| 覆盖率 | 行 93.37%、分支 84.55%、函数 91.41%；门槛 88% / 72% / 86% | 同上 |
| 全量 Solidity / Hardhat | 151 通过，其中 W3 19 项 | [contracts-final.log](logs/contracts-final.log) |
| W2 实际 EVM + HTTP + 钱包适配器 | 6 通过、0 跳过 | [w2-integration-final.log](logs/w2-integration-final.log) |
| W3 实际 EVM + 业务身份 HTTP + 钱包计划 | 3 通过、0 跳过 | [w3-integration-final.log](logs/w3-integration-final.log) |
| 中英文浏览器 | 12 通过；W3 桌面 1280 / 1440、键盘、控制状态异常 | [browser-final.log](logs/browser-final.log) |
| preflight | 66 PASS、0 WARN、5 Live SKIP、0 FAIL | [preflight-final.log](logs/preflight-final.log) |
| lint / 构建 / check | 通过 | [lint](logs/lint-final-2.log)、[build](logs/build-final.log)、[check](logs/check-final.log) |
| 共用写入锁修复 | 多进程、死锁恢复、后继租约和 Windows EPERM / EBUSY 注入通过 | [ledger-rights-retirement.log](logs/ledger-rights-retirement.log)；最终全量覆盖率再次通过 |

平台为 Windows x64 / Node 26.8.1；Solidity 0.8.24、viaIR、Paris、优化 200 runs。OpenZeppelin 固定为 5.1.0，以兼容当前编译器 / EVM。未放宽标准 EVM 大小限制：资金池 runtime 23,753 bytes；控制器 runtime 20,876 bytes，连同构造参数的 initcode 为 48,743 bytes，低于 24,576 / 49,152 bytes 限制。控制器 initcode 仅余 409 bytes，继续扩展时必须重新检查或拆分架构。

## 逐项完成范围

| ID | 实现 | 实测内容 | 仍待外部证明 |
|---|---|---|---|
| B04 | 共享 AssetIdentityHub、承诺式 Registry、签发 / 修订 / 背书 / 交回 / 失效、holder 精确条款同意 | 来源签名、ERC-1271 撤销、nonce / 链 / 地址隔离、修订后占用、跨 Registry 和历史别名去重、无发行撤押 | 真实承运人身份、稳定原始身份 / 换单映射、历史旧资产盘点、全球排他控制 |
| B05 | 通知、独立处置审核、争议、当前回收核对、损失风险锁和治理恢复 | 部分 / 零 / 足额、迟到回收、争议后审批、领取后解风险锁、重复领取拒绝 | 合法扣押 / 托管 / 拍卖 / 保险 / 追索及参与方材料 |
| B06 | 完整条款与净回收估值 EIP-712、敞口 / 期限 / 费用约束、报价版本同意 | JS / Solidity 哈希一致、过期 / 未来 / 错域 / 错资产 / 超覆盖 / 极端数拒绝、固定 exporter / 收费人 | 真实估值方法、误差、回收成本与商业条款确认 |
| B07 | 两人延时治理、成员 epoch、角色撤权、固定 minter、受限 guardian | 单人 / 相同人重复审批、提前 / 过期 / 重放、旧队列和旧角色、供应 / owner / gate 绕过拒绝 | 治理成员真实独立性、硬件 / 组织密钥保管与灾失接管 |
| B08 | 研究资格、有效期 / 撤销、服务时效及来源信任、投资者条款确认 | 缺 gate 前提、过期 / 变价 / 撤权 / screening 来源撤权、新操作拒绝且既有退款 / 领取继续 | 适用真实 KYC / AML / 地域资格和外部认证效果 |
| B09 | 加密组织 / 主体 / 钱包记录、EOA 单次挑战会话、双人摘要发布、跨传输对象权限 | 错钱包 / 重放 / 过期 / 撤销、跨组织、投资者无原文、HTTP / 下载 / SSE / 私人 MCP / A2A、旧审核不复用、失效 SSE 关闭 | 企业 IdP、真实雇佣 / 代理身份；链上授权发行人的实际签名托管 / 发布职责 |
| B10 | 新 Registry 仅承诺、加盐材料、AES-256-GCM、AAD、独立白名单摘要、保留期 | 存储不含原文 / 钱包 / bearer、错 key / AAD / 篡改拒绝、材料到期、已初始化 vault 丢失拒绝重建 | 真实数据字段与处理依据审查、备份保留 / 删除政策；旧链公开明文无法撤回 |

完整设计、权限矩阵、数据保留和接口见 [W3 权利与控制](../../w3-rights-control.md)。公开摘要双审是应用网关控制，未把链上获权发行人改为服务器签名代理。链上发行仍要求有效来源、holder 质押及独立估值；真实业务的签名托管安排另需批准与实测。

## 实际跨层证据

W3 集成使用独立 Hardhat RPC，真实部署治理、Hub、Registry、控制器、固定 token 和资金池。每次治理变更由不同账户批准并实际推进等待期。由生产 typed-data 函数签发和估值，经 HTTP 登记业务身份、钱包挑战、加密材料、双人发布、保存 unsigned plan，再由生产 JS 钱包适配器发送。

正向流程从来源登记 → 独立 holder 质押 → 已审材料与发行条款绑定 → 投资者资格 / 条款同意 → 实际测试 ERC-20 收资 → 固定收款人放款 → 实际回款 → 领取。恢复用例保留广播前计划，模拟漏存 hash，由新服务实例只读找回；拒绝错钱包、错 calldata、错链和字节码变化。规范回执重组后退回 reconciling 并保存旧确认历史，不重发。W2 另重跑现金、份额、多笔 / 零 / 部分领取、退款、漏日志与重组路径。

这是本地实际 EVM / 应用证据；单证、组织身份、业务估值和资格来源仍为测试材料。自动化钱包由本地测试节点提供账户，不能当作用户真实浏览器钱包或硬件签名人工验收。普通应用测试与实际 EVM 入口分开执行，未用跳过代替真实集成。

## 浏览器证据

已用 Chromium 跑中英文自动化，并用 playwright-cli / Edge 实际展开权限说明；截图经查看。W3 新增检查按桌面 1280 / 1440，覆盖键盘展开、明确未部署、研究范围、既有退出权与请求失败。现有 W2 390px 测试原样回归，不据此宣称整站手机适配。

截图：[中文](screenshots/rights-zh.png)、[英文](screenshots/rights-en.png)、[CLI 实查](screenshots/rights-cli-zh.png)。

## 失败与修复记录

失败日志全部保留，文件名带 initial 或较小序号者不是最终通过收据：

- 初次使用锁文件解析到的 OpenZeppelin 5.6 签名模块依赖 `mcopy`，当前 Solidity 0.8.24 / Paris 无法编译。固定到 5.1.0，保留 [初始编译失败](logs/w3-compile-initial.log) 与 [依赖安装](logs/w3-dependencies.log)。
- 首次 viaIR 编译遇到内联 assembly 的 memory guard；标注内存安全后编译通过，见 [compile-2](logs/w3-compile-2.log)、[compile-3](logs/w3-compile-3.log)。
- 构造器内设置自身资格 gate 因 runtime 尚未部署而被拒绝；改为无可选参数的一次性 activate，未激活不可发行。见 [初始合约失败](logs/w3-contracts-initial.log)。
- 防伪交易扫描原只允许 Mystery 使用随机 32 bytes，误拦新隐私 salt / 会话挑战；将这两处真实用途加入精确白名单，交易 hash 仍来自实际广播 / 回执。见 [初始全量失败](logs/w3-coverage-initial.log)。
- Windows Playwright shim / 对应新 headless shell 缺失；rebuild 恢复 shim，使用已安装 Chromium 1243。保留 [browser-initial](logs/w3-browser-initial.log)、[browser-2](logs/w3-browser-2.log)、[shim 修复](logs/w3-browser-bin-repair.log)。
- 新重组用例暴露已确认交易消失时原实现仅报错；现在持久化 reconciling 和 receipt_history。见 [integration-3](logs/w3-integration-3.log)、[最终跨层](logs/w3-integration-final.log)。
- 最终应用回归暴露共用 ledger 释放租约的 Windows 瞬时 EPERM。保留 [失败收据](logs/coverage-final.log)，增加只对 EPERM / EBUSY / EACCES 的有界退避；期间保留非空共享锁，退休成功后才清理私有目录。新增故障注入和原多进程 / 后继租约测试通过。为符合 no-unsafe-finally，将重试提取为同义 helper，随后再次完成全量覆盖率；初次 lint 反馈见 [addendum](logs/lint-final-addendum.log)。

## 复跑与后续

```sh
npm --prefix hardhat test
npm run test:coverage
npm run test:w2
npm run test:w3
npm run lint
npm run build
npm run check
npm run test:browser
npm run preflight
npm run rights:plan
```

浏览器本机需设 `AGENTBL_CHROMIUM_PATH` 指向已安装浏览器；干净 CI 安装匹配 Chromium。CI 新增 W3 实际 EVM 作业，但本轮没有运行远端 CI。`rights:plan` 只读生成 [部署审查计划](deployment-plan.json)，不读 key、不广播，不切换现有链配置。`node scripts/freeze-w3-evidence.mjs` 从最终日志生成源码摘要、机器结果及 B04–B10 的跟踪记录。

后续入口是 W4 的证据 / 来源、W5 的最终运营与独立恢复；测试网 W3 部署另需当前旧资产盘点、角色地址、资产 / 支出 / 交易范围和明确授权。新资金候选不对外接受真实资金。
