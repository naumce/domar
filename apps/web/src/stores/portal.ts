import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/api/client';
import type { PortalLink, PortalMe } from '@/api/types';

const STORAGE_KEY = 'domar.portal.contactId';

/** Which of the owner's properties the pages are currently showing. localStorage may throw in private mode. */
function readStored(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export const usePortalStore = defineStore('portal', () => {
  const account = ref<PortalMe['account'] | null>(null);
  const links = ref<PortalLink[]>([]);
  const ready = ref(false);
  const selectedContactId = ref<string | null>(readStored());

  function select(contactId: string | null) {
    selectedContactId.value = contactId;
    try {
      if (contactId) localStorage.setItem(STORAGE_KEY, contactId);
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* private mode: the selection just does not survive a reload */ }
  }

  function apply(me: PortalMe) {
    account.value = me.account;
    links.value = me.links;
    ready.value = true;
    // A stored id from another account (or a link that was removed) must never be sent as ?contactId=.
    if (!links.value.some((l) => l.contactId === selectedContactId.value)) select(links.value[0]?.contactId ?? null);
  }

  const current = computed(() => links.value.find((l) => l.contactId === selectedContactId.value) ?? null);

  async function fetchMe() {
    try {
      apply(await api.get<PortalMe>('/api/portal/me'));
    } catch {
      account.value = null; links.value = []; ready.value = true;
    }
  }
  async function login(payload: { email: string; password: string }) { apply(await api.post<PortalMe>('/api/portal/login', payload)); }
  async function register(payload: { code: string; email: string; password: string }) { apply(await api.post<PortalMe>('/api/portal/register', payload)); }
  async function addCode(code: string) { await api.post<PortalLink>('/api/portal/link', { code }); await fetchMe(); }
  async function changePassword(payload: { currentPassword: string; newPassword: string }) { await api.post('/api/portal/change-password', payload); }
  async function logout() {
    await api.post('/api/portal/logout');
    account.value = null; links.value = []; select(null);
  }

  return { account, links, ready, selectedContactId, current, select, fetchMe, login, register, addCode, changePassword, logout };
});
