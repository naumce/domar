<script setup lang="ts">
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
</script>
<template><div class="p-8"><h1 class="text-xl font-semibold">{{ t('portal.title') }}</h1><p>{{ t('portal.comingSoon') }}</p></div></template>
