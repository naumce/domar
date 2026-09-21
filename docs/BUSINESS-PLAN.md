# Plan: beating Domexa in building management software

Date: 2026-09-21. Inputs: full walkthrough of Domexa (see README.md), public sources listed at the end,
and three decisions already made: funded full-time team, committed design partners (licensed managers),
North Macedonia first with a Balkans-ready core, strategy = operations platform with billing included.

Facts are marked with a source number. Estimates and judgments are marked as such.

---

## 1. The situation, accurately

### 1.1 Market size (North Macedonia)

| Figure | Value | Source |
|---|---|---|
| Residential buildings under some form of management | 8,053 | [1] RKD, latest |
| Buildings with a licensed manager under contract | 5,600 (4,910 in mid-2023) | [1], [2] |
| Units (apartments + commercial) under licensed managers | 135,338 (117,425 in mid-2023) | [1], [2] |
| Licensed management companies | 67 active (mid-2023) | [2] |
| Registered owners' associations (заедници на сопственици, self-managed) | 2,557 (mid-2023) | [2] |
| Buildings with no management at all | roughly half of all buildings, per the government's own 2025 law proposal | [3] |
| Where the contracts are | Skopje, Bitola, Kumanovo, Štip, Strumica, Veles, Ohrid | [2] |

What this means: the manager segment is about 70 companies. Even total dominance is a small business
on subscriptions alone. Revenue upside comes from (a) per-unit pricing on 135k units, (b) the 2,557
self-managed associations Domexa ignores, (c) transaction-adjacent services (payments, reminders,
e-invoices), and (d) the region. The plan is built around that arithmetic.

### 1.2 The competitor

- Domexa's domain was registered on 5 August 2026 [4]. It is a six-week-old product from a very small
  team (single-admin approval flow for new registrations, add-ons enabled "by contacting us").
- Feature set (verified in the account): buildings, units, contacts, services with three price models,
  reserve fund ledger, master-invoice generation per period, partial payments, credit notes, PDF/zip export,
  public invoice lookup, audit log, two paid add-ons (own-SMTP email, Halkbank card payments). Free plan
  for 5 buildings, €19 for 20, €49 for 150.
- Missing (verified: no UI and no API endpoint): bulk import, bank statement import or reconciliation,
  owner accounts or app, maintenance requests, suppliers, documents, assembly management or voting,
  automated reminders, annual reports, accounting export, e-invoicing, team roles UI, multi-country.
- Serbian incumbents (Troškovi, e-Upravnik, zgradaHub, Moja Zajednica, ZgradIS, Zgrada360) already ship
  tenant apps, e-voting, bank statement import and QR-coded invoices [5]. That market is crowded; it is a
  feature benchmark for us, not a first expansion target.

### 1.3 Regulatory drivers (this is where we win)

The Law on Housing was amended in 2025 (Official Gazette 160/2025); the commission is training managers on
the new duties and gave them six months to comply [6]. From the government's proposal text [3], the
provisions that translate directly into software:

| Provision | What the manager must now do | Product consequence |
|---|---|---|
| Art. 19 pt. 7 | Issue invoices and collect payments based on a monthly calculation contained in the invoice; pay third-party contracts | Invoice = monthly calculation, one artifact |
| Art. 33 | Monthly calculation must show separately: each cost for the whole building and for the owner's part, reserve fund contribution, management fee, other payments, and the reserve fund balance of the whole building | Mandatory invoice layout, generated automatically |
| Art. 28 | Reminder "in writing and electronically" after two consecutive unpaid bills or three unpaid in total; no fee may be charged for it | Automated dunning with legal thresholds built in |
| Art. 45(4) new | Manager must give owners insight into the state and transactions of the regular and reserve fund accounts of their building | Owner portal with fund transparency is now a legal duty, not a nice-to-have |
| Art. 42, 45 | Separate accounting per building and per owner; separate bank accounts per fund | Building-level ledgers with per-owner sub-ledgers; bank reconciliation per account |
| Art. 31 | Report to the owners' assembly at least once a year; content prescribed by the commission | One-click annual report on the RKD template |
| Art. 37 | Convene the assembly with written invitation 15 days ahead, agenda included, at least once a year | Assembly module: invitations, agenda, quorum, minutes, decisions |
| Art. 30 | On contract end: final report with detailed financials, transfer funds within 8 days, notify RKD within 8 days | Handover report and export, which also makes switching *to* us easy |
| Art. 47(5) | Necessary works not covered by the reserve fund are invoiced to owners by ownership share | Extraordinary-cost distribution by share |
| Art. 33(3), 14 | Manager must pay third parties on time and sue non-payers; enforcement via notary | Debt file per owner with export for notary or lawyer |

