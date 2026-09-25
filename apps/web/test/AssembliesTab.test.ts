import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Assembly, AssemblyDecision, AssemblyOwners } from '@/api/types';
import AssemblyPanel from '@/components/assembly/AssemblyPanel.vue';
import AssembliesTab from '@/components/building/AssembliesTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, code: string, details?: unknown) =>
  new Response(JSON.stringify({ error: { code, message: code, ...(details !== undefined ? { details } : {}) } }), { status, headers: { 'content-type': 'application/json' } });

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';

const decision = (id: string, title: string, over: Partial<AssemblyDecision> = {}): AssemblyDecision => ({
  id, title, text: null, sortOrder: 0, forWeight: 0, againstWeight: 0, abstainWeight: 0,
  presentWeight: 0, basisTotal: 0, quorumReached: false, result: 'pending', ...over,
});
const assembly = (over: Partial<Assembly> = {}): Assembly => ({
  id: 'a1', buildingId: 'b1', scheduledAt: '2026-10-15T17:00:00.000Z', location: 'Влез А',
  agenda: [{ id: 'g1', title: 'Годишен извештај', text: '' }], status: 'draft', quorumBasis: 'share',
  invitedAt: null, heldAt: null, cancelledAt: null, cancelReason: null, lateInvitation: false, lateReason: null,
  minutesDocumentId: null, decisionCount: 1, invitationCount: 0,
  createdAt: '2026-09-25T09:00:00.000Z', updatedAt: '2026-09-25T09:00:00.000Z',
  decisions: [decision('d1', 'Усвојување')], invitations: [], attendance: [], votes: [], ...over,
});
const owners: AssemblyOwners = {
  rows: [{ contactId: C1, contactName: 'Ана Анастасова', email: 'ana@example.mk', weightBp: 5000 },
    { contactId: C2, contactName: 'Богдан Богданов', email: null, weightBp: 5000 }],
  basisTotal: 10000, quorumBasis: 'share',
};

describe('AssembliesTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates an assembly with its date, place, agenda and decisions', async () => {
    const created = assembly();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [] }))                                    // initial list
      .mockResolvedValueOnce(json(created))                                         // POST create
      .mockResolvedValueOnce(json({ rows: [created] }))                             // list again
      .mockResolvedValueOnce(json(created))                                         // GET detail
      .mockResolvedValueOnce(json(owners));                                         // GET owners
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(AssembliesTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.find('[data-test=assembly-create]').exists()).toBe(true));

    await w.get('[data-test=assembly-scheduled]').setValue('2026-10-15T19:00');
    await w.get('[data-test=assembly-location]').setValue('Влез А');
    await w.get('[data-test=assembly-quorum]').setValue('share');
    await w.findAll('[data-test=assembly-agenda-title]')[0]!.setValue('Годишен извештај');
    await w.get('[data-test=assembly-decision-add]').trigger('click');
    const decisions = w.findAll('[data-test=assembly-decision-title]');
    await decisions[0]!.setValue('Усвојување');
    await decisions[1]!.setValue('Нова фасада');
    await w.get('[data-test=assembly-create]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    const call = fetchMock.mock.calls[1]!;
    expect(String(call[0])).toBe('http://localhost:3001/api/buildings/b1/assemblies');
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      scheduledAt: new Date('2026-10-15T19:00').toISOString(),
      location: 'Влез А',
      quorumBasis: 'share',
      agenda: [{ title: 'Годишен извештај', text: '' }],
      decisions: [{ title: 'Усвојување' }, { title: 'Нова фасада' }],
    });
    expect(String(fetchMock.mock.calls[4]![0])).toBe('http://localhost:3001/api/assemblies/a1/owners');
  });

  it('edits a draft assembly, sending a PATCH with only the changed field', async () => {
    const original = assembly();
    const patched = assembly({ location: 'Влез Б' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [original] }))    // initial list
      .mockResolvedValueOnce(json(patched))                 // PATCH
      .mockResolvedValueOnce(json({ rows: [patched] }));    // list again
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(AssembliesTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.find('[data-test=assembly-edit]').exists()).toBe(true));

    await w.get('[data-test=assembly-edit]').trigger('click');
    expect((w.get('[data-test=assembly-location]').element as HTMLInputElement).value).toBe('Влез А');
    await w.get('[data-test=assembly-location]').setValue('Влез Б');
    await w.get('[data-test=assembly-create]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await flushPromises();

    const call = fetchMock.mock.calls[1]!;
    expect(String(call[0])).toBe('http://localhost:3001/api/assemblies/a1');
    expect((call[1] as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ location: 'Влез Б' });
  });
});

