# NEGOTIABLE ELECTRONIC BILL OF LADING (eBL)

> 拟真样例数据，用于 AgentBL demo。以下所有公司、银行、人名、船名、单号、地址均为**虚构**，不指向任何真实实体或真实货运。
> 日期写在 2026-10-16 前后，Demo 加载时会整体平移到"今天"前后。
> Issued as a sole electronic original on an MLETR-compliant eBL platform.

| | |
|---|---|
| **Carrier** | BlueStrait Container Lines Pte. Ltd. (SCAC: BSCL) |
| **B/L No.** | BSCL/SIN/SHA/0517 |
| **B/L Type** | Negotiable — "To Order" (货权可转让) |
| **eBL Platform** | WaveBL (MLETR / Singapore ETA 2021 compliant) |
| **eBL Token / Title Ref** | WAVE-EBL-3C81D2A9 |
| **Booking No.** | BSCL-BK-0517-2290 |
| **Service Contract** | SI-COP-0517 |

---

## Parties

**Shipper / Exporter**
Strait Resources Trading Pte. Ltd.
18 Harbour Front Walk, #21-04, Singapore 098631 (demo address)
UEN: 201634789K  |  Tel: +65 6555 0148

**Consignee**
TO ORDER OF MERLION TRADE BANK LTD., SINGAPORE
(Negotiable — endorsed to order per documentary credit)

**Notify Party**
Donghai Copper Materials Co., Ltd.
No. 88 Lingang Avenue, Pudong New Area, Shanghai, P.R. China (demo address)
Attn: Import Dept. / Mr. Chen Weiguo

---

## Transport

| Field | Value |
|---|---|
| Vessel / Voyage | MV LUMEN BAY / V.0112N |
| Place of Receipt | Singapore (PSA, CY) |
| Port of Loading | **Singapore (SGSIN)** |
| Port of Discharge | **Shanghai – Yangshan Deep-Water Port (CNSHG)** |
| Place of Delivery | Shanghai (CY) |
| Movement | CY / CY (FCL/FCL) |
| Shipped on Board | **2026-10-13** |
| Estimated Time of Arrival (ETA) | 2026-10-20 |
| Freight | **FREIGHT PREPAID** |

---

## Particulars Furnished by Shipper

**Marks & Numbers:** STRAIT / COPPER / CIF SHANGHAI / GRADE-A / S.O. 0517
**No. of Packages:** 200 bundles in 20 × 20' GP containers (FCL)

| Description of Goods | HS Code | Quantity | Net Weight | Gross Weight |
|---|---|---|---|---|
| Copper Cathodes — LME Grade A (Cu-CATH-1), purity ≥ 99.9935% Cu, conforming to BS EN 1978:1998. LME-registered brand "ATACAMA-SX" (demo). Full-plate cathodes, steel-strapped in bundles. | **7403.11** | 500.000 MT | 500,000 kg | 502,360 kg |

**Declared Cargo Value (for carriage):** USD 7,267,500.00 (CIF Shanghai)

---

## Statements

- SHIPPED on board the above vessel in apparent good order and condition.
- Total of **1 (one) sole electronic original** Bill of Lading issued via WaveBL. Possession/control of the electronic record is governed by the platform rulebook and the Singapore Electronic Transactions Act 2021 (MLETR).
- Whoever lawfully controls this eBL controls the goods and may take delivery, endorse, transfer or pledge it.
- Particulars above (weight, marks, quantity, contents) furnished by Shipper and not checked by Carrier ("said to contain").

| | |
|---|---|
| **Place & Date of Issue** | Singapore, 2026-10-13 |
| **Signed for the Carrier** | BlueStrait Container Lines Pte. Ltd., as Carrier |
| **Document Hash (SHA-256)** | 0xd0eb36e3b553a44da6f35996484ec7d4599448f469e84ca74d2e5398ebf2bd4e |

---

> 说明（给团队）：本提单对应商业发票 `commercial-invoice.md`、保险单 `insurance-policy.md` 与结构化案例 `data/cases/copper-sg-shanghai.case.json`。
> 货权凭证 (To Order)、可背书转让，正是它能作为 RWA 抵押物的法律基础。
