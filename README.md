# AgentBL

一个贸易融资区块链研究应用，连接单证、持有人同意、融资条款、测试代币托管和投资者退出。前端支持中文与英文，资金操作由参与者钱包逐次授权。

默认研究场景是虚构铜货物从 Singapore 运往 Shanghai，使用 Injective EVM 测试网的 `TEST_USDC`。应用提供离线 Demo 和受控测试网融资两种体验。

## 可以做什么

- 签发与登记研究单证，确认持有人授权，检查估值、资格和材料审核。
- 展示并独立复算完整融资条款；条款、钱包或报价变化后重新确认。
- 用测试代币完成认购、托管、放款、回款、退款、损失结算和领取。
- 保留份额销毁后的迟到回款权利，支持多投资者分别领取。
- 分页查询资金池与持仓，核对链上余额，恢复未知交易并重建账本。
- 提供确定性研究定价、AI 辅助分析、材料证据包和独立的 x402 付费报告。

AI 提供分析和解释，不能替参与者签名或自主放款。x402 报告付款与融资资金分别记账。

## 当前交付状态

新 v2 已完成测试网部署、配置切换、三类资金路径、迟到回款、账本核对和本机容器恢复验证。旧 v1 保留独立退出服务。已有部署在本机运行时，可直接访问：

| 入口 | 地址 |
| --- | --- |
| 当前 v2 融资与持仓 | <http://127.0.0.1:3000/#/finance> |
| 旧 v1 查询与退出 | <http://127.0.0.1:3001/#/finance> |

**唯一剩余验收项：由未参与开发的人实际完成钱包操作和余额核对。** 步骤与记录要求见[人工验收](docs/acceptance.md)。自动化钱包和浏览器测试不替代该验收。

真实手机、独立主机恢复、签名权接管和商用准入等后续项目已从本次交付范围取消；取消不表示已经验证这些能力。应用仍限研究测试资产，不处理真实贸易融资。

## 本地启动

需要 Node.js **22.13 或更高版本**及 npm，推荐 Node.js 24。

```sh
npm ci
npm --prefix hardhat ci
npm run compile:contracts
npm run dev
```

打开 <http://127.0.0.1:3000/#/finance>。`dev` 会先构建前端；此后可用 `npm start` 启动已构建版本。若已有部署占用 3000，在自己的 `.env` 中设置其他 `PORT`，并使用独立的 `AGENTBL_RUNTIME_DIR`。

Demo 无需钱包私钥或模型密钥。需要自定义配置时，将 [.env.example](.env.example) 复制为 `.env`，按实际启用的功能填写。不要覆盖已有 `.env`。

### 受控测试网

- 网络：Injective EVM Testnet，chain ID **1439**。
- [application-config.json](public/application-config.json)：前端网络与合约配置。
- [rights-instance.json](public/rights-instance.json)：受控实例及部署清单。
- 服务端使用 `AGENTBL_RIGHTS_CONFIG` 选择清单；两份公开配置必须对应同一实例。
- 连接已登记、具备相应权限的钱包，切换至 Live，按角色工作台完成操作。服务端需配置管理员认证、材料密钥和持久运行目录，见[运行说明](docs/operations.md)。

已有实例的材料、交易检查点和账本属于持久业务状态。不要把旧实例数据复制进新池目录，不要删除检查点后重新执行历史交易。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建 React 页面到 `dist/` |
| `npm run dev:web` | 单独启动前端开发服务 |
| `npm run lint` / `npm run check` | 代码、配置、资源及源码一致性检查 |
| `npm test` / `npm run test:coverage` | 应用回归与覆盖率 |
| `npm run test:contracts` | Solidity 合约回归 |
| `npm run test:capital` / `npm run test:rights` | 实际本地 EVM 的资金与权利流程 |
| `npm run test:evidence` / `npm run test:operations` | 证据、支付、停止及恢复回归 |
| `npm run test:finance` | 角色流程与 25 池分页集成 |
| `npm run test:browser` | 双语页面、键盘和钱包上下文回归 |
| `npm run build:clean` | 两次干净构建及输出比对 |
| `npm run verify:release` | 新 checkout 的完整本地交付检查 |
| `npm run terms:verify -- <条款.json>` | 离线复算公开融资条款 |

浏览器测试首次运行前执行 `npx playwright install chromium`，或用 `AGENTBL_CHROMIUM_PATH` 指定可用的 Chrome/Edge。CI 自动执行应用、合约、集成、浏览器、构建、容器和依赖检查；新修改以其自身提交的结果为准。

## 项目结构

```text
src/          API、资金账本、权利、定价、Agent 与支付
web/          React 双语界面
hardhat/      合约、合约测试与编译配置
public/       公开实例配置与浏览器资源
data/         研究样本、来源语料及独立持久运行目录
scripts/      维护、验证、测试网与备份工具
tests/        应用、集成和浏览器回归
docs/         当前说明与唯一待办的人工验收
```

`data/runtime/`、`.env`、依赖、构建输出和测试产物不进入 Git。历史开发计划、评审报告及阶段性脚手架已移出当前目录，旧版本可通过 Git 历史取回。

## 技术与边界

前端使用 React、Vite、ethers；服务端使用 Node.js、Express；合约使用 Solidity、Hardhat。链下材料加密保存，现金事实追加写入 JSONL，快照可以重建，每个运行目录只允许一个写入进程。

合约约束已登记对象、授权和进入合约的测试代币。材料哈希不能证明真实货物或债权；登记域外的重复融资不由本系统自动消除。研究角色的多个地址不代表独立组织，测试代币不等于真实美元。份额不可转让，不提供二级交易。

- [架构与信任边界](docs/architecture-current.md)
- [合约与资金规则](docs/contracts.md)
- [运行、备份与维护](docs/operations.md)
- [研究数据与可选模型](docs/data-sources.md)
- [人工验收](docs/acceptance.md)
