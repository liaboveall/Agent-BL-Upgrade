# WP2.4：Live 开盘提案与 owner CLI

> 2026-10-17：新资产使用 `title-v2`（签发主体 + 原始提单身份），协议 v3 已部署并初始化，详见 [实链核验](evidence/protocol-v3-deployment-2026-10-17/README.md)。旧 v2 的 pool #2/#3 和货权未迁移；旧提单在新 Registry 缺失时停止开盘，不能换 case ID 重铸。新 v3 从 eBL/pool #1 重新编号，编号必须连同合约地址解释。

单证接入在 Live 下生成待审批的开盘方案。新货物包含 `mintEBLV2 → pledge → createOffering` 三步；已登记货物只提出关联已有 eBL 和融资池。服务器不签开盘交易，也不读取 owner 密钥。本地实现与隔离验收使用内存链桩和真实部署 ABI。2026-10-16 在测试网上为新铜案例真实运行了一次，开出 eBL #3 / pool #3，证据见 `docs/evidence/live-opening-pool3.json`。

## 身份与执行计划

九步单证流水线之后，Live 作业继续记录策略与执行计划两个步骤。只有可开盘报价和 CLEAR 演示合规报告才查询链上唯一性。CLEAR 仍只表示未命中内置演示规则，不代表官方名单筛查或法律认定。

`cargoIdentityHash` 原样保留 Wave B 的哈希公式。站立演示池的铜案例有一项兼容处理：历史案例使用短货物/承运人描述，原始单证使用完整描述且可能以平台 title ref 标识提单。先核对提单标识、数量、船名、承运人、货物、航次、港口和 HS，再使用原案例的历史身份；源身份哈希也进入审计记录。事实不一致、原身份在链上缺失时停止开盘并保留核对原因，不能另算一个身份绕过已登记货物。

已登记货物必须核对 `eblIdForCargo`、`cargoHashOf`、`poolOfEbl`、质押对象、eBL/pool 对应关系和活跃/暂停状态，才提出关联。无活跃池或处于终态时停止并保留原因；关联批准后再核验一次，不发交易、不改变已有池的价格。

新货物的元数据保留单证中的实际航次、HS、美元申报值和吨数；小数吨以 `MT_E6` 明示。MLETR/eUCP/DCSA 布尔值只反映显式声明，不推测认证。提单元数据承诺绑定案例、单证摘要、合规证据与报价哈希。计划只使用本地部署注册表的地址、ABI 和测试网 1439，CLI 还会核对 RPC 的实际 chain ID。

后两步使用 `{ref: "ebl_id"}`，只从第一步已核验的 `EBLMintedV2` 日志解析编号。最终 pool ID 来自匹配的 `OfferingCreated` 日志；不预测 `nextEblId` 或 `nextPoolId`。三步全部核验并重新读取当前链状态后，才持久登记 PoolRegistry 和完成决策。

## 运维操作

管理员在页面批准新开盘提案后，状态为 `AWAITING_OWNER_SIGNATURE`。在自己的电脑上使用已配置的管理员令牌和 owner 密钥；不要把 owner 密钥提供给服务器。以下 `<审批号>` 取自批准的提案，每次真实发送都遵守实施规划 §16 的逐笔确认要求。

```text
npm run agent:approve -- --list
npm run agent:approve -- --id <审批号> --step 0
npm run agent:approve -- --id <审批号> --step 0 --confirm
npm run agent:approve -- --id <审批号> --step 1
npm run agent:approve -- --id <审批号> --step 1 --confirm
npm run agent:approve -- --id <审批号> --step 2
npm run agent:approve -- --id <审批号> --step 2 --confirm
```

默认只预检当前可执行的一步，展示其余依赖；不会在尚未 mint/pledge 时模拟后续调用。开盘仅加 `--confirm` 会被拒绝，必须明确指定 `--step`。每笔发送前复核审批状态、期限、运行模式/代次、紧急停止、owner、货物/质押状态及 staticCall。

服务器核验成功回执、目标地址、发送者、网络、零原生币金额、方法、全部参数（包括完整 metadata tuple）和对应事件字段；同名事件的错误参数、歧义日志、伪哈希、乱序与哈希复用均不能完成审批。重复回填同一步的同一已核验哈希可安全返回已有结果。

## 中断与恢复

CLI 在忽略的 `AGENTBL_RUNTIME_DIR/owner-cli/` 中保存无密钥的广播检查点，并对同一审批加进程锁。发送前记录 SENDING，取得哈希后记录 SUBMITTED，回填后记录 ATTACHED。

已有哈希会先回填，续跑不会再签名发送。只有 SENDING 而没有哈希，或残留进程锁时停止重试；先人工查明链上结果，不能以删除检查点来替代对账。已知交易可单独回填，命令不需要 owner 密钥，也不发送交易：

```text
npm run agent:approve -- --id <审批号> --step 0 --attach-tx <交易哈希>
```

半完成的审批到期后停止新增步骤，已核验记录仍保留。若三笔已核验而池映射写入失败，审批保持等待对账，页面隐藏新的发送命令；后续 tick 或重复回填最后一笔可完成映射，不重发。重启读取已核验的 eBL/pool bindings，不重新铸造。

## 测试

```text
node --test tests/agentOpening.test.js tests/agentOpeningCli.test.js
```

本地测试不覆盖真实 owner 签名/链上交易、人工用户试用、实体设备、远端 CI 或部署。
