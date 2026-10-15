# WP2.6：Live USDC 回执与结算

Live 管理员提交 USDC 转账哈希和还款金额，服务器读取实际交易及成功回执，核对测试网、既有 USDC 地址、收款地址、精确金额、确认数和规范区块后才接收证明。付款、到港证明分别批准并签名记录；链上两份证明都齐备后才提出独立的 SETTLE 审批。**合约只记录还款与证明，不托管或分配资金。**

本地实现使用实际 ABI 编解码的隔离链桩验收。没有执行真实 USDC 转账、owner 交易或真实钱包试用；也没有改动或部署合约。

## 配置与证据

`AGENT_SETTLEMENT_RECIPIENT` 是明确配置的贸易还款收款地址，默认空。空值关闭 Live USDC 付款接入。它不继承 owner 地址或购买 AI 报告的 `X402_PAY_TO`；部署者必须分别确认两类用途。服务器和 owner CLI 配置同一个公开收款地址，沿用 `AGENT_CHAIN_CONFIRMATIONS`（默认 1）规定最低确认数。

USDC 地址复用仓库 `src/x402/config.js` 的测试网映射，网络锁定 1439。请求里的资产、收款地址、原子金额和 `payment_verification` 均不能改变服务器校验目标。客户端不能凭一个自报的“已核验”字段获得信任。

`repayment_amount` 是 USDC 面额，推荐十进制字符串，最多六位小数。例如 `"1.234567"` 必须编码为 `1234567` 原子单位。代码不做浮点四舍五入，不把面额整数误当成原子金额；超精度、指数表示、零、溢出以及不安全的数字输入会被拒绝。大金额必须使用字符串。

核验要求：交易及回执哈希一致、交易属于 1439、回执成功、确认数达标、回执区块哈希仍属于当前规范链；恰好一个匹配资产、收款地址及金额的 `Transfer`。被移除的日志、错误资产/地址/金额、含糊的重复匹配、零地址铸币和自转账均不能证明付款。审计记录保留真实转出地址、收款地址、金额、区块、日志序号及确认门槛。

这证明了一笔符合条件的链上转账，不证明付款人的法律身份、该转账对应哪一份商业债务或实际清偿是否充分。管理员负责把证明关联到正确贸易。到港证明由管理员提交引用，合约记录其 bytes32 承诺；本包不验证物理到港或传感器。银行电汇/人工付款来源目前不会进入 Live 付款流程，需要独立验证方案。

## 使用流程

1. 按 [Live 开盘指南](live-opening.md)创建并关联新的生命周期池，再由投资者明确认购。结算池必须有认购者；受保护的铜池 #2 不接收结算证明、不结算。
2. 在 Agent 控制台的“Live 航程与结算证明”里选择已关联案例，提交离港证明；批准后使用已有 owner CLI 签名。
3. 选择“进口商付款”，提交已发生的 USDC 转账交易哈希与面额。服务器核验后产生 `RECORD_PAYMENT` 审批，页面显示核验摘要。
4. 人工批准付款记录，默认 dry-run 检查计划，再逐笔签名。这里发送的是 `recordImporterPayment`，不会发起另一笔 USDC 转账。
5. 提交到港引用，人工批准 `RECORD_ARRIVAL`，预检并签名。也支持先到港、后付款。
6. 链上两份证明及金额都与已接受的 USDC 证据一致时，Agent 才提出 `SETTLE`。审批、预检、签名各自独立。批准本身不会完成结算。

沿用现有本机配置，不需要创建或发送新私钥。下列每个实际发送都遵守实施规划 §16 的逐笔授权要求：

```text
npm run agent:approve -- --list
npm run agent:approve -- --id <审批号>
npm run agent:approve -- --id <审批号> --step 0 --confirm
npm run agent:approve -- --id <审批号> --step 0 --attach-tx <已广播交易哈希>
```

CLI 再读当前链状态与 USDC 回执，检查原子金额、现有证明、owner、网络、审批期限、运行代次、紧急停止与 staticCall。状态变化会停止发送。回填核对目标地址、发送者、网络、零原生币金额、方法、参数及唯一匹配的事件字段；同名但错误池号或证明的事件无法完成审批。可选的 `AGENT_EXECUTOR` 路径也使用同一核验与金额语义，默认仍走 owner CLI。

## 幂等、重启与恢复

`agent-settlement-evidence.json` 将整份 USDC 回执永久绑定到一个已核验的池与金额。同一转账换请求事件号、并发提交或重启都不会产生第二次付款执行；另一个池不能复用它。证据先持久化、再入队，队列写入失败后可继续使用原检查点，不能删除付款记录来重新消费证明。

