import type { AnnualReportData, ReportLabels } from '@domar/domain';
import { escapeHtml } from './invoice-html.js';

export interface AnnualReportHtmlData {
  tenant: { name: string; companyNumber: string | null; address: string | null; phone: string | null; email: string | null };
  building: { name: string; address: string; city: string; postalCode: string };
  data: AnnualReportData;
  labels: ReportLabels;
  formatMoney: (minor: number) => string;
  /** The tenant's IANA zone: a report prints local dates, never the server's. */
  timeZone: string;
  locale: 'mk';
  createdAt: Date;
}

/** Shared with `handover-report-html.ts`, so the two documents are visibly one family. */
export const REPORT_CSS = `
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:0}
h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:16px 0 4px}h3{font-size:11px;margin:12px 0 0;font-weight:bold}.muted{color:#555}
.row{display:flex;justify-content:space-between;gap:24px;margin-bottom:16px}.box{flex:1}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{background:#f3f3f3}
td.num,th.num{text-align:right;white-space:nowrap}tr.total td{font-weight:bold;border-top:2px solid #111}
.legal{margin-top:16px;padding:8px;background:#fafafa;border-left:3px solid #999}
.kpi{display:flex;gap:8px;margin-top:8px}.kpi div{flex:1;padding:8px;background:#f3f3f3}
.kpi strong{display:block;font-size:14px}
`;

