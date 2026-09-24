import { describe, expect, it } from 'vitest';
import { evaluateBuildingCompliance, type ComplianceSnapshot, type ComplianceDutyKey, type ComplianceStatus } from '../src/compliance/evaluate.js';
import { mkPack } from '../src/country/mk.js';

const RULES = mkPack.complianceRules;
const TODAY = new Date('2026-09-24T00:00:00.000Z');

/** A building that satisfies nothing: every duty is reached by overriding one field. */
const base: ComplianceSnapshot = {
  buildingCreatedAt: '2026-09-01T00:00:00.000Z',
  lastPublishedPeriodAt: null,
  ownersOverThreshold: 0,
  oldestThresholdSince: null,
  lastReminderAt: null,
  assemblyCount: 0,
  lastAssemblyHeldAt: null,
  lastAssemblyInvitedAt: null,
  lastAnnualReportAt: null,
  portalLinkedOwners: 0,
  fundStatementAvailableAt: null,
  regularFundAccount: null,
  reserveFundAccount: null,
  managementContractEndsOn: null,
  lastHandoverReportAt: null,
  extraordinaryCostCount: 0,
};
const statusOf = (s: Partial<ComplianceSnapshot>, key: ComplianceDutyKey): ComplianceStatus =>
  evaluateBuildingCompliance({ ...base, ...s }, TODAY, RULES).duties.find((d) => d.key === key)!.status;
const dutyOf = (s: Partial<ComplianceSnapshot>, key: ComplianceDutyKey) =>
  evaluateBuildingCompliance({ ...base, ...s }, TODAY, RULES).duties.find((d) => d.key === key)!;

describe('evaluateBuildingCompliance — shape', () => {
  it('returns the eight duties in a fixed order, each with its article and deep link', () => {
    const r = evaluateBuildingCompliance(base, TODAY, RULES);
    expect(r.duties.map((d) => d.key)).toEqual([
      'invoices', 'reminders', 'assembly', 'annual_report', 'fund_transparency', 'fund_accounts', 'handover', 'extraordinary_costs']);
    expect(r.duties.map((d) => d.article)).toEqual(['19/33', '28', '37', '31', '45(4)', '42/45', '30', '47(5)']);
    expect(r.duties.map((d) => d.howToFix)).toEqual([
      '?tab=periods', '?tab=reminders', '?tab=compliance', '?tab=compliance',
      '?tab=units', '?tab=compliance#fund-accounts', '?tab=contracts', '?tab=extraordinary']);
  });

  it('summarises a fresh building as overdue because the fund accounts are empty', () => {
    const r = evaluateBuildingCompliance(base, TODAY, RULES);
    expect(r.status).toBe('overdue');
    expect(r.counts).toEqual({ ok: 2, due: 1, overdue: 1, na: 4 });
  });

  it('is ok only when nothing is due and nothing is overdue', () => {
    const r = evaluateBuildingCompliance({
      ...base, lastPublishedPeriodAt: '2026-09-20T00:00:00.000Z',
      portalLinkedOwners: 1, fundStatementAvailableAt: '2026-09-02T10:00:00.000Z',
      regularFundAccount: '210-0000000000-19', reserveFundAccount: '210-0000000000-96',
    }, TODAY, RULES);
    expect(r.status).toBe('ok');
    expect(r.counts).toEqual({ ok: 4, due: 0, overdue: 0, na: 4 });
  });
});

describe('Art. 19/33 — invoices', () => {
  it('is ok on the 35th day and due on the 36th', () => {
    expect(statusOf({ lastPublishedPeriodAt: '2026-08-20T00:00:00.000Z' }, 'invoices')).toBe('ok');
    expect(statusOf({ lastPublishedPeriodAt: '2026-08-19T00:00:00.000Z' }, 'invoices')).toBe('due');
  });
  it('is overdue once the 30-day grace after the deadline is gone', () => {
    // deadline 2026-09-18, grace ends 2026-10-18 → still due
    expect(statusOf({ lastPublishedPeriodAt: '2026-08-14T00:00:00.000Z' }, 'invoices')).toBe('due');
    // deadline 2026-08-19, grace ends 2026-09-18 → overdue on 2026-09-24
    expect(statusOf({ lastPublishedPeriodAt: '2026-07-15T00:00:00.000Z' }, 'invoices')).toBe('overdue');
  });
  it('falls back to the building creation date when nothing was ever published', () => {
    expect(statusOf({ buildingCreatedAt: '2026-08-20T00:00:00.000Z' }, 'invoices')).toBe('ok');
    expect(statusOf({ buildingCreatedAt: '2026-07-15T00:00:00.000Z' }, 'invoices')).toBe('overdue');
  });
  it('reports the deadline and the last evidence', () => {
    const d = dutyOf({ lastPublishedPeriodAt: '2026-09-20T00:00:00.000Z' }, 'invoices');
    expect(d.dueAt).toBe('2026-10-25T00:00:00.000Z');
    expect(d.lastEvidenceAt).toBe('2026-09-20T00:00:00.000Z');
  });
});