结算准备状态按同一区块读取 `offerings`、`settlementProofs` 和紧急停止；不依赖重启后丢失或陈旧的内存镜像。定时 tick 从持久的付款声明恢复准备检查，两份链上证明齐备才补提结算。链上付款更正、回执重组、收款配置或金额改变时，旧方案停止使用，历史证明仍保留。

owner CLI 的本地进程锁和 SENDING/SUBMITTED/ATTACHED 检查点复用 WP2.4。已有交易哈希先回填，不重新签名；广播结果不明则停止重试。服务器保存的已核验步骤可在完成记录写入失败后由 tick 恢复；重复回填同一已核验哈希是幂等的。

部署仍要求单个 Agent 运行时写入该 JSON 数据目录。此处的服务内串行声明和 owner CLI 进程锁不等于跨多个 Web 服务副本的分布式资金账本。

## 本地验证与边界

35 项新增行为测试覆盖精确金额、虚假/篡改/未确认/重组回执、保护池与映射、先付款/先到港、三次独立审批、重启、重复及跨池消费、写入失败、可选执行者路径和 CLI 模式/期限/广播恢复。

```text
node --test tests/agentSettlement.test.js tests/agentSettlementCli.test.js
npm run lint
npm run check
npm test
npm run test:coverage
npm run eval:agent -- --check
npm run preflight -- --report docs/evidence/settlement-preflight.json
```

浏览器隔离服务器跳过开发者 `.env`，没有签名者或真实 RPC。专用 `/__acceptance__/` 只存在于该脚本，不能写入真实链：

```text
node scripts/settlement-acceptance-server.mjs
playwright-cli -s=agentbl-wp26 open <输出的 URL> --browser=msedge
playwright-cli -s=agentbl-wp26 --raw run-code --filename=scripts/settlement-acceptance.playwright.js
playwright-cli -s=agentbl-wp26 close
```

部分 Playwright CLI 版本的 VM 不允许场景里的 `import('node:fs/promises')`。此时运行仓库的原生 runner，`--playwright-module` 指向本机已安装 Playwright 的 `index.mjs`，`--browser-executable` 在需要时指定本机浏览器路径；不需要修改项目依赖：

```text
node scripts/settlement-acceptance-runner.mjs --url <输出的本地 URL> --playwright-module <Playwright index.mjs 路径> --browser-executable <本机浏览器路径>
```

本轮使用这个 runner 执行同一场景，工具错误日志单独记录。内置浏览器打开请求返回 queued，不声称完成其控制。Windows curl 单独核验隔离入口可访问。

最终记录见 [本地证据](evidence/settlement-local.json)、[浏览器证据](evidence/settlement-browser.json)及 [Demo 发布闸门](evidence/settlement-preflight.json)。全量 **1021/1021**；覆盖率 lines **94.36%**、branches **83.83%**、functions **92.11%**，高于 88/72/86。浏览器中英 × 1440px/390px 的 **112/112** 项检查覆盖提交、错误反馈、核验摘要、审批、逐步回执、键盘和 SSE 草稿保持，并检查地址换行和意外空值。

终检完整套件使用 `--test-concurrency=4`，不跳过测试。MCP stdio 子进程明确使用离线环境，避免读取开发者配置；SSE 关闭断言等待完整事件帧，并保留关闭代码与 EOF 检查。覆盖率首轮暴露的分块读取问题和重启前发布闸门失败记录都保留；不以增加 MCP 超时、取消断言或重写旧证据来完成验收。

lint/check 和 19/19 确定性评测阈值通过。Demo preflight 为 **56 PASS / 0 WARN / 5 Live SKIP / 0 FAIL**，包含最终源码上的全部 Node 用例及 74 项本地 Solidity 测试。失败记录分别见 [首轮发布闸门](evidence/settlement-preflight-attempt1.json)和 [首轮覆盖率](evidence/settlement-coverage-attempt1.json)。隔离服务器已停止，临时运行目录已清理；完整验证日志保留在忽略的工作区目录，路径及输出哈希见本地证据。

这些证据不覆盖真实钱包/USDC 转账、真实 owner 签名、人工用户验收、远端 CI 或部署。本包未提交、未推送，先前合规和开盘历史均保留。下一入口为 **WP2.7 链上监听**。

建议提交分组：① `feat(agent): verify and persist Live USDC settlement evidence`；② `feat(cli): revalidate and recover approved settlement transactions`；③ `feat(frontend): submit and explain localized Live settlement evidence`；④ `test(agent): record settlement recovery and browser acceptance`。

核验参考：[ERC-20 Transfer 事件](https://eips.ethereum.org/EIPS/eip-20)、[ethers 交易、回执与区块 API](https://docs.ethers.org/v6/api/providers/)。资产映射与现有部署 ABI 以本仓库当前文件为准。
