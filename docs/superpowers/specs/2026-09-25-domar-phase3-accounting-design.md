# domar Phase 3, first subsystem: the accounting export

Date: 2026-09-25. Builds on the Phase 1 design (`2026-09-21-domar-phase1-design.md`) and the Phase 2
design (`2026-09-24-domar-phase2-design.md`), whose architecture, conventions and global constraints
remain binding. Both specs list "accounting export" as out of scope, kept for this phase.

## 1. Goal

A manager hands their accountant one file per month and the accountant posts it. Today they hand over
a spreadsheet they built by hand from four screens, and every month they rebuild it.

The export is a **double-entry journal** derived from the ledger, plus a trial balance that proves it
balances. It is not tied to one accounting product: the tenant maps its own account codes onto a
fixed set of slots, so the same export feeds Pantheon, Logik or an accountant's own Excel.

Out of scope here, kept for the rest of Phase 3: УЈП e-Faktura, card payments, notary debt files.

## 2. Why a journal and not a report

The system already has reports (Art. 31 annual, Art. 30 handover). They answer "how did this building
do". An accountant needs a different thing: every movement as a pair of signed lines against account
codes, in a period, that sums to zero. A report that does not balance cannot be posted, and an export
that silently does not balance is worse than none — so balance is an invariant, not a feature.

## 3. The chart of accounts

- `account_codes`: `tenant_id`, `slot` (enum, below), `code` (text, the accountant's own code),
  `name`, `is_active`, unique on `(tenant_id, slot)`. One row per slot per tenant.
- **Slots** — the fixed set the derivation needs, and the only ones:
  `owner_receivable`, `revenue_service`, `revenue_management_fee`, `revenue_reserve_fund`,
  `vat_output`, `cash_regular`, `cash_reserve`, `expense_default`, `opening_balance`.
- `suppliers` gains `account_code_id` (nullable): an expense booked to that supplier uses its account
  instead of `expense_default`. This is deliberately cheaper than an expense-category taxonomy, and it
  is the distinction an accountant actually asks for.
- The export **refuses to run** while a required slot is unmapped, naming every missing slot in the
  error. A half-mapped chart produces a file that looks right and posts wrong.

## 4. Derivation

For a window and an optional building, every ledger movement becomes one balanced entry. `postings`
(`packages/db/src/schema/billing.ts:177`) is the source; invoices and their lines supply the revenue
split and the VAT, because `postings` records an invoice as a single owner charge.

| event | debit | credit |
|---|---|---|
| invoice published | `owner_receivable` (gross) | `revenue_*` per line kind (net), `vat_output` (tax) |
| payment | `cash_regular` or `cash_reserve` by fund | `owner_receivable` |
| payment void | `owner_receivable` | the same cash account |
| expense paid | the supplier's account, else `expense_default` | the fund's cash account |
| expense void | the fund's cash account | the same expense account |
| opening balance | `owner_receivable` or the fund's cash account, by sign | `opening_balance` |

- Line kinds map: `service` and `manual` to `revenue_service`, `management_fee` to
  `revenue_management_fee`, `reserve_fund` to `revenue_reserve_fund`.
- Money stays in integer minor units throughout; the CSV renders it once, at the edge.
- Rounding: an invoice's line sum is already reconciled to its total by the largest-remainder
  allocation, so no rounding account is needed. If an entry ever fails to balance the export fails
  loudly rather than inventing a plug.

## 5. Period close

- `accounting_periods`: `tenant_id`, `period` (char 7), `closed_at`, `closed_by`, `debit_total_minor`,
  `credit_total_minor`, `entry_count`. Unique on `(tenant_id, period)`.
- Closing a period is **advisory, not a lock**. Nothing in the billing, payment or expense flows gains
  a new refusal: a payment for September that arrives in October must still be recordable, because it
  happens and refusing it would push the manager back to paper.
- What close buys is honesty about it. A posting booked into a closed period afterwards is reported by
  the next export as a **prior-period adjustment**, in its own section with the date it really arrived
  and the period it belongs to. That is the standard accounting treatment and it is what an accountant
  needs in order to trust the earlier file they already posted.
- Re-closing a period is allowed and rewrites the totals, recording who and when in the audit trail.

## 6. Output

One zip, built the way the handover export already is (`resources/reports/export.ts`): `;`-delimited
CSV with a byte-order mark so Excel opens it correctly in Macedonian, zipped with `fflate`, stored as
a `document` and downloaded through the existing document route.

- `dnevnik.csv` — the journal. One row per line: entry number, date, period, account code, account
  name, debit, credit, description, building, counterparty, source type, source id.
- `bruto-bilans.csv` — the trial balance: one row per account code with debit and credit totals and
  the difference, plus a total row that must read zero.
- `korekcii.csv` — prior-period adjustments, present only when there are any.
- `README.txt` — tenant, window, when it was produced, the entry and line counts, the debit and credit
  totals, and the closed periods it covers. A file an accountant can check at a glance.

## 7. API and web

- `GET /api/account-codes`, `PUT /api/account-codes/:slot` — the chart. Writes are `owner`/`accountant`.
- `POST /api/accounting/export` `{ from, to, buildingId? }` → builds the zip, stores it, returns the
  document id. `GET /api/accounting/preview` returns the trial balance as data, so the screen can show
  whether it balances before anything is filed.
- `POST /api/accounting/periods/:period/close`, `DELETE` to reopen.
- Web: one **Accounting** page in the manager app — the chart of accounts with its unmapped slots
  called out, a window picker, a trial balance that turns red when it does not balance, the export
  button, and the list of closed periods. `readonly` sees it; only `owner`/`accountant` may write.

## 8. Invariants (in addition to Phase 1 §16 and Phase 2 §11)

- Every entry balances, and the export fails rather than emitting an unbalanced file.
- The export derives from `postings` and never from a screen's aggregate, so it cannot disagree with
  the ledger the invoices were built from.
- Money never leaves integer minor units until the CSV is written.
- Closing a period adds no refusal anywhere else in the system.
- Every statement is filtered by `ctx.tenantId`; every mutation writes an audit row in its transaction.
- No new posting kinds and no writes to `postings` from this subsystem. It is a reader.
