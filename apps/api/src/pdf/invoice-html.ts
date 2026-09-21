import type { getInvoice } from '../resources/invoices/repo.js';

export interface InvoiceHtmlData {
  invoice: Awaited<ReturnType<typeof getInvoice>>;
  tenant: { name: string; companyNumber: string | null; vatNumber: string | null; address: string | null; phone: string | null; email: string | null; bankName: string | null; bankAccount: string | null };
  formatMoney: (minor: number) => string;
  locale: 'mk';
}

const L = {
  mk: {
    title: 'Пресметка за трошоци', draft: 'НАЦРТ', from: 'Од', to: 'За', number: 'Број', period: 'Период', issued: 'Датум', due: 'Рок за плаќање', units: 'Единици',
    companyNumber: 'ЕМБС', vatNumber: 'ЕДБ', description: 'Опис', unit: 'Единица', buildingWide: 'За зградата', ownerNet: 'Ваш дел (нето)', vatRate: 'ДДВ %', vat: 'ДДВ', gross: 'Вкупно',
    services: 'Услуги и трошоци', managementFee: 'Надоместок за управувачки услуги', reserveFund: 'Резервен фонд', subtotal: 'Нето', tax: 'ДДВ', total: 'Вкупно за периодот', previous: 'Претходно салдо', due_: 'Вкупно за плаќање',
    rfBalance: 'Состојба на резервниот фонд на зградата', payment: 'Плаќање', bank: 'Банка', account: 'Сметка', reference: 'Цел на дознака', footer: 'Пресметката е изготвена согласно член 33 од Законот за домување.',
  },
} as const;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const e = escapeHtml;
const date = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');

export function renderInvoiceHtml({ invoice, tenant, formatMoney: m, locale }: InvoiceHtmlData): string {
  const t = L[locale];
  const inv = invoice;
  const groups: [string, typeof inv.lines][] = [
    [t.services, inv.lines.filter((l) => l.kind === 'service' || l.kind === 'manual')],
    [t.managementFee, inv.lines.filter((l) => l.kind === 'management_fee')],
    [t.reserveFund, inv.lines.filter((l) => l.kind === 'reserve_fund')],
  ];
  const rows = groups.filter(([, ls]) => ls.length > 0).map(([title, ls]) => `
    <tr class="group"><td colspan="7">${e(title)}</td></tr>
    ${ls.map((l) => `<tr><td>${e(l.description)}</td><td>${e(l.unitLabel)}</td><td class="num">${e(m(l.buildingWideNetMinor))}</td><td class="num">${e(m(l.ownerNetMinor))}</td><td class="num">${(l.taxRateBp / 100).toFixed(2)}</td><td class="num">${e(m(l.ownerTaxMinor))}</td><td class="num">${e(m(l.ownerGrossMinor))}</td></tr>`).join('')}`).join('');
  const contactName = `${inv.contact.firstName} ${inv.contact.lastName}`.trim();
  const unitLabels = [...new Set(inv.lines.map((l) => l.unitLabel))].join(', ');
  const account = inv.building.regularFundAccount ?? tenant.bankAccount ?? '';
  const reference = inv.number ?? inv.id;
  return `<!doctype html><html lang="mk"><head><meta charset="utf-8"><title>${e(inv.number ?? t.draft)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:0}
h1{font-size:18px;margin:0 0 4px}.muted{color:#555}.draft{color:#b00;font-weight:bold;font-size:14px}
.row{display:flex;justify-content:space-between;gap:24px;margin-bottom:16px}.box{flex:1}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}th{background:#f3f3f3}
td.num,th.num{text-align:right;white-space:nowrap}tr.group td{background:#fafafa;font-weight:bold;border-top:2px solid #ccc}
.totals td{border:none}.totals tr.due td{font-weight:bold;font-size:13px;border-top:2px solid #111}
.footer{margin-top:24px;font-size:10px;color:#555}
</style></head><body>
<div class="row"><div class="box"><h1>${e(t.title)}</h1>${inv.number ? `<div><strong>${e(t.number)}:</strong> ${e(inv.number)}</div>` : `<div class="draft">${e(t.draft)}</div>`}
<div><strong>${e(t.period)}:</strong> ${e(inv.period)}</div><div><strong>${e(t.issued)}:</strong> ${e(date(inv.issuedAt))} &nbsp; <strong>${e(t.due)}:</strong> ${e(date(inv.dueAt))}</div></div>
<div class="box"><div class="muted">${e(t.from)}</div><strong>${e(tenant.name)}</strong><br>${e(tenant.address ?? '')}<br>${tenant.companyNumber ? `${e(t.companyNumber)}: ${e(tenant.companyNumber)}<br>` : ''}${tenant.vatNumber ? `${e(t.vatNumber)}: ${e(tenant.vatNumber)}<br>` : ''}${e(tenant.phone ?? '')} ${e(tenant.email ?? '')}</div></div>
<div class="row"><div class="box"><div class="muted">${e(t.to)}</div><strong>${e(contactName)}</strong><br>${e(inv.contact.address ?? '')}<br>${inv.contact.companyNumber ? `${e(t.companyNumber)}: ${e(inv.contact.companyNumber)}<br>` : ''}</div>
<div class="box"><div class="muted">${e(inv.building.name)}</div>${e(inv.building.address)}, ${e(inv.building.postalCode)} ${e(inv.building.city)}<br>${e(t.units)}: ${e(unitLabels)}</div></div>
<table><thead><tr><th>${e(t.description)}</th><th>${e(t.unit)}</th><th class="num">${e(t.buildingWide)}</th><th class="num">${e(t.ownerNet)}</th><th class="num">${e(t.vatRate)}</th><th class="num">${e(t.vat)}</th><th class="num">${e(t.gross)}</th></tr></thead><tbody>${rows}</tbody></table>
<table class="totals"><tr><td></td><td class="num" style="width:40%">${e(t.subtotal)}: ${e(m(inv.subtotalMinor))}</td></tr>
<tr><td></td><td class="num">${e(t.tax)}: ${e(m(inv.taxMinor))}</td></tr>
<tr><td></td><td class="num">${e(t.total)}: ${e(m(inv.totalMinor))}</td></tr>
<tr><td></td><td class="num">${e(t.previous)}: ${e(m(inv.previousBalanceMinor))}</td></tr>
<tr class="due"><td></td><td class="num">${e(t.due_)}: ${e(m(inv.amountDueMinor))}</td></tr></table>
<p><strong>${e(t.rfBalance)}:</strong> ${e(m(inv.reserveFundBuildingBalanceMinor))}</p>
<div class="row"><div class="box"><strong>${e(t.payment)}</strong><br>${e(t.bank)}: ${e(tenant.bankName ?? '')}<br>${e(t.account)}: ${e(account)}<br>${e(t.reference)}: ${e(reference)}</div></div>
<div class="footer">${e(t.footer)}</div>
</body></html>`;
}
