<script setup lang="ts" generic="Row extends { id: string }">
import { useI18n } from 'vue-i18n';
defineProps<{ columns: { key: string; label: string }[]; rows: Row[] }>();
const { t } = useI18n();
</script>
<template>
  <div class="overflow-x-auto rounded-xl bg-white shadow-sm">
    <table class="w-full text-sm">
      <thead class="bg-slate-50 text-left text-slate-600"><tr><th v-for="c in columns" :key="c.key" class="px-4 py-2 font-medium">{{ c.label }}</th><th class="px-4 py-2" /></tr></thead>
      <tbody>
        <tr v-if="rows.length === 0"><td :colspan="columns.length + 1" class="px-4 py-6 text-center text-slate-500">{{ t('app.empty') }}</td></tr>
        <tr v-for="row in rows" :key="row.id" class="border-t border-slate-100" data-test="row">
          <td v-for="c in columns" :key="c.key" class="px-4 py-2"><slot :name="`cell-${c.key}`" :row="row">{{ (row as Record<string, unknown>)[c.key] ?? '' }}</slot></td>
          <td class="px-4 py-2 text-right"><slot name="actions" :row="row" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
