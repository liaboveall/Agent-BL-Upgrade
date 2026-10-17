# 2026-10-17 评估整改证据

起点：`586785811842ed3ca3140563cf452d27e65d06ee`，未提交工作区。说明见 [整改报告](../../project-remediation-2026-10-17.md)。原评估目录 `../review-2026-10-17/` 未被改写。

## 最终通过结果

| 检查 | 结果 | 文件 |
|---|---|---|
| Vite 构建 | 通过 | `logs/build-final-verified.log` |
| lint / check | 通过，零 lint 警告 | `logs/lint-final-verified.log`、`logs/check-final-verified.log` |
| 全量 Node 与覆盖率 | **1305 / 1305**；行 **94.66%**、分支 **85.14%**、函数 **92.58%** | `logs/coverage-final-verified.log` |
| Solidity | **92 / 92**，本地 EVM；preflight 再次运行通过 | `logs/contracts-3.log`、`preflight-final.json` |
| 真实 Chromium 桌面交互 | **8 / 8**，零跳过、零 flaky | `logs/browser-final-verified.log`、`browser.json`、`screenshots/` |
| Agent 评测 | **20 / 20**；44 对话/100 轮、1350 定价检查、26 注入案例 | `logs/evaluation-final-verified.log` |
| Preflight | **66 PASS / 0 WARN / 5 SKIP / 0 FAIL** | `logs/preflight-final.log`、`preflight-final.json` |
| 部署字节码只读核验 | 5 MATCH，2 DIFFERENT；候选未部署 | `bytecode-current.json` |
| 生产依赖公告审计 | 本次快照 0 项已知漏洞 | `audit-production.json` |

覆盖率仅统计 `src/**`，不把 React 交互算入该百分比。浏览器覆盖 1440px 中英文四个主页面，另做 1280px 补充几何检查；axe 本次持续闸门仅检查文字对比度。工作区访问与上传只用虚构样本；浏览器 Demo 钱包桩拒绝真实发送，LIVE 失败测试仅切换 UI 的接口桩，不运行真实 Live 服务。

`completion.json` 汇总结果、执行边界及未完成外部验收；`source-manifest.json` 对当前工作区的源码/测试/工具配置逐文件计算 SHA-256。`artifact-manifest.json` 对证据文件取哈希。它们绑定未提交源文件，不把 `git HEAD` 冒充全部修改后的版本。

## 命令与隔离

```bash
npm run build
npm run lint
npm run check
npm run test:contracts
NODE_TEST_CONTEXT=review REAL_DATA=off node scripts/eval-agent.mjs --check
AGENTBL_CHROMIUM_PATH=/home/mars/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
  node node_modules/@playwright/test/cli.js test
```

最终应用覆盖率使用与 Windows 原生依赖匹配的现有 Node：

```bash
'/mnt/c/Program Files/nodejs/node.exe' --test --test-concurrency=4 \
  --experimental-test-coverage '--test-coverage-include=src/**' \
  --test-coverage-lines=88 --test-coverage-branches=72 --test-coverage-functions=86 'tests/*.test.js'
```

Preflight 在 `.env` 禁读、`REAL_DATA=off`、Demo、锚定关闭的环境执行，并生成本目录独立报告。浏览器服务器由 Playwright 启停，使用临时 runtime，禁止 `.env` 加载、真实来源、锚定和真实链监听。浏览器结束后服务器已停止。

原来安装的依赖带 Windows 原生绑定；添加浏览器工具后 npm 保留了 Linux 绑定，Windows 构建曾因此找不到 Rolldown / Lightning CSS。本次为本地 `node_modules` 补回相同锁定版本的 Windows 绑定，保留 Linux 与 Windows 两种验证方式；未删除锁文件或重装用户环境。CI 在各平台正常 `npm ci`。这些失败在 `build.log` / `build-final.log` 及 `native-binding*.log` 中保留。

## 失败尝试和外部边界

`tests-initial.log`、`tests-2.log`、`tests-3.log`、`contracts-initial.log`、`contracts-2.log`、`coverage-final.log`、`preflight.log`、`ingest-debug.log` 等保留开发过程中的失败，**不属于最终通过记录**。其中 `tests-2.log` 的旧 Linux 进程因失败后的既有测试未退出而被终止；`coverage-final.log` 记录将真实离线源日期接入后，模拟分析授权时钟尚未分离的中间失败；后者已通过保留 `source_freshness` 并独立处理单证模拟时钟修复。第一次 preflight 另发现 CLI smoke 的旧 `Repriced` 断言，已更新并全量重跑。

只读 RPC 核验中的 EBLRegistry / RWAOfferingPool DIFFERENT 是当前 v3 候选与 v2 部署的真实差异，不算部署验证通过。未发任何链交易、USDC 付款、owner 操作或锚定。没有远程 CI、真实模型/企业单证/合规提供方、资金托管兑付、生产负载、独立灾备或人工设备验收。本地通过不能替代这些条件。
