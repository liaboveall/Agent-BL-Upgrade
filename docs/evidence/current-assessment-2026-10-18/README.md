# 当前版本综合评估证据

对应报告：[AgentBL 当前版本综合评估](../../project-current-assessment-2026-10-18.md)。日期为 2026-10-18（Asia/Singapore）。

- 评估基线：`b8db411de044b1132f14419a432be6da6ff1501b`，`feat/w2-capital-ledger`，起始 tracked/untracked 工作区干净。
- 环境：Windows PowerShell，Node v26.8.1，npm 12.2.0；浏览器测试使用本机 Microsoft Edge。
- 技术源码摘要：`725d539245e2d75d30c67df136234dff570ce1c342bddd95114558a335ec8885`；W5 清单中的 649 个文件本轮全部匹配。
- 本轮仅增加评估资料，未修复产品、提交、推送、访问真实业务 runtime 或签名/广播外部链上交易。合约反例在独立的进程内本地 EVM 执行。
- `issue-register.json` 是本轮问题清单，不覆盖旧批次的 issue register；全部为未整改状态。`manifest.json` 记录本轮交付文件的 SHA-256。

## 本轮执行

| 命令/操作 | 结果 | 保存的证据 |
|---|---|---|
| `npm test` | 1,376 项；1,374 通过，2 跳过，0 失败 | `logs/application-tests.txt` |
| `npm run test:contracts` | 151 通过 | `logs/contract-tests.txt` |
| `npm run test:w2` | 6 通过 | `logs/w2.txt` |
| `npm run test:w3` | 3 通过 | `logs/w3.txt` |
| `npm run test:w4` | 21 通过 | `logs/w4.txt` |
| `npm run test:w5` | 13 通过 | `logs/w5.txt` |
| `npm run lint` / `npm run check` / `npm run build` | 均通过 | `logs/lint.txt`、`logs/check.txt`、`logs/build.txt` |
| `npm run test:browser`，指定系统 Edge | 18 通过 | `logs/browser-tests-edge.txt`、`browser-results.json` |
| `npm audit --omit=dev --audit-level=high --json` | 生产依赖 0 个已报告漏洞 | `audit-production.json` |
| `npm --prefix hardhat audit --audit-level=high --json` | 合约工具链 0 个已报告漏洞 | `audit-contract-toolchain.json` |
| 独立本地合约反例 | A01–A04 全部复现，对应 CA-01–CA-04 | `contract-probes.mjs`、`contract-probes.json`、`logs/contract-probes.txt` |
| 定价敏感性实验 | 同风险/期限下，仅利润输入改变即可显著改变报价 | `pricing-probes.json` |
| 离线 UI 实际浏览 | 桌面可查看；390px 视口页面宽度 1100px | `ui-desktop.png`、`ui-mobile.png`、`ui-desktop.yaml` |
| 公共测试网只读查询 | 固定块状态、资金与份额、4 笔交易及六份 runtime/关键绑定 | `readonly-verification.mjs`、`readonly-verification.json` |
| 同 SHA GitHub 检查 | 15/15 success | `github-checks.json` |
| 同 SHA 独立主机恢复 artifact | passed；3839ms；未提供原交易签名私钥；零广播 | `ci-recovery/receipt.json` |

应用测试初次错误设置 `NODE_TEST_CONTEXT=assessment`，被 Node 识别为递归测试，**没有执行真实测试**；保留在 `logs/application-tests-invocation-skipped.txt`。移除该变量后的结果才是表中的结果。

浏览器初次因缺少 Playwright 对应的 Chromium 可执行文件，18 项启动失败；保留在 `logs/browser-tests.txt`。随后指定本机已有 Edge，18 项通过。这是执行环境修正，没有产品修复。

`.log` 原始文件仍保留在工作目录，但被仓库通用规则忽略；`logs/*.txt` 为逐字节副本，便于将来纳入版本管理。没有删除或改写失败记录。

## 复现说明

以下命令从项目根目录的 PowerShell 执行。反例脚本输出到同目录 JSON；需要保留本次记录时应先复制整个证据目录，再进行新一轮执行。

```powershell
$env:AGENTBL_W2_INTEGRATION = '1'
Push-Location hardhat
try {
  node ../docs/evidence/current-assessment-2026-10-18/contract-probes.mjs
} finally {
  Pop-Location
  Remove-Item Env:AGENTBL_W2_INTEGRATION -ErrorAction SilentlyContinue
}
```

该脚本依赖现有本地测试 helper，使用本地部署、测试私钥和 mock token；不会连接外部 RPC。它验证的是**当前不期望的行为可以发生**，不是修复后应长期保留的通过断言。整改后应把业务不变量写入正式回归测试。

只读核验脚本使用公开的 `public/rights-instance.json` 与 RPC，不创建 signer：

```powershell
node docs/evidence/current-assessment-2026-10-18/readonly-verification.mjs
```

本轮快照为 Injective EVM testnet 1439 的区块 `144263998`，hash `0x4bf360948a937073d0136688d70dff5e7cb060f000c96de8eb7b7e10abf0a2e0`。脚本重跑会选择新的确认区块，因此不应期望时间、余额和区块号永远不变。`bindings` 是加载时的部署核验，`snapshot` 是指定区块的资金/份额状态；二者的读取时点不同。收据成功与 canonical 状态分别检查。

浏览器测试可使用已验证存在的本机 Edge：

```powershell
$env:AGENTBL_CHROMIUM_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm run test:browser
Remove-Item Env:AGENTBL_CHROMIUM_PATH
```

CI 查询必须显式指定 `liaboveall/Agent-BL-Upgrade`，因为本机 `gh` 默认解析可能指向 upstream。对应运行：[39085962345](https://github.com/liaboveall/Agent-BL-Upgrade/actions/runs/39085962345)。恢复收据是该运行的 artifact，本轮未重新执行远端恢复工作流。

## 证据边界

本轮重跑了表中的本地检查，没有重跑 coverage、十分钟压测、本机 Docker、真实模型质量评测、真实钱包人工验收或真实业务融资。CI、既有测试网及恢复 artifact 通过显式 revision 和当前只读查询核对；这些均不代表真实企业、货权、估值、法律适用、真实资金与密钥失联恢复已经验收。

UI 截图来自本轮启动的离线浏览器测试服务。该测试入口不启动正式 OperationsMonitor，所以其 readiness 返回 `unmonitored/503` 不是正式部署故障证据。390px 整页溢出则同时有当前根样式和实际尺寸支持。

四个协议问题为本地合约实证，条款与分页问题为源码确认，移动问题为源码与 UI 实测。没有将它们描述为已发生的外部攻击。费用问题仍需决定“可选费用”还是“必须可靠收取的费用”这一业务政策。
