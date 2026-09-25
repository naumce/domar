import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import PortalAssembliesPage from '@/pages/portal/PortalAssembliesPage.vue';
import PortalAssemblyPage from '@/pages/portal/PortalAssemblyPage.vue';
import { usePortalStore } from '@/stores/portal';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const me = {
  account: { id: 'a1', email: 'marko@owner.mk' },
  links: [{ tenantId: 't1', tenantName: 'Фирма 1', contactId: 'c1', contactName: 'Марко Марков', buildings: [{ id: 'b1', name: 'Партизанска 12' }] }],
};
const row = {
  id: 'as1', buildingId: 'b1', buildingName: 'Партизанска 12', scheduledAt: '2026-10-15T17:00:00.000Z',
  location: 'Влез А', status: 'invited', heldAt: null, minutesDocumentId: null, agendaCount: 1,
};
const open = {
  ...row, agendaCount: undefined, agenda: [{ id: 'g1', title: 'Годишен извештај', text: '' }], votingOpen: true,
  decisions: [{ id: 'd1', title: 'Усвојување', text: null, myChoice: null, forWeight: null, againstWeight: null, abstainWeight: null, presentWeight: null, basisTotal: null, quorumReached: null, result: null }],
};
const voted = { ...open, decisions: [{ ...open.decisions[0], myChoice: 'for' }] };
const closed = {
  ...open, status: 'held', heldAt: '2026-10-15T17:00:00.000Z', minutesDocumentId: 'doc-1', votingOpen: false,
  decisions: [{ ...open.decisions[0], myChoice: 'for', forWeight: 5000, againstWeight: 3000, abstainWeight: 0, presentWeight: 8000, basisTotal: 10000, quorumReached: true, result: 'passed' }],
};

async function primedStore(fetchMock: ReturnType<typeof vi.fn>) {
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', fetchMock);
  const store = usePortalStore();
  await store.fetchMe();
  return store;
}

describe('PortalAssembliesPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the assemblies of the selected property', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json({ rows: [row] }));
    await primedStore(fetchMock);
    const w = mount(PortalAssembliesPage, { global: { plugins: [i18n], stubs: { RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] } } } });
    await flushPromises();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/assemblies?contactId=c1');
    expect(w.findAll('[data-test=portal-assembly-row]')).toHaveLength(1);
    expect(w.get('[data-test=portal-assembly-status]').text()).toBe('Свикан');
    expect(w.get('[data-test=portal-assembly-link]').attributes('href')).toBe('/portal/assemblies/as1');
  });
});

describe('PortalAssemblyPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('casts a vote for the linked contact and shows the choice back', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(me))
      .mockResolvedValueOnce(json(open))
      .mockResolvedValueOnce(json(voted));
    await primedStore(fetchMock);
    const w = mount(PortalAssemblyPage, { props: { id: 'as1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await flushPromises();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/assemblies/as1?contactId=c1');
    expect(w.get('[data-test=portal-assembly-agenda]').text()).toContain('Годишен извештај');
    expect(w.get('[data-test=portal-assembly-invitation]').attributes('href')).toBe('http://localhost:3001/api/portal/assemblies/as1/invitation/pdf?contactId=c1');
    expect(w.find('[data-test=portal-assembly-result]').exists()).toBe(false);

    await w.get('[data-test=portal-vote-for]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const call = fetchMock.mock.calls[2]!;
    expect(String(call[0])).toBe('http://localhost:3001/api/portal/assemblies/as1/decisions/d1/vote');
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ contactId: 'c1', choice: 'for' });
    await vi.waitFor(() => expect(w.get('[data-test=portal-assembly-mychoice]').text()).toContain('За'));
  });

  it('shows the result and the minutes once the assembly is held, and no vote buttons', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(closed));
    await primedStore(fetchMock);
    const w = mount(PortalAssemblyPage, { props: { id: 'as1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await flushPromises();
    await vi.waitFor(() => expect(w.find('[data-test=portal-assembly-result]').exists()).toBe(true));
    expect(w.get('[data-test=portal-assembly-result]').text()).toContain('Усвоена');
    expect(w.get('[data-test=portal-assembly-result]').text()).toContain('5000');
    expect(w.get('[data-test=portal-assembly-minutes]').attributes('href')).toBe('http://localhost:3001/api/portal/documents/doc-1/download?contactId=c1');
    expect(w.find('[data-test=portal-vote-for]').exists()).toBe(false);
    expect(w.get('[data-test=portal-assembly-closed]').text()).toBe('Гласањето е затворено.');
  });
});
