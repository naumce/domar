import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { User } from '@/api/types';
import { i18n } from '@/i18n';
import BuildingDetailPage from '@/pages/BuildingDetailPage.vue';
import { useAuthStore } from '@/stores/auth';

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const building = { id: 'b1', name: 'Зграда 1', address: 'ул. 1', city: 'Скопје', reserveFundAccount: null, operatingAccount: null };

async function mountAs(role: User['role'], query = '') {
  setActivePinia(createPinia());
  useAuthStore().user = { id: 'me', email: 'me@f.mk', firstName: 'И', lastName: 'Т', role, isActive: true };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url.includes('/api/buildings/b1') && !url.includes('/units') ? building : { rows: [] })));
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }] });
  await router.push(`/app/buildings/b1${query}`);
  const w = mount(BuildingDetailPage, { props: { id: 'b1' }, shallow: true, global: { plugins: [i18n, router] } });
  await flushPromises();
  return w;
}
const tabs = (w: Awaited<ReturnType<typeof mountAs>>) =>
  w.findAll('[data-test^=tab-]').map((b) => b.attributes('data-test')!.replace('tab-', ''));

afterEach(() => vi.unstubAllGlobals());

describe('building tabs by role', () => {
  it('draws every tab for an owner', async () => {
    expect(tabs(await mountAs('owner'))).toContain('documents');
    expect(tabs(await mountAs('owner'))).toHaveLength(15);
  });

  // The technician's role is refused by the documents, contracts and extraordinary reads, so those
  // tabs are not drawn: a tab that answers 403 is worse than no tab.
  it('draws only compliance, units and maintenance for a technician', async () => {
    expect(tabs(await mountAs('technician'))).toEqual(['compliance', 'units', 'maintenance']);
  });

  it('sends a technician deep-linking a hidden tab back to compliance', async () => {
    const w = await mountAs('technician', '?tab=documents');
    expect(w.findComponent({ name: 'ComplianceTab' }).exists()).toBe(true);
    expect(w.findComponent({ name: 'DocumentsTab' }).exists()).toBe(false);
  });
});
