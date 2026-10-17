# Demo 项目配图

更新日期：2026-10-17。

使用内置 `image_gen` 为全部 13 个目录项目逐张生成配图（含历史演示池），共 13 次生成调用。图片采用自然光工业货物摄影风格：阴极铜为铜板、铜精矿为深色矿粉、铁矿粉为红褐色颗粒、天然橡胶为胶块、大豆为黄豆、铝锭为银色铸锭；原油与柴油使用不同场景。三个佛山仓单和不同航线的铜货各有独立图片。

最终资产保存在 `public/img/cargo/`，统一转换为 512 × 512 WebP，保留中央主体，在项目列表中以 44 × 44 展示。图片 URL 的 `v=2` 用于刷新旧图缓存。航线盲盒继续按货物类别选图，铜精矿与柴油现在有独立类别。图片为 AI 生成的 Demo 示意图。

品牌区仅保留图标与 AgentBL 名称；移除中英文品牌副标题及对应的无用样式和文案键。

本地验证：构建、lint、check 和 16 项相关测试通过。隔离离线 Demo 浏览器验证覆盖中英文、1440px / 1280px 下的四个页面；13 张图片均返回 200 / image/webp、解码为 512 × 512，项目列表中均以 44 × 44 展示且路径互不重复，品牌副标题已移除，无页面脚本异常。

## 项目与文件

| 项目 | 案例 ID | 最终文件 |
| --- | --- | --- |
| 阴极铜 · Singapore → Shanghai | `CASE-EBL-CU-SIN-SHA` | [copper.webp](../public/img/cargo/copper.webp) |
| 原油 · Fujairah → Singapore | `CASE-EBL-OIL-FUJ-SIN` | [oil.webp](../public/img/cargo/oil.webp) |
| 柴油 · Singapore → Jakarta | `CASE-EBL-GASOIL-SIN-JKT` | [diesel.webp](../public/img/cargo/diesel.webp) |
| 天然橡胶 · Laem Chabang → Qingdao | `CASE-EBL-RUBBER-LCB-TAO` | [rubber.webp](../public/img/cargo/rubber.webp) |
| 铜精矿 · Antofagasta → Lianyungang | `CASE-EBL-CUCONC-ANF-LYG` | [copper-concentrate.webp](../public/img/cargo/copper-concentrate.webp) |
| 铁矿粉 · Port Hedland → Tianjin | `CASE-EBL-IRONORE-PHE-TSN` | [ore.webp](../public/img/cargo/ore.webp) |
| 原铝锭 · Jebel Ali → Rotterdam | `CASE-EBL-ALU-JEA-RTM` | [alu.webp](../public/img/cargo/alu.webp) |
| 大豆 · Santos → Dalian | `CASE-EBL-SOY-SSZ-DLC` | [soybean.webp](../public/img/cargo/soybean.webp) |
| 佛山仓单 00013 | `CASE-EBL-2026-ALU-FS-WH-00013` | [alu-fs-wh-00013.webp](../public/img/cargo/alu-fs-wh-00013.webp) |
| 佛山仓单 00014 | `CASE-EBL-2026-ALU-FS-WH-00014` | [alu-fs-wh-00014.webp](../public/img/cargo/alu-fs-wh-00014.webp) |
| 佛山仓单 00015 | `CASE-EBL-2026-ALU-FS-WH-00015` | [alu-fs-wh-00015.webp](../public/img/cargo/alu-fs-wh-00015.webp) |
| 历史铜货 · Singapore → Shanghai | `CASE-EBL-2026-CU-SG-SHA` | [copper-historical.webp](../public/img/cargo/copper-historical.webp) |
| 阴极铜 · Shanghai → Hamburg | `CASE-EBL-2026-0001` | [copper-hamburg.webp](../public/img/cargo/copper-hamburg.webp) |

## 实际生成提示词

每张图的完整提示词由以下统一前缀、一个换行和该图的项目描述拼接而成。使用内置工具，`transparent_background=false`，未传入参考图片。原始 PNG 留在工具的默认生成目录，项目引用上述 WebP 文件。

```text
Use case: photorealistic-natural.
Asset type: a square cargo thumbnail for the AgentBL trade finance demo project list.
Style: photorealistic commercial commodity photography, restrained institutional aesthetic, neutral natural daylight, realistic industrial materials and true-to-life colors. One coherent photograph, no montage. A bold, simple central subject with clearly readable shape and texture at 44 by 44 pixels, filling the central 80% of a square frame. Shallow but not excessive depth of field. No people, readable text, logos, UI, charts, tokens, coins, decorative neon, sci-fi objects or watermark.
```

### copper.webp

```text
Primary request: actual LME Grade A copper cathode cargo from Singapore to Shanghai. Show a close three-quarter view of thick rectangular reddish-copper cathode plates stacked in a neat strapped shipping bundle on a plain warehouse pallet. The plates have rough electrodeposited surfaces and slightly irregular squared edges. Warm copper metal dominates the image; softly blurred export warehouse behind. The goods must be flat copper cathode plates, not coiled copper wire, pipes, jewelry or copper ore.
```

### oil.webp