describe('Art. 28 — reminders', () => {
  it('is ok while no owner is over the threshold', () => {
    expect(statusOf({ ownersOverThreshold: 0, lastReminderAt: '2026-09-01T00:00:00.000Z' }, 'reminders')).toBe('ok');
  });
  it('is due for 30 days after the oldest owner crossed, then overdue', () => {
    expect(statusOf({ ownersOverThreshold: 2, oldestThresholdSince: '2026-08-25T00:00:00.000Z' }, 'reminders')).toBe('due');
    expect(statusOf({ ownersOverThreshold: 2, oldestThresholdSince: '2026-08-24T00:00:00.000Z' }, 'reminders')).toBe('overdue');
  });
  it('carries how many owners are waiting and when the reminder is owed', () => {
    const d = dutyOf({ ownersOverThreshold: 3, oldestThresholdSince: '2026-09-01T00:00:00.000Z', lastReminderAt: '2026-06-01T00:00:00.000Z' }, 'reminders');
    expect(d.count).toBe(3);
    expect(d.dueAt).toBe('2026-10-01T00:00:00.000Z');
    expect(d.lastEvidenceAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('Art. 37 — assembly', () => {
  it('is n/a until the building has had an assembly at all', () => {
    expect(statusOf({}, 'assembly')).toBe('n/a');
    expect(statusOf({ assemblyCount: 1, lastAssemblyHeldAt: null }, 'assembly')).toBe('due');
  });
  it('is ok exactly twelve months after the last one and due a day later', () => {
    expect(statusOf({ assemblyCount: 1, lastAssemblyHeldAt: '2025-09-24T00:00:00.000Z' }, 'assembly')).toBe('ok');
    expect(statusOf({ assemblyCount: 1, lastAssemblyHeldAt: '2025-09-23T00:00:00.000Z' }, 'assembly')).toBe('due');
    expect(statusOf({ assemblyCount: 1, lastAssemblyHeldAt: '2025-06-20T00:00:00.000Z' }, 'assembly')).toBe('overdue');
  });
  it('flags an invitation sent fewer than fifteen days before the assembly', () => {
    const ok = { assemblyCount: 1, lastAssemblyHeldAt: '2026-09-01T00:00:00.000Z', lastAssemblyInvitedAt: '2026-08-17T00:00:00.000Z' };
    expect(statusOf(ok, 'assembly')).toBe('ok');
    expect(statusOf({ ...ok, lastAssemblyInvitedAt: '2026-08-18T00:00:00.000Z' }, 'assembly')).toBe('due');
  });
});

describe('Art. 31 — annual report', () => {
  it('is n/a until the building is twelve months old', () => {
    expect(statusOf({ buildingCreatedAt: '2026-01-01T00:00:00.000Z' }, 'annual_report')).toBe('n/a');
    expect(statusOf({ buildingCreatedAt: '2025-09-24T00:00:00.000Z' }, 'annual_report')).toBe('n/a');
  });
  it('is due once it is older than twelve months with no report, then overdue after three more', () => {
    expect(statusOf({ buildingCreatedAt: '2025-09-01T00:00:00.000Z' }, 'annual_report')).toBe('due');
    expect(statusOf({ buildingCreatedAt: '2025-06-01T00:00:00.000Z' }, 'annual_report')).toBe('overdue');
  });
  it('restarts the twelve months from the last report', () => {
    expect(statusOf({ buildingCreatedAt: '2020-01-01T00:00:00.000Z', lastAnnualReportAt: '2026-03-01T00:00:00.000Z' }, 'annual_report')).toBe('ok');
    expect(statusOf({ buildingCreatedAt: '2020-01-01T00:00:00.000Z', lastAnnualReportAt: '2025-09-01T00:00:00.000Z' }, 'annual_report')).toBe('due');
    expect(statusOf({ buildingCreatedAt: '2020-01-01T00:00:00.000Z', lastAnnualReportAt: '2025-01-01T00:00:00.000Z' }, 'annual_report')).toBe('overdue');
  });
});

describe('Art. 45(4) — fund transparency', () => {
  it('needs both a linked owner and the statement event', () => {
    expect(statusOf({}, 'fund_transparency')).toBe('due');
    expect(statusOf({ portalLinkedOwners: 2 }, 'fund_transparency')).toBe('due');
    expect(statusOf({ fundStatementAvailableAt: '2026-09-02T10:00:00.000Z' }, 'fund_transparency')).toBe('due');
    expect(statusOf({ portalLinkedOwners: 2, fundStatementAvailableAt: '2026-09-02T10:00:00.000Z' }, 'fund_transparency')).toBe('ok');
  });
  it('is never overdue and reports how many owners are linked', () => {
    expect(dutyOf({ portalLinkedOwners: 2, fundStatementAvailableAt: '2026-09-02T10:00:00.000Z' }, 'fund_transparency').count).toBe(2);
  });
});

describe('Art. 42/45 — separate accounts', () => {
  it('is overdue while either account is missing or blank', () => {
    expect(statusOf({ regularFundAccount: '210-0000000000-19' }, 'fund_accounts')).toBe('overdue');
    expect(statusOf({ regularFundAccount: '210-0000000000-19', reserveFundAccount: '   ' }, 'fund_accounts')).toBe('overdue');
    expect(statusOf({ regularFundAccount: '210-0000000000-19', reserveFundAccount: '210-0000000000-96' }, 'fund_accounts')).toBe('ok');
  });
});

describe('Art. 30 — handover', () => {
  it('is n/a without a management contract end date', () => {
    expect(statusOf({}, 'handover')).toBe('n/a');
  });
  it('is ok before the contract ends, due for eight days after it, overdue beyond', () => {
    expect(statusOf({ managementContractEndsOn: '2026-10-01' }, 'handover')).toBe('ok');
    expect(statusOf({ managementContractEndsOn: '2026-09-24' }, 'handover')).toBe('due');
    expect(statusOf({ managementContractEndsOn: '2026-09-16' }, 'handover')).toBe('due');
    expect(statusOf({ managementContractEndsOn: '2026-09-15' }, 'handover')).toBe('overdue');
  });
  it('is ok again once a handover report was issued on or after the end date', () => {
    expect(statusOf({ managementContractEndsOn: '2026-09-15', lastHandoverReportAt: '2026-09-16T09:00:00.000Z' }, 'handover')).toBe('ok');
    // A report from before the contract ended is not a handover report for this contract.
    expect(statusOf({ managementContractEndsOn: '2026-09-15', lastHandoverReportAt: '2026-09-14T09:00:00.000Z' }, 'handover')).toBe('overdue');
  });
  it('reports the eight-day deadline', () => {
    expect(dutyOf({ managementContractEndsOn: '2026-10-01' }, 'handover').dueAt).toBe('2026-10-09T00:00:00.000Z');
  });
});

describe('Art. 47(5) — extraordinary costs', () => {
  it('is informational: always n/a, with the count', () => {
    const d = dutyOf({ extraordinaryCostCount: 3 }, 'extraordinary_costs');
    expect(d.status).toBe('n/a');
    expect(d.count).toBe(3);
  });
});

describe('mk pack compliance rules and labels', () => {
  it('encodes the thresholds the rules read', () => {
    expect(mkPack.complianceRules).toEqual({
      invoiceMaxAgeDays: 35, reminderGraceDays: 30, assemblyMaxAgeMonths: 12, assemblyInvitationMinDays: 15,
      annualReportMaxAgeMonths: 12, handoverDays: 8, graceDays: 30, graceMonths: 3,
    });
  });
  it('labels every duty in Macedonian', () => {
    const keys = evaluateBuildingCompliance(base, TODAY, RULES).duties.map((d) => d.key);
    for (const k of keys) {
      expect(mkPack.labels.compliance[k]!.title.length, k).toBeGreaterThan(3);
      expect(mkPack.labels.compliance[k]!.hint.length, k).toBeGreaterThan(10);
    }
    expect(mkPack.labels.compliance.fund_accounts!.title).toBe('Одвоени сметки за фондовите');
  });
});
