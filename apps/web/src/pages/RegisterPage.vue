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
const form = ref({ slug: '', orgName: '', email: '', password: '', firstName: '', lastName: '' });
const error = ref(''); const loading = ref(false);

async function submit() {
  error.value = ''; loading.value = true;
  try {
    await auth.register({ tenant: { slug: form.value.slug, name: form.value.orgName, countryCode: 'mk' }, user: { email: form.value.email, password: form.value.password, firstName: form.value.firstName, lastName: form.value.lastName } });
    await router.push('/app');
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'generic';
    error.value = te(`auth.errors.${code}`) ? t(`auth.errors.${code}`) : t('auth.errors.generic');
  } finally { loading.value = false; }
}
</script>
<template>
  <div class="mx-auto mt-16 max-w-sm rounded-xl bg-white p-6 shadow">
    <h1 class="mb-4 text-xl font-semibold">{{ t('auth.register') }}</h1>
    <form class="space-y-3" @submit.prevent="submit">
      <AppInput v-model="form.orgName" :label="t('auth.orgName')" data-test="orgName" />
      <AppInput v-model="form.slug" :label="t('auth.tenantSlug')" data-test="slug" placeholder="moja-firma" />
      <AppInput v-model="form.firstName" :label="t('auth.firstName')" data-test="firstName" />
      <AppInput v-model="form.lastName" :label="t('auth.lastName')" data-test="lastName" />
      <AppInput v-model="form.email" :label="t('auth.email')" type="email" data-test="email" />
      <AppInput v-model="form.password" :label="t('auth.password')" type="password" data-test="password" />
      <p v-if="error" class="text-sm text-red-600" data-test="error">{{ error }}</p>
      <AppButton type="submit" :loading="loading" class="w-full justify-center">{{ t('auth.register') }}</AppButton>
    </form>
    <p class="mt-4 text-sm text-slate-600">{{ t('auth.haveAccount') }} <RouterLink to="/login" class="text-emerald-700 underline">{{ t('auth.login') }}</RouterLink></p>
  </div>
</template>
