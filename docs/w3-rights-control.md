# W3 权利与控制

范围：B04–B10 的本地研究 / 测试代币候选。设计见 [W3 规范](superpowers/specs/2026-10-17-w3-rights-control-design.md)，证据见 [W3 本地验收](evidence/w3-local-2026-10-17/README.md)。旧测试网部署不因本地实现而升级；真实业务入口始终关闭。

## 组合实例和链上权限

新 `RightsController` 部署自己的 `RWAOfferingPoolV5` 与 `ControlledRWAToken`，永久持有 pool 的 owner / oracle 权限；部署后调用无参数的 `activate()`，一次性装入强制资格 gate。未激活或 intakeStopped 时不能发行 / 认购。控制器没有任意调用、转移 pool owner、替换 gate 或添加裸 executor 的入口。资金 ABI 和协议版本仍是 v5；控制层 `controlVersion=1`。

| 角色 | 权限 | 排除的能力 |
|---|---|---|
| 治理 | 至少三名成员、两名独立批准、一小时以上等待；角色轮换 / 撤权、测试资产、风险恢复、费用 | 单成员立即改权、替换 token minter |
| 可信签发方 | EIP-712 发行 / 修订签名、特定单证失效；治理绑定组织 | 代替 holder 同意质押 |
| holder | 签署或亲自提交精确条款质押；无发行时撤回、无占用时背书 / 交回 | 已占用资产转移、单方解除债权 |
| ISSUER / VALUER | 独立发行操作与估值签名 | 同一地址充当本次发行操作人和估值人 |
| OPERATOR / ATTESTOR | 白名单生命周期操作、固定 exporter 放款；付款与到港声明 | 改到期 / 改收款人、裸增发、跳过处置审核 |
| COMPLIANCE | 钱包与主体 / 来源承诺、有效期和撤销，最多一天的认证服务时效 | 抹掉既有退款 / 领取权 |
| DISPOSER / REVIEWER | 回收 / 分配承诺，一天通知期，独立审核 | 自审、跳过投资者 / holder 争议 |
| GUARDIAN | 关闭新发行 / 新认购 / 放款 | 解停、改资金去向、停止既有退款 / 领取 |

成员变更使旧 epoch 未执行提案失效；成员可取消提案，批准后七天执行窗口之外拒绝。角色轮换：由仍有效的两名治理成员批准新地址，再撤旧地址；已测旧队列失效和旧角色拒绝。两个治理密钥同时丢失没有隐藏管理员恢复通道，须保留独立备份和人工接管材料。

## 资产、估值和处置

`assetIdentity(issuerOrganization, originalIdentity)` 对组织和原始单证标识做 NFKC / 大小写 / 空白规范化。原标识保留在受控材料内，上链为资产键。可信签发方负责对修订、换名、换单使用同一原始身份。共享 `AssetIdentityHub` 永久保留已登记、已交回和历史别名槽位；新 Registry 必须加入同一个 Hub。另建 Hub、恶意可信签发方另造身份、未经合作的平台仍超出去重域。

发行签名绑定链 / Registry、issuerOrg、assetKey、加盐文件承诺、实际 holder、修订、上一版哈希、nonce 和有效期；支持 EOA / ERC-1271。修订须 issuer / holder 双签，无占用时背书 / 交回，逐项保留事件。签发方可使特定单证失效，阻止后续认购，不抹掉出资和退出权。

holder 质押另绑定 pool、完整条款哈希、holderNonce 和截止。holder 与管理方相互独立。这是受控系统的技术占用，不能称全球去重或真实货权认证。

OfferingTerms 与估值采用版本化 EIP-712。净回收估值、测试资产 / 6 位金额、coverage、供给、每份兑付、费用上限、固定 exporter / 费用收款人、期限、处置政策和披露承诺发行前固定。最大供给 × 每份兑付 × coverage 不得超过净回收估值。过期、单位 / 资产 / 域不符、极端参数、估值人撤权均拒绝新增认购。当前保守策略为估值过期停止认购；恢复须另行批准新估值 / 新发行，不能默用过期材料。

投资者先 `acknowledgeTerms`，再调用 W2 原子认购。降价增加 quoteVersion，旧确认立即失效。资格撤销、服务时效过期和 guardian 关闭 intake 不影响直接 `refundInvestor` / `claim`。

损失结清须通知、独立审核、争议处理及当前实际回收核对；迟到回收使旧审核不能封账。按 W2 实际 escrow 分配。损失终态释放占用后保留风险锁；份额领取完、escrow 为零、治理批准才可清除，随后仍需 holder 新同意。真实扣押、托管、保险、拍卖和追索仍需独立业务材料。

## 业务身份、证据和接口

`AGENTBL_RIGHTS_KEY` 为独立管理的 32-byte hex 密钥。默认缺少该 key 时私人操作返回 503，不从 admin token 派生，不在 runtime 旁生成 key。会话、材料、审核、交易计划保存于 AES-256-GCM 认证加密 vault；逐份材料另绑定组织、ID、revision 的 AAD。事务复用跨进程锁和 durable 原子写入。异机密钥 / vault 恢复留待 W5 实测。

