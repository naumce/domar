<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { usePortalStore } from '@/stores/portal';

const { t, te } = useI18n();
const portal = usePortalStore();
const code = ref(''); const codeError = ref(''); const codeDone = ref(false); const codeBusy = ref(false);
const currentPassword = ref(''); const newPassword = ref('');
const pwError = ref(''); const pwDone = ref(false); const pwBusy = ref(false);

const wording = (e: unknown) => {
  const c = (e as { code?: string }).code ?? 'generic';
  return te(`portal.errors.${c}`) ? t(`portal.errors.${c}`) : t('portal.errors.generic');
};

async function addCode() {
  codeError.value = ''; codeDone.value = false; codeBusy.value = true;
  try { await portal.addCode(code.value); code.value = ''; codeDone.value = true; }
  catch (e) { codeError.value = wording(e); } finally { codeBusy.value = false; }
}
async function changePassword() {
  pwError.value = ''; pwDone.value = false; pwBusy.value = true;
  try {
    await portal.changePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value });
    currentPassword.value = ''; newPassword.value = ''; pwDone.value = true;
  } catch (e) { pwError.value = wording(e); } finally { pwBusy.value = false; }
}
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.settings') }}</h1>
  <section class="mb-6 max-w-sm rounded-xl bg-white p-4 shadow-sm">
    <h2 class="mb-2 font-medium">{{ t('portal.account') }}</h2>
    <p class="text-sm text-slate-600">{{ portal.account?.email }}</p>
  </section>
  <section class="mb-6 max-w-sm rounded-xl bg-white p-4 shadow-sm">
    <h2 class="mb-2 font-medium">{{ t('portal.addCode') }}</h2>
    <form class="space-y-3" @submit.prevent="addCode">
      <AppInput v-model="code" :label="t('portal.code')" data-test="portal-add-code" />
      <p v-if="codeError" class="text-sm text-red-600" data-test="portal-add-code-error">{{ codeError }}</p>
      <p v-if="codeDone" class="text-sm text-emerald-700" data-test="portal-add-code-done">{{ t('portal.addCodeDone') }}</p>
      <AppButton type="submit" :loading="codeBusy" data-test="portal-add-code-submit">{{ t('portal.addCode') }}</AppButton>
    </form>
  </section>
  <section class="max-w-sm rounded-xl bg-white p-4 shadow-sm">
    <h2 class="mb-2 font-medium">{{ t('portal.changePassword') }}</h2>
    <form class="space-y-3" @submit.prevent="changePassword">
      <AppInput v-model="currentPassword" :label="t('portal.currentPassword')" type="password" data-test="portal-current-password" />
      <AppInput v-model="newPassword" :label="t('portal.newPassword')" type="password" data-test="portal-new-password" />
      <p v-if="pwError" class="text-sm text-red-600" data-test="portal-password-error">{{ pwError }}</p>
      <p v-if="pwDone" class="text-sm text-emerald-700" data-test="portal-password-changed">{{ t('portal.passwordChanged') }}</p>
      <AppButton type="submit" :loading="pwBusy" data-test="portal-change-password">{{ t('portal.changePassword') }}</AppButton>
    </form>
  </section>
</template>
