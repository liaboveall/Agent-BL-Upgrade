# NEGOTIABLE ELECTRONIC BILL OF LADING (TANKER eBL)

> 拟真样例数据，用于 AgentBL demo。所有公司、银行、人名、船名、单号、终端运营方、地址均为**虚构**，不指向真实货运。
> 日期写在 2026-10-16 前后，Demo 加载时会整体平移到"今天"前后。
> Issued as a sole electronic original on an MLETR-compliant eBL platform.

| | |
|---|---|
| **Carrier / Shipowner** | Meridian Tankers Ltd. (on behalf of Master, MT Coral Meridian) |
| **B/L No.** | EET-CRUDE-0233 |
| **B/L Type** | Negotiable — "To Order" (货权可转让) |
| **eBL Platform** | TradeTrust (MLETR) |
| **eBL Title Ref** | TT-EBL-CRUDE-0233-B19E |
| **Charter Party** | Voyage C/P dated 2026-10-03 (ASBATANKVOY form) |

---

## Parties

**Shipper / Exporter**
Equator Energy Trading Pte. Ltd.
1 Straits Quay, #30-02, Singapore 049320 (demo address)
UEN: 201789542H | Tel: +65 6555 0912

**Consignee**
TO ORDER OF KEPPEL ISLAND BANK LTD., SINGAPORE
(Negotiable — endorsed per documentary credit)

**Notify Party**
Jurong Petrochem Refining Pte. Ltd.
Jurong Island, Singapore (demo address)
Attn: Crude Procurement / Ms. Lim Hui Min

---

## Transport

| Field | Value |
|---|---|
| Vessel | MT CORAL MERIDIAN (Aframax crude tanker) |
| Voyage No. | V.41 |
| Place / Terminal of Loading | **Fujairah Oil Terminal, Fujairah, UAE (AEFJR)** |
| Port of Discharge | **Jurong Island, Singapore (SGSIN)** |
| Loaded on Board (B/L date) | **2026-10-12** |
| Estimated Time of Arrival (ETA) | 2026-10-23 |
| Freight | Payable as per Charter Party (FREIGHT PREPAID, CIF) |

The loading terminal sits on the Gulf of Oman, outside the Strait of Hormuz; the cargo reached it by the
Habshan–Fujairah pipeline. The voyage does not transit the Strait.

---

## Description of Cargo (in bulk, ex shore tank)

| Description | HS Code | Quantity |
|---|---|---|
| **Crude Oil — Murban grade** (light sweet). Shipped in bulk from Fujairah shore tanks. | **2709.00** | **700,000 net US barrels @ 60°F** |

**Quality / Quantity Particulars (per independent inspector, demo):**

| Parameter | Value |
|---|---|
| Gross Standard Volume | 700,000 bbl @ 60°F |
| Metric Tonnes (in air) | 92,105.000 MT |
| API Gravity @ 60°F | 40.2° |
| Sulphur content | 0.79 % wt |
| BS&W | 0.05 % |

**Declared Cargo Value (for carriage):** USD 74,970,000.00 (CIF Singapore)

---

## Statements

- SHIPPED in apparent good order and condition the bulk crude oil described above.
- Total of **1 (one) sole electronic original** Bill of Lading issued electronically; paper originals: NIL.
- Whoever lawfully controls this eBL controls the goods and may take delivery, endorse, transfer or pledge it.
- Quantity/quality "said to be" per shore tank and independent inspector figures; weight and measure unknown to Carrier.

| | |
|---|---|
| **Place & Date of Issue** | Fujairah, 2026-10-12 |
| **Signed for the Carrier** | Master, MT Coral Meridian / Meridian Tankers Ltd. as agents |
| **Document Hash (SHA-256)** | 0x40ecaf19095a3ac4d69236e2035943cf128325554bb77fef87b9ed0497e2a246 |

---

> 说明（给团队）：对应商业发票 `commercial-invoice.md`、保险单 `insurance-policy.md` 与结构化案例 `data/cases/crude-fuj-sin.case.json`。
> 油轮提单按"桶"计量，定价基准是 Brent + 升贴水。装货港紧邻霍尔木兹海峡但不经过它，所以风险来自"邻近"的真实数据（PortWatch 通行量、Polymarket 赔率），按降一级计。