管理员登记研究主体 / 钱包 / 角色。主体完成单次 EIP-712 钱包挑战取得一小时会话；挑战五分钟过期。`x-rights-session` 传会话，vault 只存哈希。每次请求重读撤销 / 期限；SSE 定期复核并在失效时关闭。同组织同钱包不能创建两个主体冒充独立审核员。这是研究身份登记，不代表企业 IdP 或真实 KYC 已验收。

| HTTP | 行为 / 权限 |
|---|---|
| GET `/status` | 公开范围 / 候选状态 |
| POST `/subjects`、DELETE `/subjects/:id` | 管理员登记 / 撤销研究主体 |
| POST `/session-challenges` | 管理员为已登记主体生成钱包挑战 |
| POST `/sessions`、DELETE `/sessions/:id` | 钱包签名登录；管理员撤销 |
| GET `/me` | 当前有效会话 |
| POST `/materials` | issuer / holder 创建本组织加密材料和白名单摘要 |
| GET `/materials/:id`、`/download`、`/events` | 同组织和适当角色；投资者不直接读身份 / 单证原文 |
| POST `/materials/:id/terms` | 原发行主体绑定最终条款，保留旧版并清除旧审核 |
| POST `/materials/:id/review`、`/publish` | 两名不同主体 / 钱包、非发行主体的审核；发行主体发布独立投影 |
| GET `/publications/:id` | 已批准摘要，无私人名称、明文、salt、钱包、URL |
| POST `/mcp`、`/a2a` | W3 私人适配器，共用对象权限检查 |
| POST `/transaction-plans` | 身份、链角色、静态预检；保存 unsigned plan，不签名 / 广播 |
| GET `/transaction-plans/:id`、POST `/:id/transaction` | 本主体恢复 / 绑定精确交易和规范回执；禁止交易复用 |

所有路径以 `/api/rights` 开头。MCP 私人适配器接受 JSON-RPC `tools/call`，工具 read_material / read_publication、参数 `{material_id}`；A2A 适配器接受 `{operation, material_id}`。它们是受控应用网关，未注册到原公共发现接口，也不宣称新增完整协议认证。旧公开接口、上传和工作区 cookie 保留已有原型边界。

计划支持 register_title、pledge、create_offering、acknowledge_terms、disburse、notify_resolution、review_resolution、finalize_resolution。create_offering 还要求本发行主体的当前双审、已发布版本及 document_hash / terms_hash 精确匹配。公开摘要双审是应用网关控制，不能替代链上授权签名人的可信职责，也未限制获权发行人从自己的钱包直接调用控制器；真实业务的签名托管 / 多方执行须另行决定并实测。

显式配置 `AGENTBL_RIGHTS_CONFIG` 后只读核对网络、治理、Hub、Registry、pool owner / oracle / gate / accessMode、固定 token 和 EIP-712 域。加载器只接受 1439 / 31337，六份 runtime 必须与本地 artifact 一致（按 artifact 指定范围屏蔽构造器 immutable 槽位，再独立读取关键绑定 / 域）。缺少构建 artifact 时拒绝加载；不信任配置提供的任意 ABI。默认 RPC 超时十秒。

`sendRightsPlan` 由用户确认后经钱包发送，检查地址 / 链 / nonce / 目标及静态调用；未知广播返回 RECONCILIATION_REQUIRED，不自动重发。未保存 hash 时 GET 计划按保存的发送方 / nonce / calldata 在最多 500 块内只读找回，范围以外要求人工核对钱包哈希后 attach。回执重组将状态退回 reconciling，并保留旧确认块于 receipt_history；不会继续宣称 confirmed。已初始化 vault 丢失时拒绝创建空历史，要求恢复。

## 最小披露和保留

| 数据 | 保存 / 公开 | 期限 / 授权 |
|---|---|---|
| 船、港、货物明细、原单证号、身份证据 | W3 vault 内加密，不进新 Registry calldata / storage / event | 默认 90 天读取窗口，同组织授权；到期拒绝读，密文审计留存 |
| 资产键、加盐文件承诺、policy / terms / distribution 哈希 | 新链实例按需公开 | 不可撤回；salt 只在授权材料包内 |
| 钱包、份额、金额、时点、状态 | 链上资金流程仍公开 | 不声称地址匿名或资金隐私 |
| 摘要 | 商品类别枚举、TEST_USDC、期限、条款哈希、风险枚举 | 两名审核员和发行主体批准，旧投影留档 |
| 会话 / key | 会话哈希；vault key 在外部密钥管理 / 独立备份 | 会话一小时，可撤销；无 owner key 回退 |

新候选不接收链上明文 metadata、私人 CID、任意公开描述。旧合约公开明文不可撤回；真实单证仍须独立字段审查、处理依据及保存 / 删除政策。90 天后拒绝读取不等于已销毁密文备份。

稳定 assetKey 为确定性组织 / 原始身份哈希，便于受控去重，仍可能被已知标识字典枚举，不能当作匿名化证明；文件内容承诺另有随机私盐。钱包和公开资金行为同样可关联。

## 验证和部署

```sh
npm --prefix hardhat test
npm test
npm run test:w2
npm run test:w3
npm run lint
npm run build
npm run check
npm run test:browser
npm run rights:plan
```

`rights:plan` 只读 artifact 生成审查清单，不读 `.env` / 私钥，不连接测试网。部署、旧资产映射、角色 / 资产额度、真实钱包、真实签发 / 估值 / 身份与法律控制另需材料。W4 处理来源 / 证据，W5 处理运营与异机恢复。
