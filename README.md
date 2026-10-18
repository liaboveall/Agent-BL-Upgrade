# AgentBL

贸易融资区块链研究应用：单证与持有人同意、受控发行、测试代币托管、放款、回款、退款及投资者领取。

当前仅保留 **离线 Demo** 与 **受控 v5 测试网融资**。单证、身份与估值属于研究场景，真实商业准入未启用。

## 开始运行

需要 Node 22.13+。

```powershell
npm ci
npm --prefix hardhat ci
npm run compile:contracts
npm run build
npm run dev
```

浏览器打开终端给出的本地地址。Demo 可直接查看报价、风险、模拟发行、模拟认购及证据；实际测试代币融资从 **受控测试网融资与持仓** 面板操作，需配置实例并连接合资格钱包。

公开配置：钱包及服务使用 [application-config.json](public/application-config.json)，受控部署使用 [rights-instance.json](public/rights-instance.json)。服务端通过 AGENTBL_RIGHTS_CONFIG 选择并核验实际实例。详细启动、配置及验证见 [当前部署说明](docs/deployment-current.md)。

## 当前能力

- 链上签发与持有人同意，登记域内防重复占用，估值、资格及条款确认。
- 实际测试代币认购、托管、放款、回款、失败募集退款、结算后领取。
- 不可转让份额、延时治理、角色撤销、材料加密和审核。
- 按实例核对资金、未知交易恢复、规范区块确认、备份与恢复。
- 确定性研究定价、AI 辅助分析、证据包与来源解释。
- 独立 x402 付费报告与付款核验；报告付款和融资资金分别核对。

Agent 在 Demo 中模拟执行；Live 中提供分析，融资由参与者钱包通过 controlled 路由执行。MCP 已移除旧 Oracle 写入能力，所有报价使用同一当前定价入口。

## 验证与扩展

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

W2–W5 是当前集成测试的名称。应用部署不再提供 v2/v3 旧协议选择。

MCP：`npm run mcp:stdio`。离线报告示例：`npm run smoke:x402`、`npm run x402:intel`。支付、模型、行情和估值各自保留来源与验收边界。

- [当前架构](docs/architecture-current.md)
- [合约设计](docs/contracts.md)
- [运营、监控与恢复](docs/w5-delivery-operations.md)
- [当前源码综合评估](docs/project-current-assessment-2026-10-18.md)
- [历史归档](docs/archive/README.md)

旧单合约铸造、免费认购、v3 交易路径、owner CLI 及预编译实验已退役。既有链上记录保留，历史源码及测试可在归档中查阅。清理后的验证结果单独保存，不继承旧提交的测试通过声明。