```text
Primary request: Murban light sweet crude oil maritime cargo, Fujairah to Singapore. Show the recognizable midsection and bow of a single modern deep-red crude oil tanker, viewed from slightly above at close range on calm deep-blue sea, with a wide unobstructed industrial deck, pipe runs and white bridge, oil-terminal tanks softly blurred far behind. Keep the tanker large and central so its red hull is recognizable as a small thumbnail. Documentary maritime photograph, no smoke, no fire, no spill, no labels.
```

### diesel.webp

```text
Primary request: refined clean diesel fuel cargo, Singapore Jurong to Jakarta. A close industrial product photograph of a small clear glass sampling vessel containing clean pale-straw diesel fuel, prominently centered, standing safely on a clean stainless-steel sampling bench, with two large white cylindrical fuel storage tanks and stainless terminal piping softly blurred behind. The clear pale-golden liquid and clean white tank farm distinguish refined gasoil from black crude oil. No bottle label, no retail pump, no black liquid, no oil drums.
```

### rubber.webp

```text
Primary request: natural rubber TSR20 / STR20 block cargo from Laem Chabang Thailand to Qingdao China. Show three dense rectangular bales of dark amber-brown natural rubber, one in front and two neatly stacked behind on a shipping pallet. The textured compressed rubber has granular ridges and is wrapped in thin transparent protective plastic, natural dark tan to brown coloring. Tidy export warehouse softly blurred behind. Natural rubber bales, not tires, not rubber bands, not white liquid latex.
```

### copper-concentrate.webp

```text
Primary request: copper concentrate bulk cargo, Antofagasta Chile to Lianyungang China. Close-up mound of fine dark charcoal-gray flotation concentrate with subtle metallic olive-gold mineral flecks in an open industrial cargo bin. Dense powder and tiny grains dominate the center, blurred mineral export shed behind. Real dark fine powder, no orange copper plates, polished rocks or gold nuggets.
```

### ore.webp

```text
Primary request: Pilbara Blend iron ore fines, 62 percent iron, Port Hedland Australia to Tianjin China. Close-up mound of coarse reddish-brown iron ore fines and small angular rusty mineral grains in a dry-bulk loading bay. Rust-red granular cargo fills the frame; blurred steel conveyor behind. Authentic mineral texture, no metal ingots, no generic gray rocks.
```

### alu.webp

```text
Primary request: primary aluminium ingots P1020A maritime cargo, Jebel Ali Dubai to Rotterdam. Two export bundles of matte-silver trapezoidal cast aluminium ingots stacked in alternating interlocking layers and secured with dark steel bands on a loading platform. Clearly recognizable tapered ingot shapes, rough cast surfaces and subtle cool highlights. Neutral gray shipping container blurred behind. No foil, coils, chrome mirror bars or bullion markings.
```

### soybean.webp

```text
Primary request: Brazilian yellow soybeans for crushing, Santos Brazil to Dalian China. Close-up of pale golden-yellow whole soybeans spilling from one open natural burlap sack, sharply focused bean mound in front, blurred grain export warehouse behind. Distinct round soybeans with small natural hila, slightly dusty organic texture. No corn, wheat or coffee.
```

### alu-fs-wh-00013.webp

```text
Primary request: aluminium ingot receipt lot 00013, stored at Foshan Nanhai metals warehouse. Close three-quarter view from slightly above of one tall pallet bundle of matte silver trapezoidal cast ingots, secured with black steel straps. The layered ingots fill the foreground, soft daylight from side windows, blurred high-ceiling warehouse columns behind. Actual stored cargo; no sea or ship. Distinct composition: one tall stack.
```

### alu-fs-wh-00014.webp

```text
Primary request: aluminium ingot receipt lot 00014, stored at Foshan Nanhai metals warehouse. Close low three-quarter view of two short adjacent pallet bundles of silver trapezoidal cast ingots at the front of a warehouse aisle. Near bundle dominates, dark steel bands, rough matte cast surfaces, warehouse racks blurred behind. Cool neutral daylight, no sea or ship. Distinct composition: twin low stacks viewed at eye level.
```

### alu-fs-wh-00015.webp

```text
Primary request: aluminium ingot receipt lot 00015, stored at Foshan Nanhai metals warehouse. Close oblique overhead view of compact strapped silver cast aluminium ingot bundles on clean concrete floor. One central bundle dominates, second partly visible behind, clearly show tapered ingot tops and alternating layers. Soft roof-skylight illumination, subtle gray palette, small blurred yellow warehouse floor line at edge. No sea or ship. Distinct composition: downward view of layered ingot tops.
```

### copper-historical.webp

```text
Primary request: historical Singapore to Shanghai copper cathode shipment. Close front three-quarter photograph of several upright thick rectangular reddish-copper cathode plates packed tightly in a strapped timber export crate at a warehouse loading bay. Rough electrorefined copper surfaces and slightly irregular squared edges dominate the frame. Natural daylight, muted industrial backdrop. Actual export cargo, no wire coils, pipes, jewelry, vintage filter or readable markings.
```

### copper-hamburg.webp

```text
Primary request: a distinct copper cathode shipment from Shanghai to Hamburg. Photograph real copper cargo inside an open intermodal export container: two tightly strapped bundles of reddish-copper rectangular cathode plates on wooden pallets, viewed diagonally from the container doorway. The near bundle of thick flat rough copper plates is large and clearly recognizable in the center, dark-gray corrugated container interior softly blurred behind, soft natural daylight entering through open doors. Authentic commodity logistics, no copper wire coils, pipes, jewelry, danger symbols, text or labels.
```
