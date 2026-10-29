# 公开融资条款副本

已批准的融资披露包（`agentbl-financing-disclosure-v1`）是公开文件，投资人本来就可以下载并离线核验。服务读取条款时以加密 vault 为准；vault 不可用（另一台实例、未配置密钥或 vault 丢失）时，依次查找运行目录 `rights/public-disclosures/` 和本目录。

- 文件名是披露哈希：`<disclosure_hash>.json`（小写）。服务按内容重算哈希，不一致的文件一律忽略。
- 运行中的服务在首次提供某个已批准条款时，会把副本写入运行目录的 `rights/public-disclosures/`。要让新 checkout 也能显示某个实例的条款，把那里的文件复制到本目录并提交。
- 也可以从实例的公开记录导入：`npm run disclosures:import -- data/runtime/n5-deployment/<实例>/deployment-state.json`。工具只复制与配置实例链上条款逐项一致的包；当前目录已包含 v4 实例 `n5-v4-20261029` 与 v3 实例 `n5-v3-20261027` 各自全部 25 个池的条款。
- `npm run check` 会重算本目录每个文件，哈希与文件名不符即失败。
- 只放已批准、已发行的条款。未批准的修订只存在于 vault 中，不会写出。
- 副本不能代替链上核对：页面和签名前仍会把它与链上 `termsHash`、角色和池参数逐项比对。
