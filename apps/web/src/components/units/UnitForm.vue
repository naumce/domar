<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Contact, Unit, UnitKind } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';

export interface UnitCreatePayload { label: string; floor: string | null; kind: UnitKind; areaM2: number | null; ownershipShare: number | null; ownerContactId: string | null; attachedToUnitId: string | null }
const props = defineProps<{ units: Unit[]; contacts: Contact[]; initial?: Partial<Unit> | undefined; error?: string | null }>();
const emit = defineEmits<{ submit: [payload: UnitCreatePayload] }>();
const { t } = useI18n();

const label = ref(props.initial?.label ?? '');
const floor = ref(props.initial?.floor ?? '');
const kind = ref<UnitKind>(props.initial?.kind ?? 'apartment');
const areaM2 = ref<string | number | null>(props.initial?.areaM2?.toString() ?? '');
const ownershipShare = ref<string | number | null>(props.initial?.ownershipShare?.toString() ?? '');
const ownerContactId = ref<string | null>(props.initial?.ownerContactId ?? null);
const attachedToUnitId = ref<string | null>(props.initial?.attachedToUnitId ?? null);

const kinds: UnitKind[] = ['apartment', 'commercial', 'parking', 'storage', 'other'];
const attachOptions = computed(() => [
  { value: null, label: t('units.notAttached') },
  ...props.units.filter((u) => (u.kind === 'apartment' || u.kind === 'commercial') && u.id !== props.initial?.id).map((u) => ({ value: u.id, label: `${t(`units.kinds.${u.kind}`)} ${u.label}` })),
]);
const ownerOptions = computed(() => [{ value: null, label: t('buildings.none') }, ...props.contacts.map((c) => ({ value: c.id, label: `${c.firstName} ${c.lastName}`.trim() }))]);
const num = (s: string | number | null) => (s === null ? null : typeof s === 'number' ? s : (s.trim() === '' ? null : Number(s)));

function submit() {
  emit('submit', { label: label.value, floor: floor.value.trim() === '' ? null : floor.value, kind: kind.value, areaM2: num(areaM2.value), ownershipShare: num(ownershipShare.value), ownerContactId: ownerContactId.value, attachedToUnitId: attachedToUnitId.value });
}
</script>
<template>
  <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
    <AppInput v-model="label" :label="t('units.label')" data-test="label" />
    <AppInput v-model="floor" :label="t('units.floor')" data-test="floor" />
    <AppSelect v-model="kind" :label="t('units.kind')" :options="kinds.map((k) => ({ value: k, label: t(`units.kinds.${k}`) }))" data-test="kind" />
    <AppInput v-model="areaM2" :label="t('units.areaM2')" type="number" step="0.01" data-test="areaM2" />
    <AppInput v-model="ownershipShare" :label="t('units.ownershipShare')" type="number" step="0.000001" data-test="ownershipShare" />
    <AppSelect v-model="ownerContactId" :label="t('units.owner')" :options="ownerOptions" data-test="ownerContactId" />
    <AppSelect v-model="attachedToUnitId" :label="t('units.attachedTo')" :options="attachOptions" data-test="attachedToUnitId" class="col-span-2" />
    <p v-if="error" class="col-span-2 text-sm text-red-600" data-test="error">{{ error }}</p>
    <div class="col-span-2 flex justify-end"><AppButton type="submit" data-test="submit">{{ t('app.save') }}</AppButton></div>
  </form>
</template>
