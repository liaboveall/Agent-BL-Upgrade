# W2 提交前验证补充

2026-10-17，用户在本地验收后明确要求“提交推送”。交付分支为 `feat/w2-capital-ledger`，包含 W2 实现、已验证的 W1 前置修复、货物展示资源及原始审查和测试证据。本机 `.claude/launch.json` 保留在本地并加入忽略规则。

原始 [W2 本地验收](../w2-local-2026-10-17/README.md) 与所有失败日志保持原样。其中 `committed=false`、`pushed=false` 和远端 CI 未运行均描述初次验收时点；当前 Git 提交、远端分支和对应 Actions 运行是后续交付状态的依据。

提交前复核原始清单中的 522 个源码、构建输入、测试和资源文件，只有 `Dockerfile` 有新增变化：前端钱包现在导入 `src/chain/protocolV5Abi.js`，Docker 的 web 构建阶段需要复制 `src/chain`。差异记录见 [source-delta.json](source-delta.json)。应用和合约源码仍与原始完整回归一致。

[staged-source-manifest.json](staged-source-manifest.json) 另外记录 524 个暂存区 Git blob 的内容哈希，包含忽略规则和属性，按实际提交字节计算，避免 Windows/WSL 文本换行转换造成歧义。旧证据中的原始工作区哈希保持不变；该清单与旧清单的字节口径不同。

使用临时空目录，仅复制 Docker web 阶段允许的输入：`package.json`、`package-lock.json`、`web/`、`public/`、`src/core/`、`src/chain/`。从锁文件执行 `npm ci --ignore-scripts` 后 `npm run build` 通过，收据见 [preflight.json](preflight.json) 与两个日志。该过程未复用工作区的依赖或构建产物。

本机 Docker Desktop 的 Linux daemon 未运行，因此此项本地检查仅证明构建输入完整；真实容器构建、非 root 运行、只读文件系统和健康检查由推送后的 `Docker image` CI 作业验证。CI 会在已推送分支上手动触发，验收必须核对对应提交 SHA 和全部作业的终态。此记录写入时尚未执行远端 CI，不提前声称其通过。

完整本地回归已通过：应用 1333 项、合约 132 项、真实本地 EVM/HTTP 集成 Windows 与 WSL 各 6 项、浏览器 10 项，以及覆盖率门槛、lint、check 和 build。本次提交推送不包含新部署或真实资金操作。
