<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { usePortalStore } from '@/stores/portal';

const { t, te } = useI18n();
const router = useRouter();
const portal = usePortalStore();
const email = ref(''); const password = ref('');
const error = ref(''); const loading = ref(false);

async function submit() {
  error.value = ''; loading.value = true;
  try {
    await portal.login({ email: email.value, password: password.value });
    await router.push('/portal');
  } catch (e) {
    const c = (e as { code?: string }).code ?? 'generic';
    error.value = te(`portal.errors.${c}`) ? t(`portal.errors.${c}`) : t('portal.errors.generic');
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <div class="mx-auto mt-16 max-w-sm rounded-xl bg-white p-6 shadow">
    <h1 class="mb-4 text-xl font-semibold">{{ t('portal.title') }}</h1>
    <form class="space-y-3" @submit.prevent="submit">
      <AppInput v-model="email" :label="t('portal.email')" type="email" data-test="portal-email" />
      <AppInput v-model="password" :label="t('portal.password')" type="password" data-test="portal-password" />
      <p v-if="error" class="text-sm text-red-600" data-test="portal-error">{{ error }}</p>
      <AppButton type="submit" :loading="loading" class="w-full justify-center" data-test="portal-submit">{{ t('portal.signIn') }}</AppButton>
    </form>
    <p class="mt-4 text-sm text-slate-600">{{ t('portal.haveCode') }} <RouterLink to="/portal/register" class="text-emerald-700 underline">{{ t('portal.register') }}</RouterLink></p>
  </div>
</template>
