# 历史材料取回与目录规则

2026-10-18 按用户要求整理当前工作树。旧开发/评估/规划报告、阶段证据目录、归档 ZIP、`.superpowers` 任务评审、旧补丁、安装横幅与重复 Makefile 已退出当前入口。历史内容没有被重新写成“全部成功”，Git 历史保持不变。

## 冻结版本与备份

- 清理前完整提交：`19efe4e2504fb0b9624b12def29f90eee3fceb6a`。
- 评估原文：该提交的 `docs/project-current-assessment-2026-10-18.md`；问题登记和 A01～A04 原始反例：`docs/evidence/current-assessment-2026-10-18/`。
- 更早实验源码：该提交的 `docs/archive/agentbl-before-retirement-b8db411.zip` 和字节差异包，原始失败日志及各阶段证据也在同一提交中。
- 同机仓库外快照：`C:\Users\Mars\.agentbl\archives\project-reset-2026-10-18\source-19efe4e.zip`，69,532,672 bytes，SHA-256 `645c539658962130be6637cd9d2b7059bc86a765a36a502da6524b4750b99e9d`。
- 未跟踪的本地开发记录快照：同目录 `local-development-scaffolds.zip`，SHA-256 `a4ff07d288b8e185a1837ccab4b56b43e6c43adf9e1b38e7cd6372307da1ceeb`。manifest 记录大小和时间。该包仅用于本机取回，不发布，可能包含本机工具配置。
- 工作树内另外 74 份忽略的旧文档/日志也已移至同目录 `retired-local/docs/`。全部本地过程材料共 269 份，保留目录形式，不留在当前项目中。

备份是同机恢复副本，不是异地灾备。当前运行的 `data/runtime/`、`.env`、交易/vault/备份密钥和外部加密备份没有因文档清理被删除或重置。

需要原文时可只读查看：

```powershell
git show 19efe4e2504fb0b9624b12def29f90eee3fceb6a:docs/project-current-assessment-2026-10-18.md
git show 19efe4e2504fb0b9624b12def29f90eee3fceb6a:docs/evidence/current-assessment-2026-10-18/contract-probes.mjs
git archive --format=zip --output=../agentbl-history-19efe4e.zip 19efe4e2504fb0b9624b12def29f90eee3fceb6a docs
```

将取回材料解压到单独位置阅读，不恢复成当前默认代码或覆盖现有 runtime。历史反例脚本的相对导入路径需适配，使用本地 EVM，不直接对公共实例试验。

## 以后如何维护

- `README.md`：项目介绍、启动及文档入口。
- `docs/development-plan.md`：唯一开发规划、任务状态与批次交付记录。
- `docs/architecture-current.md`、`contracts.md`、`operations.md`、`data-sources.md`：当前规范；功能变化时就地更新。
- `artifacts/`：按类别和时间保存新执行产物，默认不跟踪；正式证据在发布/外部归档存储中绑定版本保留。
- `data/`：实际使用的研究样本和来源语料；`data/runtime/` 单独持久保存，不当成文档垃圾。
- `scripts/config/testnet-deployment-baseline.json`：仍被部署续跑使用的冻结公开基线，来自清理前主分支最新收据，保持原字节；不是旧报告。当前 checkpoint 优先于该基线。
- `scripts/config/retired-runtime-paths.json`：检查旧实验入口不重新出现的维护清单，不依赖历史审查目录。

不再把普通命令输出写入带旧日期的 `docs/evidence/w*`，也不为每次进度、审查、重跑建立一份永久顶层报告。历史记录通过 Git、执行产物和正式证据存储保留。
