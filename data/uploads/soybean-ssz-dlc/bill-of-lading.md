# NEGOTIABLE ELECTRONIC BILL OF LADING (BULK eBL)

> 拟真样例数据，用于 AgentBL demo。所有公司、银行、人名、船名、单号、地址均为**虚构**，不指向真实货运。
> 日期写在 2026-10-16 前后，Demo 加载时会整体平移到"今天"前后。

| | |
|---|---|
| **Carrier** | South Atlantic Bulk Lines S.A. |
| **B/L No.** | SULB/SSZ/DLC/2208 |
| **B/L Type** | Negotiable — "To Order" (货权可转让) |
| **eBL Platform** | TradeTrust (MLETR) |
| **eBL Title Ref** | TT-EBL-SOY-2208-5A3C |
| **Charter Party** | Voyage C/P dated 2026-09-18 (NORGRAIN form) |

---

## Parties

**Shipper / Exporter**
Cerrado Grains Exportadora Ltda.
Av. Portuária 400, Santos – SP, Brazil (demo address)

**Consignee**
TO ORDER OF BANCO ATLANTICO SUL S.A.
(Negotiable — endorsed per documentary credit)

**Notify Party**
Dalian Liaohai Oilseed Crushing Co., Ltd.
Dalian Free Trade Zone, Liaoning, P.R. China (demo address)

---

## Transport

| Field | Value |
|---|---|
| Vessel / Voyage | MV IPE AMARELO / V.12E |
| Port of Loading | **Santos, Brazil (BRSSZ)** |
| Port of Discharge | **Dalian, China (CNDLC)** |
| Shipped on Board | **2026-10-04** |
| Estimated Time of Arrival (ETA) | 2026-11-15 |
| Route | South Atlantic – Cape of Good Hope – Indian Ocean – Malacca Strait – South China Sea |
| Freight | Payable as per Charter Party (CFR) |

---

## Description of Goods (in bulk, 5 holds)

| Description of Goods | HS Code | Quantity |
|---|---|---|
| Soybeans — Brazil, yellow, GMO, for crushing. Protein ≥ 36%, moisture ≤ 14%, foreign matter ≤ 1%. | **1201.90** | 66,000.000 MT |

**Declared Cargo Value (for carriage):** USD 37,092,000.00 (CFR Dalian)

---

## Statements

- SHIPPED in apparent good order and condition, in bulk, weight per draft survey at Santos.
- Total of **1 (one) sole electronic original** Bill of Lading issued electronically; paper originals: NIL.
- Whoever lawfully controls this eBL controls the goods and may take delivery, endorse, transfer or pledge it.

| | |
|---|---|
| **Place & Date of Issue** | Santos, 2026-10-04 |
| **Signed for the Carrier** | Master, MV Ipe Amarelo / South Atlantic Bulk Lines S.A. as agents |
| **Document Hash (SHA-256)** | 0x4034cae8a4eb9b5b5f9761f1c6f97c7b11017d3c462aa4f62fd64ed17cd7165e |

---

> 说明（给团队）：对应商业发票 `commercial-invoice.md`、保险单 `insurance-policy.md` 与结构化案例 `data/cases/soybean-ssz-dlc.case.json`。
> 巴西大豆经好望角运往中国，是现实中最主要的大豆贸易流向之一。
