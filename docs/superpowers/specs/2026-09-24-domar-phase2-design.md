# domar Phase 2 design: the operations and compliance layer

Date: 2026-09-24. Builds on the Phase 1 design (`2026-09-21-domar-phase1-design.md`, §1–§20), whose
architecture, conventions and global constraints (§16) remain binding. Source of scope: the business plan
(`docs/BUSINESS-PLAN.md`, Phase 2) and the regulatory table (Law on Housing, Official Gazette 160/2025).

## 1. Goal

A licensed manager opens one screen per building and sees every legal duty of 160/2025 as a status with
evidence behind it. The sales pitch "show each duty as a button" becomes the product's information
architecture: the **Compliance** screen is the home of a building, and the modules below feed it.

Out of scope for Phase 2 (kept for Phase 3): УЈП e-Faktura, card payments, accounting export, notary
debt files, native mobile apps (the portal becomes an installable PWA with push instead).

## 2. Sub-plans (each ships working software, in this order)

1. **Compliance and documents** — legal-event model, compliance screen, documents per building,
   suppliers and contracts, extraordinary costs (Art. 47(5)).
2. **Assembly** — invitations 15 days ahead with agenda (Art. 37), attendance and quorum, decisions,
   minutes, e-voting in the portal, evidence of delivery.
3. **Reports** — annual report on a template (Art. 31), handover report and full export on contract end
   (Art. 30, 8-day clock), both as PDF plus data files.
4. **Maintenance** — owner requests from the portal, assignment to suppliers, status, photos, cost booked
   to the right fund as an expense; technician role gets a real job.
5. **Portal PWA and notifications** — installable portal, web push for invoices, reminders, assembly
   invitations and maintenance updates; in-app notification list; email fallback.

## 3. Legal events (the spine)

- Table `legal_events`: `tenant_id`, `building_id`, `kind` (`reminder_sent`, `assembly_invited`,
  `assembly_held`, `annual_report_issued`, `handover_report_issued`, `fund_statement_available`,
  `invoice_published`, `extraordinary_cost_distributed`, …), `ref_type`, `ref_id`, `occurred_at`,
  `due_at` (nullable), `evidence` (jsonb: who, how delivered — `email`/`letter`/`portal`, message ids,
  document ids), `created_by`, `created_at`. Append-only; never edited or deleted.
- Existing modules write events: publishing a period (`invoice_published`, one per period), sending a
  reminder (`reminder_sent`), marking printed (`reminder_sent` with `letter`), portal fund page being
  live (`fund_statement_available`, once per building when the first owner links).
- **Compliance screen** per building computes, per duty, a status `ok` | `due` | `overdue` | `n/a`
  from events and dates, with the legal article, the next due date and the last evidence:
  - Art. 19/33 invoices: last published period ≤ 1 month old.
  - Art. 28 reminders: no owner meets the threshold without a reminder in the last 30 days.
  - Art. 37 assembly: an assembly held in the last 12 months; invitation sent ≥ 15 days before.
  - Art. 31 annual report: issued in the last 12 months.
  - Art. 45(4) fund transparency: at least one owner has portal access; fund statement available.
  - Art. 42/45 separate accounts: building has both fund account numbers filled.
  - Art. 30 handover: only when a building contract has an end date — due 8 days after it.
  - Art. 47(5) extraordinary costs: informational count.
- Pure evaluation in `packages/domain/src/compliance/evaluate.ts` from a snapshot of dates and events;
  API `GET /buildings/:id/compliance` and a tenant-wide `GET /compliance` (worst status per building).
  Every rule carries `article`, `label` (pack labels, Macedonian first) and `howToFix` (deep link).

## 4. Documents, suppliers, contracts

- `documents`: `tenant_id`, `building_id` (nullable for tenant-level), `kind` (`contract`, `minutes`,
  `report`, `invoice_supplier`, `photo`, `other`), `title`, `file_name`, `mime`, `size_bytes`,
  `storage_key`, `sha256`, `uploaded_by`, `created_at`. Storage: local disk under `DATA_DIR/documents/<tenant>/`
  behind an interface (`DocumentStore`), S3-compatible driver later; served via
  `GET /documents/:id/download` with tenant check; max 20 MB; allowed mime list.
- `suppliers`: `tenant_id`, `name`, `company_number`, `vat_number`, `email`, `phone`, `iban`, `notes`,
  `is_active`. `building_contracts`: `tenant_id`, `building_id`, `supplier_id` (nullable = the manager's
  own management contract), `kind` (`management`, `service`, `insurance`, `other`), `title`,
  `starts_on`, `ends_on` (nullable), `notice_days`, `amount_minor` (nullable), `document_id`.
  The management contract's `ends_on` drives the Art. 30 clock.
