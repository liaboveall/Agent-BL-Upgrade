# 调查尝试记录

1. `npm run test:contracts`：当前现有依赖环境下执行成功，92 个 Mocha 合约测试通过。原始命令回执已在本次会话保留。
2. WSL Linux Node v26.8.1 直接执行 `local-contract-probes.mjs`：失败于现有 Hardhat EDR 仅有 Windows 原生绑定，找不到 `@nomicfoundation/edr-linux-x64-gnu` / `edr-wasm32-wasi`。没有按依赖错误提示删除 node_modules 或锁文件，也未安装依赖。
3. 改用 `/mnt/c/Program Files/nodejs/node.exe`（v26.8.1）执行同一调查脚本：本地操作已运行至 Oracle 重复提交检查，但 Hardhat 对此 revert 未直接呈现 reason，调查脚本按 message 检查失败。错误 ABI 数据实际包含 `decision replay`。
4. 只修正调查脚本的 Error(string) ABI 解码后重跑：8 项本地合约观察全部确认。项目合约、业务源码和依赖未变。
5. 跨层调查脚本：4 项观察全部确认；采用真实函数 + 合成回执 fixture，未发送网络请求或实际付款。
6. opening / settlement / chain watcher / protocol-v3 deployment 四个 Node 测试文件：105 个通过点，退出码 0，输出见 targeted-node-tests.log。
7. provider-only 固定区块读取：成功，输出见 live-readback.json。脚本仅允许五个只读 RPC 方法，没有创建 signer、读 .env 或发送链上交易。
8. 三个新增调查脚本的 ESLint：退出码 0，0 warning。

复现命令（仓库根目录的 WSL bash）：

```bash
node docs/evidence/blockchain-review-audit-2026-10-17/cross-layer-probes.mjs
```

本地合约反例需要使用与现有 Hardhat 原生依赖一致的运行时。本次从 hardhat 目录执行：

```bash
"/mnt/c/Program Files/nodejs/node.exe" ../docs/evidence/blockchain-review-audit-2026-10-17/local-contract-probes.mjs
```

固定区块证据是采集时的快照；再执行 live-readback.mjs 会读取新的固定区块，不应覆盖原有 JSON 来改写旧结果。
