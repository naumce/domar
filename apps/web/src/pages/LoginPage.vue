<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { useAuthStore } from '@/stores/auth';

const { t, te } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const tenantSlug = ref(''); const email = ref(''); const password = ref('');
const error = ref(''); const loading = ref(false);

async function submit() {
  error.value = ''; loading.value = true;
  try {
    await auth.login({ tenantSlug: tenantSlug.value, email: email.value, password: password.value });
    await router.push('/app');
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'generic';
    error.value = te(`auth.errors.${code}`) ? t(`auth.errors.${code}`) : t('auth.errors.generic');
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <div class="mx-auto mt-16 max-w-sm rounded-xl bg-white p-6 shadow">
    <h1 class="mb-4 text-xl font-semibold">{{ t('auth.login') }}</h1>
    <form class="space-y-3" @submit.prevent="submit">
      <AppInput v-model="tenantSlug" :label="t('auth.tenantSlug')" data-test="tenantSlug" />
      <AppInput v-model="email" :label="t('auth.email')" type="email" data-test="email" />
      <AppInput v-model="password" :label="t('auth.password')" type="password" data-test="password" />
      <p v-if="error" class="text-sm text-red-600" data-test="error">{{ error }}</p>
      <AppButton type="submit" :loading="loading" class="w-full justify-center">{{ t('auth.login') }}</AppButton>
    </form>
    <p class="mt-4 text-sm text-slate-600">{{ t('auth.noAccount') }} <RouterLink to="/register" class="text-emerald-700 underline">{{ t('auth.register') }}</RouterLink></p>
  </div>
</template>
