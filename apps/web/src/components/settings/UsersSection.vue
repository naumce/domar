<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { CreatedUser, User } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';

const { t } = useI18n();
const roles = ['owner', 'accountant', 'technician', 'readonly'] as const;
const rows = ref<User[]>([]);
const open = ref(false); const busy = ref(false); const error = ref(''); const copied = ref(false);
const temp = ref<{ email: string; password: string } | null>(null);
const form = ref({ email: '', firstName: '', lastName: '', role: 'accountant' as (typeof roles)[number] });

async function load() { rows.value = (await api.get<{ rows: User[] }>('/api/users')).rows; }
onMounted(async () => { try { await load(); } catch { error.value = t('app.error'); } });

function fail(e: unknown) {
  const code = (e as { code?: string }).code;
  error.value = code === 'email_taken' ? t('users.errors.email_taken')
    : code === 'last_owner' ? t('users.errors.last_owner')
    : code === 'forbidden' ? t('users.errors.forbidden')
    : code === 'validation' ? t('auth.errors.validation')
    : t('app.error');
}

async function create() {
  busy.value = true; error.value = ''; copied.value = false;
  try {
    const res = await api.post<CreatedUser>('/api/users', { email: form.value.email, firstName: form.value.firstName, lastName: form.value.lastName, role: form.value.role });
    temp.value = { email: res.user.email, password: res.temporaryPassword };
    open.value = false;
    form.value = { email: '', firstName: '', lastName: '', role: 'accountant' };
    await load();
  } catch (e) { fail(e); } finally { busy.value = false; }
}

async function toggle(u: User) {
  error.value = '';
  try { await api.patch(`/api/users/${u.id}`, { isActive: !u.isActive }); await load(); } catch (e) { fail(e); }
}

async function reset(u: User) {
  error.value = ''; copied.value = false;
  try {
    const res = await api.post<CreatedUser>(`/api/users/${u.id}/reset-password`, {});
    temp.value = { email: res.user.email, password: res.temporaryPassword };
  } catch (e) { fail(e); }
}

async function copy() {
  if (!temp.value) return;
  try { await navigator.clipboard?.writeText(temp.value.password); copied.value = true; } catch { copied.value = false; }
}
</script>
<template>
  <section class="mt-8 max-w-3xl">
    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-lg font-semibold">{{ t('users.title') }}</h2>
      <AppButton data-test="users-add" @click="open = true">{{ t('users.add') }}</AppButton>
    </div>
    <p v-if="error" class="mb-2 text-sm text-red-600" data-test="users-error">{{ error }}</p>
    <div v-if="temp" class="mb-3 rounded-xl bg-emerald-50 p-4 text-sm">
      <div class="font-medium">{{ t('users.tempPassword') }} — {{ temp.email }}</div>
      <code class="mt-1 block text-lg font-semibold tracking-wider" data-test="temp-password">{{ temp.password }}</code>
      <div class="mt-1 text-slate-600">{{ t('users.tempPasswordHint') }}</div>
      <AppButton variant="secondary" class="mt-2" data-test="temp-copy" @click="copy">{{ t('users.copy') }}</AppButton>
      <span v-if="copied" class="ml-2 text-emerald-700" data-test="temp-copied">{{ t('users.copied') }}</span>
    </div>
    <DataTable :columns="[{ key: 'name', label: t('auth.firstName') }, { key: 'email', label: t('auth.email') }, { key: 'role', label: t('users.role') }, { key: 'isActive', label: t('users.active') }]" :rows="rows">
      <template #cell-name="{ row }">{{ row.firstName }} {{ row.lastName }}</template>
      <template #cell-role="{ row }">{{ t(`users.roles.${row.role}`) }}</template>
      <template #cell-isActive="{ row }">{{ row.isActive ? t('users.active') : t('users.inactive') }}</template>
      <template #actions="{ row }">
        <AppButton variant="secondary" data-test="user-toggle" @click="toggle(row)">{{ row.isActive ? t('users.deactivate') : t('users.activate') }}</AppButton>
        <AppButton variant="secondary" class="ml-2" data-test="user-reset" @click="reset(row)">{{ t('users.resetPassword') }}</AppButton>
      </template>
    </DataTable>
    <ModalDialog :open="open" :title="t('users.add')" @close="open = false">
      <form class="space-y-3" @submit.prevent="create">
        <AppInput v-model="form.email" :label="t('auth.email')" type="email" data-test="user-email" />
        <AppInput v-model="form.firstName" :label="t('auth.firstName')" data-test="user-firstName" />
        <AppInput v-model="form.lastName" :label="t('auth.lastName')" data-test="user-lastName" />
        <label class="block text-sm">
          <span class="mb-1 block font-medium text-slate-700">{{ t('users.role') }}</span>
          <select v-model="form.role" data-test="user-role" class="w-full rounded-md border border-slate-300 bg-white px-3 py-2">
            <option v-for="r in roles" :key="r" :value="r">{{ t(`users.roles.${r}`) }}</option>
          </select>
        </label>
        <div class="flex justify-end"><AppButton :loading="busy" data-test="user-submit" @click="create">{{ t('app.create') }}</AppButton></div>
      </form>
    </ModalDialog>
  </section>
</template>
