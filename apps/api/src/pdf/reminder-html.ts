import { escapeHtml } from './invoice-html.js';

export interface ReminderHtmlInvoice {
  number: string | null;
  period: string;
  dueAt: Date | string | null;
  outstandingMinor: number;
}

export interface ReminderHtmlData {
  tenant: { name: string; companyNumber: string | null; vatNumber: string | null; address: string | null; phone: string | null; email: string | null; bankName: string | null; bankAccount: string | null };
  building: { name: string; address: string; city: string; postalCode: string; regularFundAccount: string | null };
  contact: { firstName: string; lastName: string; address: string | null; companyNumber: string | null };
  invoices: ReminderHtmlInvoice[];
  totalOutstandingMinor: number;
  labels: { reminderIntro: string; reminderLegal: string };
  formatMoney: (minor: number) => string;
  locale: 'mk';
  createdAt: Date;
}

const L = {
  mk: {
    title: 'Опомена за неплатени пресметки', from: 'Од', to: 'За', date: 'Датум', building: 'Зграда',
    companyNumber: 'ЕМБС', vatNumber: 'ЕДБ', number: 'Број', period: 'Период', due: 'Рок за плаќање', outstanding: 'Ненаплатено',
    total: 'Вкупен долг', payment: 'Плаќање', bank: 'Банка', account: 'Сметка', reference: 'Цел на дознака',
  },
} as const;

const e = escapeHtml;
const d = (x: Date | string | null) => (x ? new Date(x).toLocaleDateString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');

/**
 * The Art. 28 letter. There is deliberately no fee row anywhere in this template: the `mk` pack sets
 * `reminderRules.feeAllowed = false` and nothing in domar books or renders a reminder fee.
 */
export function renderReminderHtml({ tenant, building, contact, invoices, totalOutstandingMinor, labels, formatMoney: m, locale, createdAt }: ReminderHtmlData): string {
  const t = L[locale];
  const name = `${contact.firstName} ${contact.lastName}`.trim();
  const account = building.regularFundAccount ?? tenant.bankAccount ?? '';
  const rows = invoices.map((i) => `<tr><td>${e(i.number ?? '—')}</td><td>${e(i.period)}</td><td>${e(d(i.dueAt))}</td><td class="num">${e(m(i.outstandingMinor))}</td></tr>`).join('');
  return `<!doctype html><html lang="mk"><head><meta charset="utf-8"><title>${e(t.title)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:0}
h1{font-size:18px;margin:0 0 4px}.muted{color:#555}
.row{display:flex;justify-content:space-between;gap:24px;margin-bottom:16px}.box{flex:1}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}th{background:#f3f3f3}
td.num,th.num{text-align:right;white-space:nowrap}
.total{margin-top:8px;text-align:right;font-size:13px;font-weight:bold}
.legal{margin-top:16px;padding:8px;background:#fafafa;border-left:3px solid #999}
</style></head><body>
<div class="row"><div class="box"><h1>${e(t.title)}</h1><div><strong>${e(t.date)}:</strong> ${e(d(createdAt))}</div>
<div><strong>${e(t.building)}:</strong> ${e(building.name)}, ${e(building.address)}, ${e(building.postalCode)} ${e(building.city)}</div></div>
<div class="box"><div class="muted">${e(t.from)}</div><strong>${e(tenant.name)}</strong><br>${e(tenant.address ?? '')}<br>${tenant.companyNumber ? `${e(t.companyNumber)}: ${e(tenant.companyNumber)}<br>` : ''}${tenant.vatNumber ? `${e(t.vatNumber)}: ${e(tenant.vatNumber)}<br>` : ''}${e(tenant.phone ?? '')} ${e(tenant.email ?? '')}</div></div>
<div class="row"><div class="box"><div class="muted">${e(t.to)}</div><strong>${e(name)}</strong><br>${e(contact.address ?? '')}<br>${contact.companyNumber ? `${e(t.companyNumber)}: ${e(contact.companyNumber)}` : ''}</div></div>
<p>${e(labels.reminderIntro)}</p>
<table><thead><tr><th>${e(t.number)}</th><th>${e(t.period)}</th><th>${e(t.due)}</th><th class="num">${e(t.outstanding)}</th></tr></thead><tbody>${rows}</tbody></table>
<div class="total">${e(t.total)}: ${e(m(totalOutstandingMinor))}</div>
<div class="legal">${e(labels.reminderLegal)}</div>
<div class="row"><div class="box"><strong>${e(t.payment)}</strong><br>${e(t.bank)}: ${e(tenant.bankName ?? '')}<br>${e(t.account)}: ${e(account)}<br>${e(t.reference)}: ${e(invoices.map((i) => i.number ?? '').filter(Boolean).join(', '))}</div></div>
</body></html>`;
}
