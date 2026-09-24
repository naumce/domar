# Migrating a company from Domexa into domar

Three commands, in this order: `export` (reads Domexa), `transform` (reads nothing but files) and
`apply` (writes into one domar tenant through domar's own API). Nothing in the chain ever writes to
Domexa: the client refuses every method but `GET`, plus the single login `POST`.

## 0. Before you start

- A domar tenant must already exist, with an `owner` user. Register it at `/register`.
- Copy `.env.example` to `.env` and fill the migration block. Nothing here belongs in the repo, and
  `domexa-export/` is git-ignored and dockerignored.
- The Domexa API shape below is what their frontend bundle calls. Unit, contact and building **row**
  shapes were never observable (the demo account was empty), so the field mapping is a best guess and
  `report.md` names every field it did not understand. Expect to run `transform` twice.

| Variable | What it is |
| --- | --- |
| `DOMEXA_BASE_URL` | `https://domexa.mk` (the default), or `https://domexa.mk/<org>` if the API is nested |
| `DOMEXA_ORG` | the organization slug you type on their login page |
| `DOMEXA_EMAIL`, `DOMEXA_PASSWORD` | a user who may read everything |
| `DOMEXA_COOKIE` | `name=value` copied from a logged-in browser; skips the login entirely |
| `DOMAR_URL` | `http://localhost:3001` (the default) for a rehearsal; anything else needs `--yes` |
| `DOMAR_SLUG`, `DOMAR_EMAIL`, `DOMAR_PASSWORD` | the target tenant and its owner |

If their login answers with a Cloudflare challenge, log in with a browser, copy the session cookie
out of the developer tools and put it in `DOMEXA_COOKIE`. Then leave `DOMEXA_PASSWORD` empty.

Every command also takes `--dir` (default `domexa-export`), the folder `export` writes to and
`transform`/`apply` read from.

## 1. Export

    pnpm --filter @domar/api migrate:domexa -- export

Writes raw, uninterpreted JSON into `domexa-export/`: `organization.json`, `tax-rates.json`,
`services.json`, `service-categories.json`, `contacts.json`, `statements.json` (keyed by contact id),
`buildings.json`, and `units.json`, `building-services.json`, `reserve-funds.json`,
`reserve-fund-balances.json` (each keyed by building id). Every request is logged as method and path.
An endpoint that fails — 403, 404, a timeout — leaves a `null` behind and the export carries on. A
sub-resource is never written as an empty list, so `transform` can tell "this building has no units"
from "the units were never exported": a `null` in `units.json` or `building-services.json` becomes a
line under **Skipped rows** in `report.md` (`building b7: units were not exported`) and that building
gets no `units-<key>.csv` at all, which `apply` then counts as `missingCsv` instead of creating the
building empty. A `null` `contacts.json` or `statements.json` becomes a line under **Notes** — every
owner name, or every opening balance, is then missing. Re-run `export` before trusting the result.

## 2. Transform

    pnpm --filter @domar/api migrate:domexa -- transform --from 2026-09

Writes `domexa-export/domar/`:

- `units-<building>.csv` — our units/owners template, one per building, with the owner's opening
  balance taken from their contact statement's closing balance (positive = the owner owes) and
  placed on their **first** unit only.
- `tax-rates.json`, `services.json`, `buildings.json`, `building-services.json`, `reserve-fund.json`
  — request bodies with names where domar will have ids (`taxRateName`, `serviceName`, `buildingKey`).
- `organization.json` — their company row, for you to copy into Settings by hand. The migration does
  not touch tenant settings.
- `report.md` — counts, every source field nothing consumed, every skipped row and every guess.

Amounts are read with the organization's own separators (`/api/organization`). Under the mk defaults
a lone `.` with a three-digit tail is a **thousands** group, so a Domexa `"1.500"` reads as 1500 and
a `"1.234"` as 1234 — every export observed carries exactly two decimals, but if a rate ever arrives
with three, check it by eye in `report.md` before applying.

`--from` is the period a recurring service starts from when Domexa's row carries no start date; it
defaults to the current month. A file `transform` cannot find (a missing `organization.json`, an
absent building's `units.json`, …) is treated as empty and logged, not a fatal error; only a file
that exists but fails to parse as JSON stops the run. Two Domexa buildings that would collapse into
the same building key (the key is the Domexa **id** with everything but letters and digits replaced
by `-`, so `A 1` and `A/1` both become `a-1`) is a fatal error, since the CSV filename and the JSON
plans would then merge two buildings into one.

### The mapping file

When `report.md` lists a field under "Unknown fields" that should have been imported, write a JSON
file and pass `--map map.json`. It overrides one subtree of the defaults at a time:

```json
{
  "unit": {
    "label": ["broj", "number"],
    "areaM2": ["povrsina", "area"]
  },
  "statement": { "closingBalance": ["saldo"] }
}
```

Each value is a list of candidate paths, tried in order; `owner.firstName` walks into a nested
object. Anything you do not mention keeps the default from
`packages/domain/src/migration/domexa.ts` (`DEFAULT_FIELD_MAP`). A section or a leaf the map file
does not recognise (a typo, an unknown target) is reported and ignored rather than silently doing
nothing — check the `transform` output for `--map: unknown …` lines.

## 3. Apply

    pnpm --filter @domar/api migrate:domexa -- apply --dry-run
    pnpm --filter @domar/api migrate:domexa -- apply

The dry run performs every read and no write, and prints the same summary the real run prints. The
real run creates, in order: tax rates, services, buildings, units (through the ordinary CSV import,
with `mode: 'skip'`), building services, the reserve fund setting and the reserve fund's opening
balance.

It is idempotent, and matches on:

| Entity | Matched by | A second run |
| --- | --- | --- |
| tax rate | exact name *and* rate | reuses it; a same-named rate at a different rate gets its own row, named with the percentage |
| service | exact name | reuses it |
| building | exact name, address *and* city | reuses it |
| unit | label inside the building | skips it (no duplicate, no second contact) |
| contact | email, else exact first + last name | reuses it |
| building service | service id inside the building | reuses it |
| reserve fund setting | the building | kept as-is, unless `--force-settings` |
| reserve fund opening balance | booked only into a fund whose balance is exactly 0 | skips it |

`apply` refuses any `DOMAR_URL` that is not `http://localhost…` or `http://127.0.0.1…` unless you
add `--yes`. Rehearse against a local server first, look at the tenant, then repeat against the real
one. `--force-settings` overwrites a reserve fund setting the tenant already has (`PUT` again); left
off, an existing setting is kept and logged, never overwritten.

### Reading the summary

`apply` prints one JSON object when it finishes (also on a dry run). Each entity above contributes a
`{ created, existing }` pair (tax rates, services, buildings) or its own shape:

- `units`: `imported`, `skipped` (conflicting labels), `contacts` (new), `openingBalances` (booked),
  `estimated` (rows counted from the CSV instead of previewed, because the building did not exist
  yet at the time of a dry run), `missingCsv` (buildings with no `units-<key>.csv`, or an empty one),
  `errors` (`{ line, message }`, mirroring the CSV import's own row errors) and `conflicts` (the
  `<building-key>:<label>` pairs that already existed and were skipped).
- `buildingServices`: `created`, `existing`, and `duplicates` — a service planned twice for the same
  building, where only the first row is attached.
- `reserveFund`: `settings.written` / `settings.kept` (see the table above) and `openingBalances`
  (postings actually made).

## Dependencies

The mapping step in the web Import tab parses spreadsheets with `xlsx@0.18.5`, the last release on
npm. It carries two published advisories — prototype pollution (GHSA-4r6h-8v6p-xvw6) and a ReDoS
(GHSA-5pgg-2g8v-p4x9), both fixed only in SheetJS's own CDN builds — so `pnpm audit` flags it. The
exposure is one operator's browser parsing a file that operator chose; nothing server-side reads a
workbook. Accepted for now; revisit by pinning the SheetJS CDN tarball if the tab ever takes a file
from anyone but the operator.

## What is not migrated

- **Invoices and their line items.** Domexa's invoices were produced by Domexa's own calculation and
  numbering; re-issuing them in domar would produce different documents under the same numbers. What
  each owner still owes arrives instead as **one opening balance per owner**, from their statement's
  closing balance, so every ledger starts at the right number.
- **Payments and the payment history.** Same reason: they are netted into that opening balance.
- **Reminders, e-mail logs, audit history, users, invoice numbering counters, card-payment settings,
  organization settings and the reserve fund's expense history.** Create the users by hand in
  Settings → Users, and copy the company details into Settings → Organization.
- **Unit "attached to" links.** domar has the column; Domexa's field name for it was not observable.
  If `report.md` names it, add it to your mapping file and set the links by hand afterwards.

## After the migration

1. Settings → Organization: company number, VAT number, bank, timezone.
2. Settings → Users: one user per employee.
3. Each building: check the units, the owners and the "Opening balances" tab against `report.md`.
4. Only then open the first period.
