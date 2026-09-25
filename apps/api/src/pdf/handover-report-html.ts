import type { HandoverReportData, ReportLabels } from '@domar/domain';
import { REPORT_CSS, reportDate } from './annual-report-html.js';
import { escapeHtml } from './invoice-html.js';

export interface HandoverReportHtmlData {
  tenant: { name: string; companyNumber: string | null; address: string | null; phone: string | null; email: string | null };
  building: { name: string; address: string; city: string; postalCode: string };
  data: HandoverReportData;
  labels: ReportLabels;
  formatMoney: (minor: number) => string;
  timeZone: string;
  locale: 'mk';
  createdAt: Date;
}

const L = {
  mk: {
    building: 'Зграда', manager: 'Досегашен управител', companyNumber: 'ЕМБС', asOf: 'Состојба на ден',
    contractEndsOn: 'Договорот за управување истекува на', noContract: 'нема евидентиран договор',
    reconciliation: 'Состојба на сметките', fund: 'Фонд', ledger: 'Според евиденција', bank: 'Според извод', difference: 'Разлика',
    fundNames: { regular: 'Редовен фонд', reserve: 'Резервен фонд' },
    balances: 'Салда по сопственик', owner: 'Сопственик', unit: 'Единица', billed: 'Фактурирано', collected: 'Наплатено', balance: 'Салдо',
    openItems: 'Неплатени пресметки', number: 'Број', period: 'Период', due: 'Рок', total: 'Вкупно', paid: 'Платено', outstanding: 'Неплатено',
    noOpenItems: 'Нема неплатени пресметки на денот на примопредавањето.',
    totalDebt: 'Вкупен долг', note: 'Забелешка', attachments: 'Прилог: податочен извоз (zip со седум CSV датотеки)',
    generated: 'Изготвен на',
  },
} as const;

const e = escapeHtml;

/** Art. 30: what the outgoing manager hands over, on one document, beside the data export. */
export function renderHandoverReportHtml({ tenant, building, data, labels, formatMoney: m, timeZone, locale, createdAt }: HandoverReportHtmlData): string {
  const t = L[locale];
  const f = data.fields;
  const n = (key: string) => Number(f[key] ?? 0);
  const s = (key: string) => String(f[key] ?? '');
  const reconciliationHtml = data.reconciliation.map((r) =>
    `<tr><td>${e(t.fundNames[r.fund])}</td><td class="num">${e(m(r.ledgerMinor))}</td><td class="num">${e(m(r.bankMinor))}</td><td class="num">${e(m(r.differenceMinor))}</td></tr>`).join('');
  const balancesHtml = data.owners.map((o) =>
    `<tr><td>${e(o.name)}</td><td>${e(o.unitLabels.join(', '))}</td><td class="num">${e(m(o.billedMinor))}</td><td class="num">${e(m(o.collectedMinor))}</td><td class="num">${e(m(o.balanceMinor))}</td></tr>`).join('');
  const openHtml = data.openItems.map((i) =>
    `<tr><td>${e(i.number ?? '')}</td><td>${e(i.period)}</td><td>${e(i.ownerName)}</td><td>${e(i.dueAt ? reportDate(i.dueAt, timeZone) : '—')}</td><td class="num">${e(m(i.totalMinor))}</td><td class="num">${e(m(i.paidMinor))}</td><td class="num">${e(m(i.outstandingMinor))}</td></tr>`).join('');
  return `<!doctype html><html lang="mk"><head><meta charset="utf-8"><title>${e(labels.handoverTitle)} ${e(s('asOf'))}</title>
<style>${REPORT_CSS}</style></head><body>
<div class="row"><div class="box"><h1>${e(labels.handoverTitle)}</h1>
<div><strong>${e(t.asOf)}:</strong> ${e(s('asOf'))}</div>
<div><strong>${e(t.contractEndsOn)}:</strong> ${e(s('contractEndsOn') || t.noContract)}</div>
<div><strong>${e(t.building)}:</strong> ${e(building.name)}, ${e(building.address)}, ${e(building.postalCode)} ${e(building.city)}</div></div>
<div class="box"><div class="muted">${e(t.manager)}</div><strong>${e(tenant.name)}</strong><br>${e(tenant.address ?? '')}<br>${tenant.companyNumber ? `${e(t.companyNumber)}: ${e(tenant.companyNumber)}<br>` : ''}${e(tenant.phone ?? '')} ${e(tenant.email ?? '')}</div></div>
<h2>${e(t.reconciliation)}</h2>
<table><thead><tr><th>${e(t.fund)}</th><th class="num">${e(t.ledger)}</th><th class="num">${e(t.bank)}</th><th class="num">${e(t.difference)}</th></tr></thead><tbody>${reconciliationHtml}</tbody></table>
<h2>${e(t.balances)}</h2>
<table><thead><tr><th>${e(t.owner)}</th><th>${e(t.unit)}</th><th class="num">${e(t.billed)}</th><th class="num">${e(t.collected)}</th><th class="num">${e(t.balance)}</th></tr></thead><tbody>${balancesHtml}
<tr class="total"><td colspan="4">${e(t.totalDebt)}</td><td class="num">${e(m(n('totalDebtMinor')))}</td></tr></tbody></table>
<h2>${e(t.openItems)}</h2>
${data.openItems.length === 0 ? `<p class="muted">${e(t.noOpenItems)}</p>` : `<table><thead><tr><th>${e(t.number)}</th><th>${e(t.period)}</th><th>${e(t.owner)}</th><th>${e(t.due)}</th><th class="num">${e(t.total)}</th><th class="num">${e(t.paid)}</th><th class="num">${e(t.outstanding)}</th></tr></thead><tbody>${openHtml}
<tr class="total"><td colspan="6">${e(t.outstanding)}</td><td class="num">${e(m(n('openItemsMinor')))}</td></tr></tbody></table>`}
${s('note') ? `<h2>${e(t.note)}</h2><p>${e(s('note'))}</p>` : ''}
<p class="muted">${e(t.attachments)}</p>
<div class="legal">${e(labels.handoverLegal)}</div>
<div class="muted" style="margin-top:8px">${e(t.generated)}: ${e(reportDate(createdAt, timeZone))}</div>
</body></html>`;
}
