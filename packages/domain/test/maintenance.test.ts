import { describe, expect, it } from 'vitest';
import { mkPack } from '../src/country/mk.js';
import {
  ALLOWED_TRANSITIONS, MAINTENANCE_CAPABILITIES, MAINTENANCE_CATEGORIES, MAINTENANCE_PRIORITIES, MAINTENANCE_STATUSES,
  TERMINAL_STATUSES, can, canTransition, isTerminal, nextStatus, nextStatuses,
  type MaintenanceRole, type MaintenanceStatus,
} from '../src/maintenance/status.js';

describe('the maintenance status graph', () => {
  it('lists the six statuses in the order the board draws them', () => {
    expect(MAINTENANCE_STATUSES).toEqual(['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected']);
    expect(MAINTENANCE_PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent']);
  });

  it('is exactly the graph the plan fixed — every edge, and no other', () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      new: ['triaged', 'assigned', 'rejected'],
      triaged: ['assigned', 'rejected'],
      assigned: ['in_progress', 'done'],
      in_progress: ['done'],
      done: [],
      rejected: [],
    });
  });

  it('allows the happy path and refuses every step backwards', () => {
    expect(canTransition('new', 'triaged')).toBe(true);
    expect(canTransition('triaged', 'assigned')).toBe(true);
    expect(canTransition('assigned', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'done')).toBe(true);
    // A request fixed on the spot closes straight from `assigned`.
    expect(canTransition('assigned', 'done')).toBe(true);
    expect(canTransition('triaged', 'in_progress')).toBe(false);
    expect(canTransition('new', 'done')).toBe(false);
    expect(canTransition('in_progress', 'assigned')).toBe(false);
    expect(canTransition('done', 'in_progress')).toBe(false);
    expect(canTransition('rejected', 'triaged')).toBe(false);
    expect(canTransition('new', 'new')).toBe(false);
  });

  it('rejects only from new and triaged', () => {
    expect(canTransition('new', 'rejected')).toBe(true);
    expect(canTransition('triaged', 'rejected')).toBe(true);
    expect(canTransition('assigned', 'rejected')).toBe(false);
    expect(canTransition('in_progress', 'rejected')).toBe(false);
  });

  it('knows its terminal states, and they are dead ends', () => {
    expect(TERMINAL_STATUSES).toEqual(['done', 'rejected']);
    for (const s of TERMINAL_STATUSES) {
      expect(isTerminal(s)).toBe(true);
      expect(nextStatuses(s)).toEqual([]);
      for (const to of MAINTENANCE_STATUSES) expect(canTransition(s, to), `${s} → ${to}`).toBe(false);
    }
    expect(isTerminal('in_progress')).toBe(false);
  });

  it('nextStatus returns the target when it is legal and null when it is not', () => {
    expect(nextStatus('assigned', 'in_progress')).toBe('in_progress');
    expect(nextStatus('assigned', 'triaged')).toBeNull();
    expect(nextStatus('done', 'done')).toBeNull();
  });

  it('never leaves a status unreachable or a non-terminal status without an exit', () => {
    const reachable = new Set<MaintenanceStatus>(['new']);
    for (const from of MAINTENANCE_STATUSES) for (const to of nextStatuses(from)) reachable.add(to);
    expect([...reachable].sort()).toEqual([...MAINTENANCE_STATUSES].sort());
    for (const s of MAINTENANCE_STATUSES) {
      expect(nextStatuses(s).length > 0, s).toBe(!TERMINAL_STATUSES.includes(s));
    }
  });
});

describe('the maintenance capability matrix', () => {
  it('is the exact table the API gates on', () => {
    expect(MAINTENANCE_CAPABILITIES).toEqual({
      owner: ['create', 'triage', 'reject', 'assign', 'progress', 'close', 'close_with_cost', 'comment', 'photo'],
      accountant: ['create', 'triage', 'reject', 'assign', 'progress', 'close', 'close_with_cost', 'comment', 'photo'],
      technician: ['progress', 'close', 'comment', 'photo'],
      readonly: [],
    });
  });

  it('lets a technician work a request but never book its cost', () => {
    expect(can('technician', 'progress')).toBe(true);
    expect(can('technician', 'close')).toBe(true);
    expect(can('technician', 'comment')).toBe(true);
    expect(can('technician', 'photo')).toBe(true);
    expect(can('technician', 'close_with_cost')).toBe(false);
    expect(can('technician', 'assign')).toBe(false);
    expect(can('technician', 'create')).toBe(false);
    expect(can('technician', 'triage')).toBe(false);
    expect(can('technician', 'reject')).toBe(false);
  });

  it('gives readonly nothing at all and the two write roles everything', () => {
    const everything = MAINTENANCE_CAPABILITIES.owner;
    expect(MAINTENANCE_CAPABILITIES.accountant).toEqual(everything);
    for (const c of everything) expect(can('readonly', c), c).toBe(false);
    for (const role of ['owner', 'accountant'] as MaintenanceRole[]) {
      for (const c of everything) expect(can(role, c), `${role}/${c}`).toBe(true);
    }
  });
});

describe('the country pack carries the categories', () => {
  it('labels every category of the enum, in the picker order, in Macedonian', () => {
    expect(MAINTENANCE_CATEGORIES).toEqual(['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other']);
    expect(mkPack.maintenanceCategories).toEqual([
      { key: 'plumbing', label: 'Водовод и канализација' },
      { key: 'electrical', label: 'Електрика' },
      { key: 'lift', label: 'Лифт' },
      { key: 'heating', label: 'Греење' },
      { key: 'cleaning', label: 'Чистење' },
      { key: 'common_area', label: 'Заеднички простории' },
      { key: 'other', label: 'Друго' },
    ]);
  });

  it('labels the expense a closed request books, so the fund page reads as Macedonian', () => {
    const label = mkPack.maintenanceCategories.find((c) => c.key === 'plumbing')!.label;
    expect(`${mkPack.labels.maintenanceExpense}: ${label} — Протекува цевка во визбата`)
      .toBe('Одржување: Водовод и канализација — Протекува цевка во визбата');
  });
});
