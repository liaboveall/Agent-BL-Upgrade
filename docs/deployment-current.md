# 当前运行方式

需要 Node 22.13+；应用与合约依赖分别安装。首次使用：

```powershell
npm ci
npm --prefix hardhat ci
npm run compile:contracts
npm run build
npm run dev
```

默认是 Demo。研究报价与模拟发行不需要钱包；没有合约支付，也不返回伪造交易哈希。真实测试代币操作使用受控融资面板。

公开配置分为：

- `public/application-config.json`：唯一测试网络、钱包连接、当前 v5 地址、PaymentOracle 与证据锚定服务。
- `public/rights-instance.json`：受控实例的六份部署、绑定、研究角色和部署区块。

服务端通过 `AGENTBL_RIGHTS_CONFIG` 明确选择受控实例，运行时核对链、代码和权限；不能仅凭公开地址显示已连接。另需配置管理员认证、独立材料密钥和持久 runtime。配置格式和范围不允许旧融资合约或主网融资路径。

Agent 在 Demo 中演示分析、审批及模拟状态变化；Live 中记录分析建议，实际融资通过参与者钱包和受控控制器完成。旧 owner CLI、自动 Oracle 更新和旧池自动映射已退役。证据锚定需要显式开启及专用 `AGENT_ANCHOR_PRIVATE_KEY`，不复用融资或部署密钥。

验证命令：

```powershell
npm run lint
npm run check
npm test
npm run test:contracts
npm run test:w2
npm run test:w3
npm run test:w4
npm run test:w5
npm run test:browser
npm run preflight
```

W2–W5 命令分别保留资金、权利、证据/支付、运营恢复的集成验证，名称是测试批次，不表示应用仍运行多套协议。

x402 使用独立支付配置。`npm run smoke:x402` 和 `npm run x402:intel` 用于 Demo；`npm run smoke:x402:live` 会进行外部测试网付款，须在明确的交易授权范围内使用。`npm run mcp:stdio` 提供当前研究工具和只读部署资源。

容器、监控及备份见 [运营说明](w5-delivery-operations.md)。本地清理没有自动更新远端部署；后续部署必须重新生成该版本的验证与源码清单。

部署命令在 `data/runtime/w5-deployment/deployment-state.json` 保存当前续跑状态，原 W5 收据只作为首次迁移来源。`AGENTBL_DEPLOYMENT_EVIDENCE_DIR` 可指定新的收据目录；未指定时按时间写入 `docs/evidence/current-deployment/runs/`。`npm run deploy:w5 -- --status` 只读核对链上实例；`--smoke` 续跑测试资金生命周期，`--anchor` 注册并锚定当前源码版本，后两者需要明确的测试网交易授权。
