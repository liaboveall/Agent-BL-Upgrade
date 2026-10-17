# 账本锁释放竞争修复

第二次提交 `0445322712091a7f34b7d1f72c4c65fa4bed41b9` 的 [CI 39036360842](https://github.com/liaboveall/Agent-BL-Upgrade/actions/runs/39036360842) 九个作业通过，Linux Node 22 的多进程账本用例失败，原始日志见 `ci-39036360842-linux-node22.log`。前一轮链监听器与 Wave B 问题均已通过。

原释放操作直接对共享名 `writer.lock` 递归删除。删除过程先移除 `owner.json`、再删除目录；POSIX 在目录为空时允许竞争者将新的非空锁目录 rename 到同一名字。旧删除可能报 `ENOTEMPTY`，也可能继续删除继任者的锁，破坏后续互斥。

现在在持有锁时先将整个非空目录原子 rename 回该写入者唯一的候选路径，随后只删除这个私有目录。共享名不会处于可被替换的空目录状态，私有目录清理也不会触及新锁。死进程恢复仍使用已有非空 tombstone，不更改现金历史或回收游标。

新增真实跨进程回归在旧目录清理中途设置屏障，确认继任写入者已经持有新锁，再放行旧清理；要求继任锁的 PID 仍然存在，两个独立现金事实保留，最终份额为 200。Linux 旧实现按预期复现继任锁 `owner.json` 被删除，见 `ledger-lock-before-fix-linux.log`。Windows 旧实现不允许覆盖已有空目录，旧用例停在屏障并触发测试超时；该尝试也保留为 `ledger-lock-before-fix-windows.log`。

修复后 Windows Node 26.8.1 的完整账本 9/9；Linux Node 22.23.3 从相同源码复制的独立目录并发运行 10 轮完整账本，每轮 9/9，合计 90 项，无失败、取消或跳过。每轮包含四个独立写入进程、死进程恢复和新锁交接屏障；详见 `ledger-lock-stress.json` 与对应日志。修复后 lint 通过。

`ledger-lock-source-manifest.json` 记录本轮 524 个暂存区 Git blob，相对 `ci-fix-source-manifest.json` 仅 `src/ledger/writer.js` 和 `tests/ledger.test.js` 改变。最新提交的完整 CI 需在推送后另行确认；本记录不把前两轮部分通过结果作为最终验收。
