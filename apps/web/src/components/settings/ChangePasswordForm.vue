<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';

const { t } = useI18n();
const current = ref(''); const next = ref('');
const busy = ref(false); const error = ref(''); const saved = ref(false);

async function submit() {
  busy.value = true; error.value = ''; saved.value = false;
  try {
    await api.post('/api/auth/change-password', { currentPassword: current.value, newPassword: next.value });
    saved.value = true; current.value = ''; next.value = '';
  } catch (e) {
    const code = (e as { code?: string }).code;
    error.value = code === 'invalid_credentials' ? t('password.errors.invalid_credentials')
      : code === 'validation' ? t('password.errors.validation')
      : t('app.error');
  } finally { busy.value = false; }
}
</script>
<template>
  <section class="mt-8 max-w-md">
    <h2 class="mb-3 text-lg font-semibold">{{ t('password.change') }}</h2>
    <form class="space-y-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="submit">
      <AppInput v-model="current" :label="t('password.current')" type="password" data-test="pw-current" />
      <AppInput v-model="next" :label="t('password.new')" type="password" data-test="pw-new" />
      <p v-if="error" class="text-sm text-red-600" data-test="pw-error">{{ error }}</p>
      <p v-if="saved" class="text-sm text-emerald-700" data-test="pw-saved">{{ t('password.changed') }}</p>
      <div class="flex justify-end"><AppButton type="submit" :loading="busy" data-test="pw-submit">{{ t('app.save') }}</AppButton></div>
    </form>
  </section>
</template>