describe('AssemblyPanel', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for a reason when the invitation is late and retries it with the override', async () => {
    const draft = assembly();
    const invited = assembly({ status: 'invited', lateInvitation: true, lateReason: 'Итен дефект', invitedAt: '2026-10-05T09:00:00.000Z' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fail(409, 'invitation_too_late', { days: 9, minDays: 15 }))
      .mockResolvedValueOnce(json(invited));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(AssemblyPanel, { props: { assembly: draft, owners, ownersError: '' }, global: { plugins: [i18n] } });

    expect(w.find('[data-test=assembly-late]').exists()).toBe(false);
    await w.get('[data-test=assembly-invite]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=assembly-late]').exists()).toBe(true));
    expect(w.get('[data-test=assembly-late]').text()).toContain('9');

    await w.get('[data-test=assembly-late-reason]').setValue('Итен дефект');
    await w.get('[data-test=assembly-late-confirm]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await flushPromises();

    const retry = fetchMock.mock.calls[1]!;
    expect(String(retry[0])).toBe('http://localhost:3001/api/assemblies/a1/invite');
    expect(JSON.parse(String((retry[1] as RequestInit).body))).toEqual({ override: { reason: 'Итен дефект' } });
    expect(w.emitted('changed')![0]![0]).toMatchObject({ status: 'invited', lateInvitation: true });
  });

  it('holds the assembly with the attendance sheet it was given', async () => {
    const invited = assembly({
      status: 'invited', invitedAt: '2026-09-25T10:00:00.000Z',
      invitations: [
        { id: 'i1', contactId: C1, contactName: 'Ана Анастасова', email: 'ana@example.mk', channel: 'email', status: 'sent', sentAt: '2026-09-25T10:00:00.000Z', error: null },
        { id: 'i2', contactId: C2, contactName: 'Богдан Богданов', email: null, channel: 'letter', status: 'pending', sentAt: null, error: null },
      ],
      votes: [{ decisionId: 'd1', contactId: C1, choice: 'for', via: 'portal', castAt: '2026-10-01T08:00:00.000Z' }],
    });
    const held = assembly({
      status: 'held', heldAt: '2026-10-15T17:00:00.000Z', minutesDocumentId: 'doc-1',
      decisions: [decision('d1', 'Усвојување', { forWeight: 5000, presentWeight: 10000, basisTotal: 10000, quorumReached: true, result: 'passed' })],
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(json(held));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(AssemblyPanel, { props: { assembly: invited, owners, ownersError: '' }, global: { plugins: [i18n] } });

    expect(w.findAll('[data-test=invitation-row]')).toHaveLength(2);
    expect(w.findAll('[data-test=attendance-row]')).toHaveLength(2);
    await w.get(`[data-test=attendance-present-${C1}]`).setValue(true);
    await w.get(`[data-test=attendance-present-${C2}]`).setValue(true);
    await w.get(`[data-test=attendance-proxy-${C2}]`).setValue('Ана Анастасова');
    await w.get('[data-test=assembly-held-at]').setValue('2026-10-15T19:00');
    await w.get('[data-test=assembly-hold]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushPromises();

    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe('http://localhost:3001/api/assemblies/a1/hold');
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      heldAt: new Date('2026-10-15T19:00').toISOString(),
      attendance: [
        { contactId: C1, present: true, proxyName: null },
        { contactId: C2, present: true, proxyName: 'Ана Анастасова' },
      ],
    });
    expect(w.emitted('changed')![0]![0]).toMatchObject({ status: 'held', minutesDocumentId: 'doc-1' });
  });

  it('leaves a blank held-at at the scheduled moment once that moment has passed', async () => {
    const invited = assembly({ status: 'invited', invitedAt: '2026-10-10T10:00:00.000Z' });
    const fetchMock = vi.fn().mockResolvedValue(json(assembly({ status: 'held', heldAt: '2026-10-15T17:00:00.000Z' })));
    vi.stubGlobal('fetch', fetchMock);
    // Minutes typed three weeks after a meeting held on its scheduled day: the hold is dated to the
    // day the owners were called to, not to the day the manager got round to the paperwork.
    vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
    const w = mount(AssemblyPanel, { props: { assembly: invited, owners, ownersError: '' }, global: { plugins: [i18n] } });
    await w.get('[data-test=assembly-hold]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushPromises();
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).heldAt).toBe('2026-10-15T17:00:00.000Z');

    // An assembly closed before its scheduled hour is dated to the click, the earlier of the two.
    vi.setSystemTime(new Date('2026-10-15T15:30:00.000Z'));
    const early = mount(AssemblyPanel, { props: { assembly: invited, owners, ownersError: '' }, global: { plugins: [i18n] } });
    await early.get('[data-test=assembly-hold]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await flushPromises();
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)).heldAt).toBe('2026-10-15T15:30:00.000Z');
    vi.useRealTimers();
  });

  it('shows the tally and the minutes link once the assembly is held', async () => {
    const held = assembly({
      status: 'held', heldAt: '2026-10-15T17:00:00.000Z', minutesDocumentId: 'doc-1',
      decisions: [decision('d1', 'Усвојување', { forWeight: 5000, againstWeight: 3000, presentWeight: 8000, basisTotal: 10000, quorumReached: true, result: 'passed' })],
    });
    vi.stubGlobal('fetch', vi.fn());
    const w = mount(AssemblyPanel, { props: { assembly: held, owners, ownersError: '' }, global: { plugins: [i18n] } });
    expect(w.get('[data-test=decision-result]').text()).toBe('Усвоена');
    expect(w.get('[data-test=assembly-quorum-line]').text()).toContain('8000');
    expect(w.get('[data-test=assembly-quorum-line]').text()).toContain('10000');
    expect(w.get('[data-test=assembly-minutes]').attributes('href')).toBe('http://localhost:3001/api/documents/doc-1/download');
    expect(w.find('[data-test=assembly-hold]').exists()).toBe(false);
    expect(w.find('[data-test=assembly-invite]').exists()).toBe(false);
  });
});
