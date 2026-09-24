import { escapeHtml } from './invoice-html.js';

export interface InvitationAgendaItem { id: string; title: string; text: string }
export interface InvitationDecision { title: string; text: string | null }

export interface AssemblyInvitationHtmlData {
  tenant: { name: string; companyNumber: string | null; vatNumber: string | null; address: string | null; phone: string | null; email: string | null };
  building: { name: string; address: string; city: string; postalCode: string };
  scheduledAt: Date;
  location: string;
  agenda: InvitationAgendaItem[];
  decisions: InvitationDecision[];
  labels: { assemblyInvitationIntro: string; assemblyLegal: string };
  /** The tenant's IANA zone: an invitation prints the local time, never the server's. */
  timeZone: string;
  locale: 'mk';
  createdAt: Date;
}

const L = {
  mk: {
    title: 'Покана за собир на сопственици', from: 'Од', date: 'Датум на поканата', building: 'Зграда',
    when: 'Датум и час', place: 'Место', agenda: 'Дневен ред', decisions: 'Предлог-одлуки за гласање',
    companyNumber: 'ЕМБС', vatNumber: 'ЕДБ',
  },
} as const;

const e = escapeHtml;
/** Shared with the minutes and with the plain-text body of the invitation email. */
export const formatAssemblyDate = (x: Date | string, timeZone: string): string =>
  new Date(x).toLocaleDateString('mk-MK', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' });
export const formatAssemblyDateTime = (x: Date | string, timeZone: string): string =>
  new Date(x).toLocaleString('mk-MK', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Art. 37: one notice per assembly, not one per owner (plan addendum 10). */
export function renderAssemblyInvitationHtml({ tenant, building, scheduledAt, location, agenda, decisions, labels, timeZone, locale, createdAt }: AssemblyInvitationHtmlData): string {
  const t = L[locale];
  const agendaHtml = agenda.map((x) => `<li><strong>${e(x.title)}</strong>${x.text ? `<div class="muted">${e(x.text)}</div>` : ''}</li>`).join('');
  const decisionsHtml = decisions.map((d) => `<li><strong>${e(d.title)}</strong>${d.text ? `<div class="muted">${e(d.text)}</div>` : ''}</li>`).join('');
  return `<!doctype html><html lang="mk"><head><meta charset="utf-8"><title>${e(t.title)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:0}
h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:16px 0 4px}.muted{color:#555}
.row{display:flex;justify-content:space-between;gap:24px;margin-bottom:16px}.box{flex:1}
ol{margin:4px 0 0 18px;padding:0}li{margin-bottom:6px}
.legal{margin-top:16px;padding:8px;background:#fafafa;border-left:3px solid #999}
.when{margin-top:8px;padding:8px;background:#f3f3f3}
</style></head><body>
<div class="row"><div class="box"><h1>${e(t.title)}</h1><div><strong>${e(t.date)}:</strong> ${e(formatAssemblyDate(createdAt, timeZone))}</div>
<div><strong>${e(t.building)}:</strong> ${e(building.name)}, ${e(building.address)}, ${e(building.postalCode)} ${e(building.city)}</div></div>
<div class="box"><div class="muted">${e(t.from)}</div><strong>${e(tenant.name)}</strong><br>${e(tenant.address ?? '')}<br>${tenant.companyNumber ? `${e(t.companyNumber)}: ${e(tenant.companyNumber)}<br>` : ''}${tenant.vatNumber ? `${e(t.vatNumber)}: ${e(tenant.vatNumber)}<br>` : ''}${e(tenant.phone ?? '')} ${e(tenant.email ?? '')}</div></div>
<div class="when"><strong>${e(t.when)}:</strong> ${e(formatAssemblyDateTime(scheduledAt, timeZone))}<br><strong>${e(t.place)}:</strong> ${e(location || '—')}</div>
<p>${e(labels.assemblyInvitationIntro)}</p>
<h2>${e(t.agenda)}</h2><ol>${agendaHtml}</ol>
${decisions.length ? `<h2>${e(t.decisions)}</h2><ol>${decisionsHtml}</ol>` : ''}
<div class="legal">${e(labels.assemblyLegal)}</div>
</body></html>`;
}
