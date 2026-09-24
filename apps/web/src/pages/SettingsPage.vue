<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Tenant } from '@/api/types';
import ChangePasswordForm from '@/components/settings/ChangePasswordForm.vue';
import UsersSection from '@/components/settings/UsersSection.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const auth = useAuthStore();
const timezones = ['Europe/Skopje', 'Europe/Belgrade', 'Europe/Sofia', 'Europe/Tirana', 'Europe/Zagreb', 'Europe/Ljubljana', 'UTC'];
const loading = ref(true); const saving = ref(false); const error = ref(''); const saved = ref(false);
const form = ref({ name: '', timezone: '', companyNumber: '', vatNumber: '', address: '', phone: '', email: '', bankName: '', bankAccount: '' });
const emailConfigured = ref(false);

onMounted(async () => {
  try {
    const tenant = await api.get<Tenant>('/api/tenant');
    form.value = {
      name: tenant.name, timezone: tenant.timezone, companyNumber: tenant.companyNumber ?? '', vatNumber: tenant.vatNumber ?? '',
      address: tenant.address ?? '', phone: tenant.phone ?? '', email: tenant.email ?? '', bankName: tenant.bankName ?? '', bankAccount: tenant.bankAccount ?? '',
    };
    emailConfigured.value = tenant.emailConfigured;
  } catch { error.value = t('app.error'); } finally { loading.value = false; }
});

async function save() {
  saving.value = true; error.value = ''; saved.value = false;
  try {
    const f = form.value;
    await api.patch('/api/tenant', {
      name: f.name, timezone: f.timezone, companyNumber: f.companyNumber || null, vatNumber: f.vatNumber || null,
      address: f.address || null, phone: f.phone || null, email: f.email || null, bankName: f.bankName || null, bankAccount: f.bankAccount || null,
    });
    saved.value = true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    error.value = code === 'validation' ? t('auth.errors.validation') : t('app.error');
  } finally { saving.value = false; }
}
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('settings.title') }}</h1>
  <p v-if="loading">{{ t('app.loading') }}</p>
  <form v-else class="grid max-w-2xl grid-cols-2 gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="save">
    <AppInput v-model="form.name" :label="t('buildings.name')" class="col-span-2" />
    <label class="block text-sm">
      <span class="mb-1 block font-medium text-slate-700">{{ t('settings.timezone') }}</span>
      <input v-model="form.timezone" list="tz" class="w-full rounded-md border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none" />
      <datalist id="tz"><option v-for="z in timezones" :key="z" :value="z" /></datalist>
    </label>
    <AppInput v-model="form.companyNumber" :label="t('settings.companyNumber')" />
    <AppInput v-model="form.vatNumber" :label="t('settings.vatNumber')" />
    <AppInput v-model="form.address" :label="t('contacts.address')" class="col-span-2" />
    <AppInput v-model="form.phone" :label="t('contacts.phone')" />
    <AppInput v-model="form.email" :label="t('auth.email')" type="email" />
    <AppInput v-model="form.bankName" :label="t('settings.bankName')" />
    <AppInput v-model="form.bankAccount" :label="t('settings.bankAccount')" />
    <p v-if="error" class="col-span-2 text-sm text-red-600">{{ error }}</p>
    <p v-if="saved" class="col-span-2 text-sm text-emerald-700" data-test="settings-saved">{{ t('settings.saved') }}</p>
    <div class="col-span-2 flex justify-end"><AppButton type="submit" :loading="saving" data-test="settings-save">{{ t('app.save') }}</AppButton></div>
  </form>
  <p class="mt-3 max-w-2xl text-sm" :class="emailConfigured ? 'text-emerald-700' : 'text-amber-700'" data-test="email-status">
    {{ emailConfigured ? t('emails.configured') : t('emails.notConfigured') }}
  </p>
  <UsersSection v-if="auth.user?.role === 'owner'" />
  <ChangePasswordForm />
</template>
