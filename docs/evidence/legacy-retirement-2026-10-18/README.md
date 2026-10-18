# 历史实验退役证据

日期：2026-10-18（Asia/Singapore）。交付说明见 [清理报告](../../legacy-retirement-2026-10-18.md)，历史恢复方式见 [归档说明](../../archive/README.md)。

`*-accepted.*` 是最终复核记录；其他日志保存清理过程中原始失败、迁移检查及中间通过，不能互相替代。

- `source-manifest.json`：576 份当前技术源码的字节摘要，基线提交加未提交修改。
- `source-bindings.json`：技术源码与 preflight 的 Agent 评估语料两种范围分别复算。
- `retired-files.json`：119 个退役文件的原路径、大小、原工作区摘要。
- `baseline-preservation.json` / `preservation-verified.json`：归档、三份字节补充及原冻结 649 份源码的恢复验证；原评估证据 30 份未变化。
- `coverage-accepted.txt`：应用 1,108 通过、2 项显式集成跳过、0 失败，覆盖率门槛通过。
- `w2-accepted.txt` / `w3-accepted.txt` / `w4-accepted.txt` / `w5-accepted.txt`：当前资金、权利、证据支付、运营恢复的独立本地集成结果。
- `preflight-accepted.json`：70 项固定门禁，包含实际执行 Solidity 套件和启用集成路径的完整应用测试；4 项 Live 检查因 Demo 范围跳过。
- `browser-accepted.json` / `browser-artifacts/`：Microsoft Edge 浏览器结果与截图，18 项通过。
- `read-only-instance-check.json` / `.mjs`：公开测试网只读核验与复现脚本。PaymentOracle 的完整 runtime 与可执行代码匹配情况分别记录。
- `dependency-check.json` / `verify-current-dependencies.mjs`：字面量静态/动态导入、require、npm JS 直接命令目标及退役路径检查。
- `audit-*.json`：应用生产依赖及合约工具链的依赖审计。
- `validation.json`：最终结果汇总和边界；`manifest.json`：交付文件的 SHA-256。

`read-only-instance-check-initial.*` 保留共享 PaymentOracle 元数据差异导致的初次严格匹配失败；中间结果另存 `*-intermediate.json`。`coverage-final-verified.txt` 保留一次尚不能完全证明根因的 MCP 本地 fetch 失败。`w4-shared-cache-failure.txt` 保留并发构建缓存竞争。所有这些记录都没有被最终通过声明抹去。

外部链上广播 0 次；没有读取真实 `.env`、修改远端部署、提交或推送。真实 runtime 和原有密钥/恢复材料保持原位。测试使用临时 runtime 和本地 EVM，不能证明真实支付、法律准入、外部模型质量或正式生产恢复。
