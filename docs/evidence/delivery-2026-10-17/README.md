# 提交前干净目录验证（2026-10-17）

用户已授权提交、推送与测试。本记录生成于提交前，保留后续 GitHub 同一提交的 CI 核验边界。

从暂存内容的 Git tree `2c13ce093eaca1f84518adaf644b7d3a9d4fc674` 导出独立目录，使用 **Node v24.22.0 / Linux** 分别执行根目录和 `hardhat/` 的 `npm ci`，不复用开发目录的依赖。结果：

| 检查 | 结果 | 证据 |
|---|---|---|
| lint / check / Vite build | 通过 | `logs/lint.log`、`logs/check.log`、`logs/build.log` |
| 应用测试及覆盖率 | **1305 / 1305**，零跳过；行 **94.62%**、分支 **85.05%**、函数 **92.58%** | `logs/coverage.log` |
| Solidity | **92 / 92**，本地 EVM | `logs/contracts.log` |
| 桌面 Chromium | **8 / 8**，零跳过、零 flaky | `logs/browser.log`、`browser.json` |
| Agent 评测 | **20 / 20**；44 对话 / 100 轮、1350 定价检查、26 注入案例 | `logs/evaluation-with-metadata.log` |

`source-manifest.json` 对干净 Git 文件字节取 SHA-256，包含源码、测试、配置与锁文件，共 **491** 个文件。映射的规范 JSON（按路径排序、紧凑分隔符）SHA-256 为 `27f58dc052e88b72a2e9e9d88dce68ccb009a45aac12db32a68dc7d56e252710`。最终提交可新增交付文档；源码逐文件哈希应与本清单一致。原整改证据按当时工作区字节取哈希，两种换行表示不能混用；`.gitattributes` 保留证据目录的原始字节，干净导出中 60 份原证据哈希均一致。

第一次评测 CLI 因导出目录没有 `.git` 而失败，记录保留在 `logs/evaluation.log`。随后以只读 Git 元数据和指向导出目录的 `GIT_WORK_TREE` 重跑原 CLI，通过全部闸门；没有替换评测逻辑。`local-validation.json` 记录生成时状态，`artifact-manifest.json` 记录本目录文件哈希。

此前 preflight 的 **66 PASS / 0 WARN / 5 Live SKIP / 0 FAIL** 和只读链核验见 [整改证据](../remediation-2026-10-17/README.md)。本次本地检查不代表远程 CI、真实模型、钱包、USDC 付款、合约部署或生产发布；两份 v3 候选仍未部署。推送完成后须核对远程 `main` 与本地 SHA，并等待该 SHA 的全部 CI 作业完成。
