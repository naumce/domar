import { formatAssemblyDate, formatAssemblyDateTime, type InvitationAgendaItem } from './assembly-invitation-html.js';
import { escapeHtml } from './invoice-html.js';

export interface MinutesAttendee { name: string; present: boolean; proxyName: string | null; weightBp: number }
export interface MinutesDecision {
  title: string; text: string | null; for: number; against: number; abstain: number;
  result: 'passed' | 'rejected' | 'no_quorum';
}

export interface AssemblyMinutesHtmlData {
  tenant: { name: string; companyNumber: string | null; address: string | null };
  building: { name: string; address: string; city: string; postalCode: string };
  scheduledAt: Date;
  heldAt: Date;
  location: string;
  agenda: InvitationAgendaItem[];
  quorumBasis: 'share' | 'count';
  quorum: { present: number; basisTotal: number; quorumReached: boolean };
  attendance: MinutesAttendee[];
  decisions: MinutesDecision[];
  labels: { assemblyLegal: string };
  timeZone: string;
  locale: 'mk';
}

const L = {
  mk: {
    title: 'Записник од собир на сопственици', building: 'Зграда', manager: 'Управител', held: 'Одржан на',
    scheduled: 'Свикан за', place: 'Место', agenda: 'Дневен ред', attendance: 'Присутни сопственици',
    owner: 'Сопственик', present: 'Присутен', proxy: 'Преку полномошник', weight: 'Гласови',
    yes: 'Да', no: 'Не', quorum: 'Кворум', quorumReached: 'Кворумот е исполнет', quorumMissed: 'Кворумот не е исполнет',
    basis: { share: 'по сопственички удел', count: 'по сопственик' },
    decisions: 'Одлуки', for: 'За', against: 'Против', abstain: 'Воздржани', result: 'Резултат',
    results: { passed: 'Усвоена', rejected: 'Одбиена', no_quorum: 'Без кворум' },
    signatures: 'Потписи', chair: 'Претседавач', minuteTaker: 'Записничар', witness: 'Заверувач',
  },
} as const;

const e = escapeHtml;

/** Art. 37: the record of what happened, filed as a `minutes` document the owners can download. */
export function renderAssemblyMinutesHtml({ tenant, building, scheduledAt, heldAt, location, agenda, quorumBasis, quorum, attendance, decisions, labels, timeZone, locale }: AssemblyMinutesHtmlData): string {
  const t = L[locale];
  const agendaHtml = agenda.map((x) => `<li><strong>${e(x.title)}</strong>${x.text ? `<div class="muted">${e(x.text)}</div>` : ''}</li>`).join('');
  const attendanceHtml = attendance.map((r) =>
    `<tr><td>${e(r.name)}</td><td>${e(r.present ? t.yes : t.no)}</td><td>${e(r.proxyName ?? '—')}</td><td class="num">${r.weightBp}</td></tr>`).join('');
  const decisionsHtml = decisions.map((d) =>
    `<tr><td><strong>${e(d.title)}</strong>${d.text ? `<div class="muted">${e(d.text)}</div>` : ''}</td><td class="num">${d.for}</td><td class="num">${d.against}</td><td class="num">${d.abstain}</td><td>${e(t.results[d.result])}</td></tr>`).join('');
  return `<!doctype html><html lang="mk"><head><meta charset="utf-8"><title>${e(t.title)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:0}
h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:16px 0 4px}.muted{color:#555}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{background:#f3f3f3}
td.num,th.num{text-align:right;white-space:nowrap}
ol{margin:4px 0 0 18px;padding:0}li{margin-bottom:6px}
.quorum{margin-top:8px;padding:8px;background:#f3f3f3}
.legal{margin-top:16px;padding:8px;background:#fafafa;border-left:3px solid #999}
.sign{margin-top:32px;display:flex;gap:24px}.sign div{flex:1;border-top:1px solid #111;padding-top:4px;text-align:center}
</style></head><body>
<h1>${e(t.title)}</h1>
<div><strong>${e(t.building)}:</strong> ${e(building.name)}, ${e(building.address)}, ${e(building.postalCode)} ${e(building.city)}</div>
<div><strong>${e(t.manager)}:</strong> ${e(tenant.name)}${tenant.companyNumber ? ` (${e(tenant.companyNumber)})` : ''}</div>
<div><strong>${e(t.scheduled)}:</strong> ${e(formatAssemblyDateTime(scheduledAt, timeZone))} · <strong>${e(t.place)}:</strong> ${e(location || '—')}</div>
<div><strong>${e(t.held)}:</strong> ${e(formatAssemblyDateTime(heldAt, timeZone))}</div>
<h2>${e(t.agenda)}</h2><ol>${agendaHtml}</ol>
<h2>${e(t.attendance)}</h2>
<table><thead><tr><th>${e(t.owner)}</th><th>${e(t.present)}</th><th>${e(t.proxy)}</th><th class="num">${e(t.weight)}</th></tr></thead><tbody>${attendanceHtml}</tbody></table>
<div class="quorum"><strong>${e(t.quorum)}</strong> (${e(t.basis[quorumBasis])}): ${quorum.present} / ${quorum.basisTotal} — ${e(quorum.quorumReached ? t.quorumReached : t.quorumMissed)}</div>
<h2>${e(t.decisions)}</h2>
<table><thead><tr><th>${e(t.decisions)}</th><th class="num">${e(t.for)}</th><th class="num">${e(t.against)}</th><th class="num">${e(t.abstain)}</th><th>${e(t.result)}</th></tr></thead><tbody>${decisionsHtml}</tbody></table>
<div class="legal">${e(labels.assemblyLegal)}</div>
<div class="sign"><div>${e(t.chair)}</div><div>${e(t.minuteTaker)}</div><div>${e(t.witness)}</div></div>
<div class="muted" style="margin-top:8px">${e(formatAssemblyDate(heldAt, timeZone))}</div>
</body></html>`;
}