- Expenses gain `supplier_id` (nullable, keeps `supplier_text`) and `document_id`.

## 5. Extraordinary costs (Art. 47(5))

- `POST /buildings/:id/extraordinary-costs` `{ description, amountMinor, fund, distribution:
  'share' | 'equal' | 'area', appliesTo, dueDays, documentId? }` creates an **extra period line set**:
  a one-off `billing_period` of kind `extraordinary` for the current month (or the next if published)
  with a single manual line and the chosen distribution basis, generated and published through the
  existing engine so invoices, ledger and reminders behave as usual. Writes `extraordinary_cost_distributed`.

## 6. Assembly (Art. 37)

- `assemblies`: `tenant_id`, `building_id`, `scheduled_at`, `location`, `agenda` (jsonb items),
  `status` (`draft`, `invited`, `held`, `cancelled`), `invited_at`, `quorum_basis` (`share` | `count`),
  `minutes_document_id`, `held_at`; `assembly_invitations` (per owner contact: channel, sent_at,
  email_log id or printed); `assembly_attendance` (contact, present, proxy_name);
  `assembly_decisions` (title, text, votes_for/against/abstain as shares or counts, result);
  `assembly_votes` (decision, contact, choice, cast_at, via `portal` | `paper`).
- Inviting requires `scheduled_at − now ≥ 15 days` (override with reason, audited, flagged on the
  compliance screen as `late_invitation`). Invitation PDF + email + portal notification.
- Portal: upcoming assembly, agenda, vote per decision while voting is open; owner sees result.
- Minutes: generated HTML/PDF from agenda, attendance, decisions; stored as a document; `assembly_held`
  event with evidence.

## 7. Reports (Art. 31, Art. 30)

- Annual report: for a building and a calendar year — fund opening/closing balances per fund, income
  by category (charges billed, payments received), expenses by supplier/category, reserve fund
  contributions and uses, debtor list (aggregate + per owner), reminders sent, assemblies held, works
  done. Rendered from a template (`packages/domain/src/reports/annual.ts` produces the data; HTML
  template in the API; PDF via the existing renderer). Stored as a document; `annual_report_issued`
  event. Template fields kept in a single map so the RKD template, once obtained, is a template change.
- Handover report (Art. 30): same data up to the contract end date plus the full owner balance list,
  open items, bank account balances entered by the manager, and a **data export** (zip of CSV: units,
  owners, balances, invoices, payments, expenses, documents index). `handover_report_issued` event;
  compliance shows the 8-day clock.

## 8. Maintenance

- `maintenance_requests`: `tenant_id`, `building_id`, `unit_id` (nullable), `reported_by` (contact or
  user), `title`, `description`, `category`, `priority`, `status` (`new`, `triaged`, `assigned`,
  `in_progress`, `done`, `rejected`), `assignee_user_id`, `supplier_id`, `fund`, `cost_minor`
  (nullable), `expense_id` (nullable), photos as documents (`kind photo`), `created_at`, `closed_at`;
  `maintenance_events` (status changes with note, author, timestamp).
- Portal: owner creates a request with photos, follows status, gets notifications. Manager: board by
  status, assign to technician user or supplier, close with cost → creates an expense on the chosen
  fund (existing expense flow) and links it. Technician role: sees and updates assigned requests only.

## 9. Portal PWA and notifications

- Web manifest + service worker for `/portal`; installable; offline shell only.
- `push_subscriptions` (owner account, endpoint, keys); Web Push (VAPID keys in env) with
  `notifications` table (owner account, kind, title, body, link, read_at). Triggers: invoice published,
  reminder created, assembly invited/decision opened, maintenance status change. Email fallback when no
  subscription. Manager-side: in-app bell for new maintenance requests and failed sends.

## 10. Roles

- `technician` gains maintenance access (assigned requests, photos, status) and read on buildings.
- `readonly` sees compliance and reports. Owner/accountant unchanged.

## 11. Invariants (in addition to Phase 1 §16)

- Legal events are append-only and carry evidence; the compliance screen never reads anything but
  events plus dates already in the system.
- Every document download checks the tenant and, for portal users, the link (minutes and reports of
  their building only).
- Uploaded files are stored outside the web root, streamed, never executed, mime-checked, size-capped.
- Extraordinary costs and maintenance costs reach the ledger only through the existing period and
  expense flows; no new posting kinds.
- Notifications never include amounts in push payloads (title + link only); details load in the app.