export const reportDate = (x: Date | string, timeZone: string): string =>
  new Date(x).toLocaleDateString('mk-MK', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' });

const L = {
  mk: {
    building: 'Зграда', manager: 'Управител', companyNumber: 'ЕМБС', year: 'Година', units: 'Единици', owners: 'Сопственици',
    funds: 'Состојба на фондовите', fund: 'Фонд', opening: 'Почетна состојба', inflow: 'Приливи', outflow: 'Одливи',
    netInflow: 'Нето приливи', netOutflow: 'Нето одливи', closing: 'Завршна состојба',
    fundNames: { regular: 'Редовен фонд', reserve: 'Резервен фонд' },
    movements: 'Движења по вид', movementKind: 'Вид', movementRef: 'Основ', net: 'Нето', noMovements: 'Нема движења во периодот.',
    income: 'Фактурирање и наплата', billed: 'Фактурирано', collected: 'Наплатено', rate: 'Степен на наплата',
    expenses: 'Трошоци по добавувач', supplier: 'Добавувач', countCol: 'Ставки', amount: 'Износ', totalExpenses: 'Вкупно трошоци',
    works: 'Изведени работи (резервен фонд)', description: 'Опис', date: 'Датум',
    debtors: 'Должници', owner: 'Сопственик', unit: 'Единица', debt: 'Долг', totalDebt: 'Вкупен долг', noDebtors: 'Нема должници на крајот на периодот.',
    activity: 'Активности во периодот', reminders: 'Испратени опомени', assemblies: 'Одржани собири', decisions: 'Донесени одлуки',
    generated: 'Изготвен на',
  },
} as const;

/**
 * The ledger's own vocabulary, in the pack's language. An unmapped code is printed as it stands
 * rather than dropped: a movement the reader cannot name is still a movement of their money.
 */
const KIND_NAMES: Record<string, string> = {
  charge: 'Задолжување', payment: 'Уплата', expense: 'Трошок', adjustment: 'Корекција', opening: 'Почетна состојба',
};
const REF_NAMES: Record<string, string> = {
  invoice: 'Фактура', payment: 'Уплата', payment_void: 'Сторно уплата',
  expense: 'Трошок', expense_void: 'Сторно трошок', opening_balance: 'Почетно салдо',
};

const e = escapeHtml;
/** A comma decimal, like every other number this document prints. */
const pct = (bp: number) => `${(bp / 100).toFixed(2).replace('.', ',')} %`;

/** Art. 31: the year of a building, on one document, from `buildAnnualReport`'s figures alone. */
export function renderAnnualReportHtml({ tenant, building, data, labels, formatMoney: m, timeZone, locale, createdAt }: AnnualReportHtmlData): string {
  const t = L[locale];
  const f = data.fields;
  const n = (key: string) => Number(f[key] ?? 0);
  const fundsHtml = data.funds.map((x) =>
    `<tr><td>${e(t.fundNames[x.fund])}</td><td class="num">${e(m(x.openingMinor))}</td><td class="num">${e(m(x.inflowMinor))}</td><td class="num">${e(m(x.outflowMinor))}</td><td class="num">${e(m(x.netInflowMinor))}</td><td class="num">${e(m(x.netOutflowMinor))}</td><td class="num">${e(m(x.closingMinor))}</td></tr>`).join('');
  // Every fund posting of the window, grouped as it was booked: a void stands beside what it
  // reversed, which is how the page itself shows the two netting out.
  const movementRows = data.funds.flatMap((x) => x.movements.map((mv) =>
    `<tr><td>${e(t.fundNames[x.fund])}</td><td>${e(KIND_NAMES[mv.kind] ?? mv.kind)}</td><td>${e(REF_NAMES[mv.refType] ?? mv.refType)}</td><td class="num">${e(m(mv.inflowMinor))}</td><td class="num">${e(m(mv.outflowMinor))}</td><td class="num">${e(m(mv.netMinor))}</td></tr>`)).join('');
  const suppliersHtml = data.expensesBySupplier.map((x) =>
    `<tr><td>${e(x.supplier)}</td><td class="num">${x.count}</td><td class="num">${e(m(x.amountMinor))}</td></tr>`).join('');
  const worksHtml = data.works.map((x) =>
    `<tr><td>${e(x.description)}</td><td>${e(x.supplier)}</td><td>${e(reportDate(x.paidAt, timeZone))}</td><td class="num">${e(m(x.amountMinor))}</td></tr>`).join('');
  const debtorsHtml = data.debtors.map((x) =>
    `<tr><td>${e(x.name)}</td><td>${e(x.unitLabels.join(', '))}</td><td class="num">${e(m(x.balanceMinor))}</td></tr>`).join('');
  return `<!doctype html><html lang="mk"><head><meta charset="utf-8"><title>${e(labels.annualTitle)} ${e(String(f.year ?? ''))}</title>
<style>${REPORT_CSS}</style></head><body>
<div class="row"><div class="box"><h1>${e(labels.annualTitle)} ${e(String(f.year ?? ''))}</h1>
<div><strong>${e(t.building)}:</strong> ${e(building.name)}, ${e(building.address)}, ${e(building.postalCode)} ${e(building.city)}</div>
<div><strong>${e(t.units)}:</strong> ${n('unitCount')} &nbsp; <strong>${e(t.owners)}:</strong> ${n('ownerCount')}</div></div>
<div class="box"><div class="muted">${e(t.manager)}</div><strong>${e(tenant.name)}</strong><br>${e(tenant.address ?? '')}<br>${tenant.companyNumber ? `${e(t.companyNumber)}: ${e(tenant.companyNumber)}<br>` : ''}${e(tenant.phone ?? '')} ${e(tenant.email ?? '')}</div></div>
<h2>${e(t.funds)}</h2>
<table><thead><tr><th>${e(t.fund)}</th><th class="num">${e(t.opening)}</th><th class="num">${e(t.inflow)}</th><th class="num">${e(t.outflow)}</th><th class="num">${e(t.netInflow)}</th><th class="num">${e(t.netOutflow)}</th><th class="num">${e(t.closing)}</th></tr></thead><tbody>${fundsHtml}</tbody></table>
<h3>${e(t.movements)}</h3>
${movementRows === '' ? `<p class="muted">${e(t.noMovements)}</p>` : `<table><thead><tr><th>${e(t.fund)}</th><th>${e(t.movementKind)}</th><th>${e(t.movementRef)}</th><th class="num">${e(t.inflow)}</th><th class="num">${e(t.outflow)}</th><th class="num">${e(t.net)}</th></tr></thead><tbody>${movementRows}</tbody></table>`}
<h2>${e(t.income)}</h2>
<div class="kpi"><div>${e(t.billed)}<strong>${e(m(n('billedMinor')))}</strong></div><div>${e(t.collected)}<strong>${e(m(n('collectedMinor')))}</strong></div><div>${e(t.rate)}<strong>${e(pct(n('collectionRateBp')))}</strong></div></div>
<h2>${e(t.expenses)}</h2>
<table><thead><tr><th>${e(t.supplier)}</th><th class="num">${e(t.countCol)}</th><th class="num">${e(t.amount)}</th></tr></thead><tbody>${suppliersHtml}
<tr class="total"><td>${e(t.totalExpenses)}</td><td class="num">${data.expenses.length}</td><td class="num">${e(m(n('expensesMinor')))}</td></tr></tbody></table>
<h2>${e(t.works)}</h2>
<table><thead><tr><th>${e(t.description)}</th><th>${e(t.supplier)}</th><th>${e(t.date)}</th><th class="num">${e(t.amount)}</th></tr></thead><tbody>${worksHtml}
<tr class="total"><td colspan="3">${e(t.works)}</td><td class="num">${e(m(n('worksMinor')))}</td></tr></tbody></table>
<h2>${e(t.debtors)}</h2>
${data.debtors.length === 0 ? `<p class="muted">${e(t.noDebtors)}</p>` : `<table><thead><tr><th>${e(t.owner)}</th><th>${e(t.unit)}</th><th class="num">${e(t.debt)}</th></tr></thead><tbody>${debtorsHtml}
<tr class="total"><td colspan="2">${e(t.totalDebt)}</td><td class="num">${e(m(n('totalDebtMinor')))}</td></tr></tbody></table>`}
<h2>${e(t.activity)}</h2>
<div class="kpi"><div>${e(t.reminders)}<strong>${n('remindersSent')}</strong></div><div>${e(t.assemblies)}<strong>${n('assembliesHeld')}</strong></div><div>${e(t.decisions)}<strong>${n('decisionsTaken')}</strong></div></div>
<div class="legal">${e(labels.annualLegal)}</div>
<div class="muted" style="margin-top:8px">${e(t.generated)}: ${e(reportDate(createdAt, timeZone))}</div>
</body></html>`;
}
