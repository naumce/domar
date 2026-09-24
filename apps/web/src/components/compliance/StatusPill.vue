<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ComplianceStatus } from '@/api/types';

const props = defineProps<{ status: ComplianceStatus; dataTest?: string }>();
const { t } = useI18n();
/** `n/a` cannot be an i18n path segment, so the four statuses map onto four safe keys. */
const KEY: Record<ComplianceStatus, string> = { ok: 'ok', due: 'due', overdue: 'overdue', 'n/a': 'na' };
const CLASS: Record<ComplianceStatus, string> = {
  ok: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  due: 'bg-amber-100 text-amber-900 ring-amber-300',
  overdue: 'bg-red-100 text-red-800 ring-red-300',
  'n/a': 'bg-slate-100 text-slate-600 ring-slate-300',
};
const label = computed(() => t(`compliance.status.${KEY[props.status]}`));
</script>
<template>
  <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1" :class="CLASS[status]" :data-test="dataTest">{{ label }}</span>
</template>
