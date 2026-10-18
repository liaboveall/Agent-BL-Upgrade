# 开发历史归档

当前应用只有离线 Demo 与受控 v5 测试网融资两种执行方式。旧单合约铸造、v2/v3 免费认购、RiskPricingOracle 写入、Agent owner CLI 和预编译实验均已退役。

清理前完整已提交源码保存在 [agentbl-before-retirement-b8db411.zip](agentbl-before-retirement-b8db411.zip)，基线提交为 `b8db411de044b1132f14419a432be6da6ff1501b`。ZIP 保留原目录结构，包含旧源码、测试、部署地址、文档和该提交已有的证据；不包含被 Git 忽略的密钥、runtime 或依赖。

删除文件的逐项路径、大小与 SHA-256 见 [退役清单](../evidence/legacy-retirement-2026-10-18/retired-files.json)。旧的 `docs/evidence/` 文件保持原位，记录的是各自原提交的执行结果，不是清理后版本的验收。

阅读旧报告中的已退役源码链接时，应在独立目录解压此 ZIP 后按原路径查阅。当前源码不再提供旧部署的运行兼容层。链上已部署合约和交易仍存在；本轮没有向旧合约发送暂停、迁移或其他交易。

现有 runtime、原交易恢复记录和资产占用没有删除。历史数据如需进一步退役，须按实例核对；新研究 Agent 使用独立的 `research-agent/` 命名空间，受控融资继续使用原 `controlled-capital-<pool-address>/` 账本。

归档只用于查阅和独立复现，不属于当前应用的启动、测试或构建输入。

Git 归档与原 Windows 工作区有三份文本的换行字节差异。为保留原 W5 源码清单的精确摘要，另存 [字节补充包](baseline-byte-overrides.zip)。需要复算原清单时，先在独立目录解压完整 ZIP，再覆盖补充包；649 份原源码的字节均可核对。具体差异及两个 ZIP 的摘要见 [保存验证](../evidence/legacy-retirement-2026-10-18/baseline-preservation.json)。