Second driver: mandatory e-invoicing through the Public Revenue Office (УЈП) from 1 October 2026 for all
VAT payers, B2B and B2G, centralized validation, structured XML/UBL [7]. Invoices to private owners (B2C)
are outside the mandate, but two flows in this business are inside it: invoices to companies that own
commercial units, and every supplier invoice the manager receives and pays from building funds. Domexa
has no e-invoice capability.

Third driver: payments. Card payments exist only through bank e-commerce contracts (Halkbank now, CPay
pending). National instant payments are being built on a TIPS-based platform and are not yet live [8].
Bank statements are exportable as MT940, XML, XLS or TXT from business e-banking [9]. Reconciliation from
statement files is therefore possible today; pay-by-QR is a later opportunity.

---

## 2. Positioning

**The compliance-complete operations platform for building managers, with a free owner app.**

One sentence for a sales call: "Everything the 2025 law now requires of you happens automatically, your
owners see their fund and their bills on their phone, and your bank statement books itself."

Domexa's pitch is "invoices in one click". Ours is "the law, the money and the building in one place."
Every legal duty above becomes a named feature so a manager can map their inspection checklist to our menu.

---

## 3. Where we beat them, point by point

| Area | Domexa | Us |
|---|---|---|
| Onboarding | Manual entry, order-dependent | Excel/CSV import of units and owners; importer for Domexa exports and common spreadsheets; onboarding done by us for design partners |
| Monthly calculation | Master invoice split by unit, m² or evenly | Same, plus Art. 33 layout guaranteed, ownership-share distribution for extraordinary costs, management fee as a first-class line |
| Collections | Manual payment entry, partial payments | Bank statement import (MT940/XML/XLS) with automatic matching on reference; Art. 28 reminder automation; debt file export |
| Owners | Invoice lookup by number + surname | Owner accounts and mobile app: all invoices, payments, fund state and transactions (Art. 45(4)), notices, voting, requests |
| Operations | None | Maintenance requests with photos, supplier register and contracts, documents per building, maintenance plan (Art. 19 pt. 5) |
| Governance | None | Assembly module: invitations with 15-day rule, agenda, attendance, quorum, decisions, minutes, e-voting where the contract allows |
| Reporting | Dashboard tiles, audit log | Annual report per RKD template, handover report (Art. 30), per-building fund statements, accounting export |
| E-invoicing | None | УЈП e-Faktura for B2B unit owners and inbound supplier invoices |
| Payments | Halkbank card add-on | Card via bank contracts, and instant/QR when the national rail goes live |
| Team | Single role visible | Roles: owner, accountant, field technician, read-only inspector view |
| Region | MK only | Country pack abstraction from day one (tax, currency, bank formats, language, legal templates) |
| Pricing | Per building count, add-ons priced separately | Per unit per month, all features included; free tier for self-managed associations |

---

## 4. Roadmap

Dates count from October 2026. "Partner live" means a design partner runs real buildings on us.

### Phase 0: weeks 1 to 4 (October 2026). Ground truth.
- Sit with each design partner for their monthly close: watch the calculation, the bank statement, the
  reminders, the complaints. Record every spreadsheet and every paper form.
- Get the RKD annual report template and the inspection checklist from the partners or the commission.
- Obtain the УЈП e-Faktura technical specification and register for the pilot.
- Collect real anonymized bank statement files from at least three banks.
- Deliverable: written requirements per legal article, prioritized by the partners; data model; country
  pack interface defined.
- Exit criterion: partners sign off the Phase 1 scope and commit a migration date.

