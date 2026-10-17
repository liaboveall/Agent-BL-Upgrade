# W2 本地实现与验收交付

日期：2026-10-17，Asia/Singapore。接手分支：`feat/w2-capital-ledger`，HEAD：`788db8a`。Qoder 已提交 Task 1–9 的初版；本轮完成剩余实现、恢复与安全边界、实际集成和 Task 10 的本地验收。

**范围结论：A09、B01、B02、B03、B12 更新为 `IMPLEMENTED`，适用于本地 v5 源码候选。没有新增 Git 提交、推送、远端 CI、测试网部署或资金迁移。** 接手前的 W1、图片与其他未提交改动保留；最初状态见 `initial-status.txt`。

## 最终验证

| 检查 | 结果 | 收据 |
|---|---|---|
| 全量 Solidity / Hardhat | 132 通过 | [contracts-final-5.log](logs/contracts-final-5.log) |
| 全量应用测试与覆盖率 | 1333 通过，0 失败 | [coverage-final-3.log](logs/coverage-final-3.log) |
| 覆盖率 | 行 93.83%、分支 84.71%、函数 91.83%；门槛 88% / 72% / 86% | 同上 |
| 真实 EVM + HTTP + JS 钱包适配器 | 6 通过，0 跳过；Windows 原生运行 | [cross-layer-windows-final-9.log](logs/cross-layer-windows-final-9.log) |
| 真实 EVM（WSL Linux） | 同一冻结源码 6 通过，0 跳过 | [cross-layer-linux-final-10.log](logs/cross-layer-linux-final-10.log) |
| 中英文浏览器 | 10 通过；含 390px 持仓弹窗与钱包切换时旧持仓立即清空 | [browser-final-1.log](logs/browser-final-1.log) |
| lint / 构建 / check / diff 检查 | 通过 | [lint](logs/lint-final-3.log)、[build](logs/build-final-1.log)、[check](logs/check-final-3.log)、[diff](logs/diff-check.log) |

运行平台为 Windows / WSL 的 Node 26.8.1。Hardhat 编译参数继续为 Solidity 0.8.24、viaIR、Paris、优化 200 runs；v5 pool 部署字节码为 23,822 bytes，低于 EIP-170 的 24,576 bytes 上限，测试没有放宽合约大小限制。

最终源码摘要和逐文件 SHA-256 见 [source-manifest.json](source-manifest.json)，覆盖 522 个应用、合约、测试、脚本、构建配置与相关公开数据/资源文件。机器可读结果见 [validation.json](validation.json)。本地工作区包含未提交实现，HEAD 本身不能代表这些新修复。

## 本轮补齐的行为

- 原子认购、按池/资产托管、六位小数校验、SafeERC20、余额差额检查、转账重入保护。失败转账、失败 mint、税费资产、返回 false、不返回值、并发超卖均有回归。
- 达标但未售罄的募集在截止后可 `finalizeFunding`；降价导致售罄仍未达标时可以退款。支持分批放款、失败退款重试、暂停/冻结下到期退款，以及募集期清算后的精确退款和最后解押。
- `repay` 实际到账与付款归证分开计量，结算合并未放款本金。全额、部分、零、超额回收都有确定领取结果；最小单位尾差由最后领取者取得，首笔领取后锁定费用。终态后拒绝迟到回款；失败收款回滚且不阻塞其他持有人。
- 持久化认购和领取意图，在任何钱包签名前保存条款与 calldata；唯一交易绑定、现金分录去重、广播后只读恢复。后端不签投资者或 owner 交易。
- 账本以追加事实为权威，快照可重算；进程内队列与跨进程锁覆盖完整事务。写入 fsync、保留损坏尾行、拒绝内部损坏，日志不会轮转丢失旧付款。
- 按协议实例保存确认块 cursor；核对网络、协议版本、确认深度、块哈希及每池现金守恒。RPC 漏掉回收日志时不推进 cursor，也不把持仓标为已核对。重组保留原分录并追加失效记录，再重放规范链；现金日志缺失时按 cursor 计数发现并从部署点重建。
- 统一持仓显示 Demo / Live、协议实例、资产、份额、实际出资、可领、已领和状态。未知余额或未完成核对显示“对账中”。金额按原子精度格式化，钱包/模式变化隔离异步结果；Demo 模式不开放 Live 领取。
- v5 owner 放款、退款、费用、募集确认计划包含参数校验、合约静态预检与具体事件参数核对；新增独立 CI 作业安装 Hardhat 并运行真实集成测试。

## 证据等级与边界

真实本地 EVM 用例使用独立 Hardhat RPC、实际部署的 v5 合约、真实 ERC-20 转账、HTTP 服务和生产 JS 钱包适配器，覆盖认购、追加、退款、费用、全额/部分/零领取、崩溃后的重建、重组、遗漏日志和确认深度。它不是合成 provider 的唯一正向证据。

故障用例包含进程在持有文件锁时退出、分录写入后快照写入前失败、广播后未保存交易哈希、快照丢失、现金日志丢失、多进程争用、日志尾行损坏、链回执重组、回收日志遗漏、错误交易绑定及失败收款。

浏览器测试用隔离 Demo 服务与 UI 钱包/持仓夹具，只证明自动化页面和交互行为；真实钱包人工试用、外部支付机构、真实资金、生产断电与异机恢复、远端 CI 和新部署仍未完成。390px 证据仅针对新持仓弹窗，整站保留既有桌面布局，不能据此宣称整站已适配手机。

## 可复跑命令

```bash
npm --prefix hardhat test
npm test
npm run test:w2
npm run lint
npm run build
npm run check
npm run test:browser
```

应用测试与 EVM 集成分开运行：普通 `npm test` 不启动 Hardhat，`npm run test:w2` 编译后显式运行全部 6 条真实集成，不以 CI 环境变量跳过。独立 CI 作业同样调用此入口。

本机共享的 `node_modules` 初始只装有 Windows EDR 原生包；已在临时目录安装相同版本 `0.22.2` 的 Linux EDR 并加入被 Git 忽略的模块链接，未修改锁文件或替换 Windows 依赖。浏览器运行使用已安装的 Windows Chromium 路径；干净 CI 使用 Playwright 自行安装的 Chromium。

## 失败尝试保留

`logs/` 保留接手后失败及成功运行，后缀较早的日志不是最终通过收据，包括：

- 初次加固后的合约超过 EIP-170 大小限制；改用 v5 自定义错误后在标准 EVM 限制内部署成功。
- 新时间推进用例暴露旧报价夹具使用系统时间；改为读取 EVM 时间，并补齐旧 Agent 测试替身的 W1 ABI。
- 共享目录缺少 Linux EDR、WSL 启动超过原 30 秒上限，以及一次测试入口误继承 `NODE_TEST_CONTEXT` 而递归跳过；均保留失败日志。入口现已由实际运行的 6 条用例验证，启动输出按连续片段识别并保留 90 秒上限。
- Linux Playwright 缺浏览器；改用已有 Windows Chromium 后完成全部 10 项。
- 390px 初版用例错误地断言既有整站桌面布局没有横向溢出；保留初始截图，新持仓弹窗按自身边界和内容溢出验收，没有修改全站桌面最小宽度。

截图：[中文持仓](screenshots/positions-zh-390.png)、[英文持仓](screenshots/positions-en-390.png)。初始失败截图位于 `screenshots/initial/`。
