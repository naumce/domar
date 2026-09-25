import type { MaintenanceStatus, NotificationKind } from '@domar/domain';

/**
 * Macedonian, server-rendered at write time, stored on the row — like `reminders.document_html`
 * (plan addendum 7). Not on the country pack: the pack holds the wording of Law 160/2025, while
 * these strings embed domar's own routes. `title` is what a phone may see, so it never carries an
 * amount; the amount, when there is one, goes into `body` (spec §11).
 */
export type NotificationInput =
  | { kind: 'invoice_published'; buildingName: string; period: string; amount: string; invoiceId: string }
  | { kind: 'reminder_created'; buildingName: string; amount: string }
  | { kind: 'assembly_invited'; buildingName: string; scheduledOn: string; assemblyId: string }
  | { kind: 'assembly_voting_opened'; buildingName: string; decisionTitle: string; assemblyId: string }
  | { kind: 'maintenance_status'; requestTitle: string; status: MaintenanceStatus; requestId: string }
  | { kind: 'maintenance_request_created'; requestTitle: string; buildingName: string; buildingId: string }
  | { kind: 'delivery_failed'; what: string; notificationId: string };

export const MAINTENANCE_STATUS_LABELS: Readonly<Record<MaintenanceStatus, string>> = {
  new: 'Ново', triaged: 'Прегледано', assigned: 'Доделено',
  in_progress: 'Во тек', done: 'Завршено', rejected: 'Одбиено',
};

export interface NotificationText { kind: NotificationKind; title: string; body: string; link: string }

export function notificationText(input: NotificationInput): NotificationText {
  switch (input.kind) {
    case 'invoice_published':
      return {
        kind: input.kind,
        title: `Нова фактура · ${input.buildingName}`,
        body: `Пресметка за ${input.period}. Вкупно за плаќање: ${input.amount}.`,
        link: `/portal/invoices/${input.invoiceId}`,
      };
    case 'reminder_created':
      return {
        kind: input.kind,
        title: `Опомена за неплатен долг · ${input.buildingName}`,
        body: `Вкупен долг по опомената: ${input.amount}.`,
        link: '/portal/invoices',
      };
    case 'assembly_invited':
      return {
        kind: input.kind,
        title: `Покана за собир · ${input.buildingName}`,
        body: `Собирот е закажан за ${input.scheduledOn}. Отворете ја поканата за дневниот ред.`,
        link: `/portal/assemblies/${input.assemblyId}`,
      };
    case 'assembly_voting_opened':
      return {
        kind: input.kind,
        title: `Ново гласање · ${input.buildingName}`,
        body: `На дневниот ред е додадена нова предлог-одлука: ${input.decisionTitle}.`,
        link: `/portal/assemblies/${input.assemblyId}`,
      };
    case 'maintenance_status':
      return {
        kind: input.kind,
        title: `Одржување: ${MAINTENANCE_STATUS_LABELS[input.status]}`,
        body: input.requestTitle,
        link: `/portal/maintenance/${input.requestId}`,
      };
    case 'maintenance_request_created':
      return {
        kind: input.kind,
        title: `Ново барање за одржување · ${input.buildingName}`,
        body: input.requestTitle,
        link: `/app/buildings/${input.buildingId}?tab=maintenance`,
      };
    case 'delivery_failed':
      return {
        kind: input.kind,
        title: 'Известувањето не беше испорачано',
        body: `Не успеа испораката на: ${input.what}. Проверете ги поставките за е-пошта.`,
        link: '/app/settings',
      };
  }
}