### Phase 1: months 2 to 4 (November 2026 to January 2027). Billing parity plus the three gaps that hurt most.
- Core: organizations, buildings, units, owners, services, recurring charges, reserve fund ledger, master
  calculation, per-owner invoices with Art. 33 layout, partial payments and balances, credit notes, PDF.
- Import: Excel/CSV templates plus a mapping UI. Migration path from Domexa (their API returns JSON for
  every entity, so a partner's data can be pulled with their own credentials).
- Bank reconciliation v1: upload statement, match by reference number and amount, review queue for the rest.
- Reminders v1: Art. 28 thresholds, email and SMS, no-fee rule enforced, letter PDF for paper delivery.
- Owner web portal v1 with accounts: invoices, payments, fund balance and transactions.
- Exit criterion: one partner closes a real month end-to-end on us with no spreadsheet. That is the first
  paying customer, and the first switch from Domexa if a partner is on it.

### Phase 2: months 5 to 7 (February to April 2027). The operations layer.
- Maintenance requests from owners (app and portal), assignment to suppliers, status, photos, cost booked
  to the right fund.
- Suppliers, contracts, documents per building.
- Assembly module: invitations, agenda, attendance, decisions, minutes, e-voting.
- Annual report generator on the RKD template; handover report and export.
- Owner mobile app (iOS/Android) with notifications.
- Team roles.
- Exit criterion: three paying management companies, at least one migrated from Domexa; owner app
  installed by 30 percent of owners in partner buildings.

### Phase 3: months 8 to 10 (May to July 2027). Money and compliance depth.
- УЈП e-Faktura: outbound for B2B unit owners, inbound supplier invoices into the expense ledger.
- Card payments through at least two bank gateways; instant payments if live.
- Accounting export for the common Macedonian accounting packages used by partners' accountants.
- Debt management: aging, notary-ready debt file, court status tracking.
- Exit criterion: 10 companies, more than 15,000 units billed monthly.

### Phase 4: months 11 to 12 (August to September 2027). Region.
- Second country pack. Pick the country where a design partner or reseller exists; avoid Serbia's
  crowded market first. Candidates are Kosovo, Albania, Montenegro, Bosnia and Herzegovina, evaluated on
  presence of a licensing regime and a partner, not on size alone.
- Exit criterion: pilot customer live outside Macedonia.

Estimate: the phase durations assume 3 to 4 engineers plus one product or domain person who owns the
partner relationship. Fewer people stretches the calendar; it does not change the order.

---

## 5. Architecture decisions that follow from the plan

- **Multi-tenant, multi-country from the first commit.** A country pack owns tax rules, currency and number
  formats, bank statement parsers, legal document templates, e-invoice adapter, and language. Macedonia is
  the first pack, not the core.
- **Ledger-first data model.** Every money movement is a posting against a building fund (regular or
  reserve) and an owner sub-account. Invoices, payments, expenses and reminders derive from postings. This
  is what makes Art. 42/45 separation, fund transparency and reconciliation cheap.
- **Legal events are first-class.** "Reminder due", "assembly notice deadline", "annual report due" are
  scheduled events with evidence (who, when, how delivered). Inspectors ask for exactly this.
- **Import and export are products, not utilities.** Switching cost is the moat Domexa hopes for; we
  destroy it in both directions, because Art. 30 handover exports are a legal duty anyway.
- **Stack.** Backend in .NET 10 with PostgreSQL (team strength, strong typing for money and ledgers),
  web front end in Vue or React, mobile in a cross-platform framework with push notifications. This is a
  recommendation, not a finding; the plan does not depend on it.
- **Keep out of scope in year one:** accounting software replacement, property sales or rentals,
  facility IoT, anything for landlords rather than managers.

---

## 6. Go-to-market

- **Lead list exists.** The commission runs a public contract registry (upraviteli.gov.mk) and licenses
  every manager [1]. Roughly 70 companies, concentrated in seven cities. This is a direct-sales market:
  one person can visit all of them in two quarters.
- **Sell the inspection.** Lead every conversation with the 160/2025 duties and show each one as a button.
  Managers have just been trained on these duties by the commission [6]; the fear is fresh.
- **Design partners as references.** Case study per partner after Phase 1: hours saved at month close,
  collection rate change, reminders sent automatically.
- **Owners pull managers.** Free owner app; owners in unmanaged or self-managed buildings can create a
  building and invite neighbours. Self-managed associations (2,557) get a free tier with limits. This is
  the growth loop Domexa cannot copy without an owner product.
- **Pricing (proposal, validate with partners).** Per unit per month, everything included, migration and
  onboarding free for the first 20 companies. At 135k units, capturing 20 percent at €0.25 per unit per
  month is about €80k ARR from Macedonia; the region is where the ceiling is. Domexa's €19 to €49 per
  month per company would need almost every company in the country to reach the same number.
- **Channel.** Accountants who serve managers, and banks that want e-commerce volume from the card
  add-on.

---

## 7. Risks and what we do about them

| Risk | Likelihood | Mitigation |
|---|---|---|
| Market is too small for the investment | High if MK only | Per-unit pricing, owner-side growth, second country by month 12; decide go/no-go on region at month 7 |
| RKD report template or inspection practice differs from the law text | Medium | Get templates from partners in Phase 0; build report as a template engine |
| УЈП e-Faktura spec or pilot access slips | Medium | It is Phase 3, not Phase 1; B2C invoices are outside the mandate anyway |
| Domexa ships fast and copies the roadmap | Medium | Their gap is the owner side and operations depth, which are months of work; we move first and lock partners with migration |
| Design partners churn or stall | Medium | Two or more partners, weekly cadence, we do their onboarding ourselves |
| Bank statement formats vary by bank and change | High | Parser per bank inside the country pack, review queue for unmatched lines, never silent |
| Legal text I used is the July 2025 government proposal, not the final gazette text | Medium | Phase 0 task: obtain Official Gazette 160/2025 and diff against the table in section 1.3 |

---

## 8. Success metrics

| When | Metric |
|---|---|
| End of Phase 1 | 1 partner closes a real month on us; 100 percent of its owners have portal access; reconciliation auto-matches 80 percent of statement lines |
| End of Phase 2 | 3 paying companies, 1 migrated from Domexa, owner app adoption 30 percent in partner buildings, reminders 100 percent automated |
| End of Phase 3 | 10 companies, 15,000 units billed monthly, e-Faktura live for B2B, accounting export used by 2 accountants |
| End of Phase 4 | 1 live customer in a second country, 20 percent of MK licensed managers |

---

## 9. Open decisions

1. Which design partner migrates first and on what date. Decides Phase 1 scope order.
2. Per-unit vs per-building pricing. Test both with partners in Phase 0.
3. Second country. Pick when a partner or reseller appears, not before month 7.
4. Whether to also offer the owner app to buildings with no manager at all (roughly half of the
   country). Big growth, but support load; decide after Phase 2 data.

---

## Sources

1. Regulatory Commission for Housing (РКД), rkd.gov.mk and the contract registry upraviteli.gov.mk; figures as reported in search results for the commission's latest data.
2. Faktor.mk, "Расте бројот на управители на згради, а инспектори ни за лек", 11 Aug 2023: 67 companies, 4,910 buildings, 117,425 units, 7,467 buildings total, 2,557 associations, 14 inspectors.
3. Government of North Macedonia, Proposal of the Law amending the Law on Housing, July 2025 (mchamber.mk copy). Articles quoted in section 1.3 refer to the amended base law numbering.
4. MARnet whois for domexa.mk: registered 05.08.2026.
5. Serbian vendors' public sites: troskovi.com, e-upravnik.rs, zgradahub.rs, mojazajednica.rs, zgradis.com, zgrada360.com.
6. RKD training notice on obligations from the Law amending the Law on Housing, Official Gazette 160/2025.
7. eArhiva.mk summaries of the VAT law amendment (Art. 53-b): mandatory e-invoicing via УЈП from 1 Oct 2026 for VAT payers, B2B/B2G, XML/UBL; Bloomberg Adria coverage.
8. NBRM and press on instant payments based on the TIPS clone (in preparation, not live).
9. UniBank e-banking guide: statement export in txt, xml, xls, MT940, pdf.
