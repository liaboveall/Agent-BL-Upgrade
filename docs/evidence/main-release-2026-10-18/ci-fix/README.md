# 首次 CI 问题及修复验收

首次发布候选为 `53633065592083858a05f1ca5b3d5a63e96bb371`。其 GitHub push run 为 `39115131080`，Linux Node 22/24 和 Windows Node 22 的应用测试均发现同一问题：`tests/cargoImages.test.js` 仍读取已退役的 `data/cases/archive`。本机遗留空目录使本地检查通过，而新 Git 检出不存在该空目录，导致 ENOENT。

修复为只遍历当前目录中的案例，并移除断言中“历史案例”的说明；不恢复旧数据或依靠 `.gitkeep` 掩盖旧依赖。原本机空目录也已移除，修复后的专项和完整测试在该目录不存在时执行。

- `original-linux-node24-failure.txt`、`original-windows-node22-failure.txt` 保留初始错误日志；其中可能包含终端 ANSI 控制字符。
- `cargo-images.txt`：图片专项 3 项实际通过。
- `coverage.txt`：完整应用及覆盖率；`preflight.json`：包含实际 EVM 路径的固定门禁。
- `source-manifest.json`：修复后的 577 份技术源码，SHA-256 为 `bb33dcf031fa9405b5844577490dd2039391a91915b662f7d54ffc89e45f3de6`。
- `testnet/`：当前 source hash 的新版本及第 5 批包含证明。上一候选的第 4 批和原证据均保留。

本次只改变测试的目录依赖，应用和合约逻辑与上一候选相同。完整技术清单包含测试文件，因此重新注册并锚定其新摘要，新增 3 笔测试网交易；没有新增资金池或资本交易。

最终锚定交易为 `0xe8fb2e16a58cabebdcd07dc412a033e12dc5d77a4b88e88641b8f4917b55ecdd`。提交后的完整 CI、Docker revision、独立主机恢复和最终主分支状态继续由该提交的 GitHub checks / artifacts 及 runtime 收据核验。
