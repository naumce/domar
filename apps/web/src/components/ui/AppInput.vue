<script setup lang="ts">
defineProps<{ label: string; error?: string; type?: string; placeholder?: string; dataTest?: string; step?: string }>();
const model = defineModel<string | number | null>();
</script>
<template>
  <label class="block text-sm">
    <span class="mb-1 block font-medium text-slate-700">{{ label }}</span>
    <input v-model="model" :type="type ?? 'text'" :placeholder="placeholder" :data-test="dataTest" :step="step"
      class="w-full rounded-md border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none" :class="{ 'border-red-500': error }" />
    <span v-if="error" class="mt-1 block text-xs text-red-600">{{ error }}</span>
  </label>
</template>
