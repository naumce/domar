<script setup lang="ts">
defineProps<{ label: string; options: { value: string | null; label: string }[]; dataTest?: string }>();
const model = defineModel<string | null>();
</script>
<template>
  <label class="block text-sm">
    <span class="mb-1 block font-medium text-slate-700">{{ label }}</span>
    <select v-model="model" :data-test="dataTest" class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 focus:border-emerald-500 focus:outline-none">
      <option v-for="o in options" :key="o.value ?? 'null'" :value="o.value">{{ o.label }}</option>
    </select>
  </label>
</template>
