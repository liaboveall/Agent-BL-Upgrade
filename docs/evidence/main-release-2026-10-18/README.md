# 主分支发布证据

对应 [发布记录](../../main-release-2026-10-18.md)。范围：用户授权的本地 Docker 更新、受控测试网验收及版本锚定、提交推送、合并与已合并分支清理；不部署公网服务器。

- `source-manifest.json`：提交前准确技术源码字节，577 份文件。
- `coverage.txt`、`preflight.json`、`browser.json`、`deployment-continuation-tests.txt`：本地最终验证。
- `pre-upgrade-backup.json`：升级前加密快照收据，备份和解密配置均在仓库外。
- `stale-lease-verification.json`：原写入租约归属及旧容器停机验证；原租约记录保留在 runtime。
- `docker-build.txt`、`docker-demo-smoke.json`、`docker-controlled-smoke.json`：构建和容器内/持久实例检查。
- `docker-controlled-smoke-initial.json`：首次监控采样完成前的 503 保留记录。
- `docker-operations-first.json`：首次成功就绪的材料、控制面、存储和队列观察。
- `testnet/`：当前部署续跑状态、融资/退款/付费报告核对、新版本锚定及包含证明；原 `w5-2026-10-18/` 不覆盖。
- `recovery/receipt.json`、`recovery/replacement.txt`：同物理机替换 Linux 容器恢复；原 Windows 源目录在替换容器运行时离线。
- `branch-preservation.json`：分支清理前的引用清单；完整 Git bundle 在操作员目录保存。
- `precommit-validation.json`、`manifest.json`：提交前汇总与文件摘要。

早期 `deployment-continuation-tests-initial.txt` 记录错误的父进程测试上下文导致测试没有执行；后续专项实际执行 2 项，完整应用套件也执行这两项。不将初次未执行记录算作通过。

提交后的最终 Git SHA、CI 和独立主机恢复以 GitHub 同 SHA checks / artifacts 为准；最终镜像标签、运行 revision 和分支清理结果另存本机 runtime。这样记录验收结果无需再修改被验收的源码提交。
