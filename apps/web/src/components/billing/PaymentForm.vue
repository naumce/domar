<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { toMinor } from '@/utils/money';

export type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'cheque' | 'other';
export interface PaymentPayload { amountMinor: number; method: PaymentMethod; paidAt: string; reference: string | null; note: string | null }
const props = defineProps<{ outstandingMinor: number | null }>();
const emit = defineEmits<{ submit: [payload: PaymentPayload] }>();
const { t } = useI18n();
const fmt = (minor: number) => (minor / 100).toFixed(2).replace('.', ',');
const amount = ref(props.outstandingMinor && props.outstandingMinor > 0 ? fmt(props.outstandingMinor) : '');
const method = ref<PaymentMethod>('bank_transfer');
const date = ref(new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
const reference = ref(''); const note = ref(''); const error = ref('');
const methods: PaymentMethod[] = ['bank_transfer', 'cash', 'card', 'cheque', 'other'];
function submit() {
  error.value = '';
  const amountMinor = toMinor(amount.value);
  if (amountMinor === null || amountMinor <= 0 || !date.value) { error.value = t('auth.errors.validation'); return; }
  emit('submit', { amountMinor, method: method.value, paidAt: new Date(`${date.value}T12:00:00`).toISOString(), reference: reference.value.trim() || null, note: note.value.trim() || null });
}
</script>
<template>
  <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
    <AppInput v-model="amount" :label="t('payments.amount')" data-test="pay-amount" placeholder="1.560,99" />
    <AppSelect v-model="method" :label="t('payments.method')" :options="methods.map((m) => ({ value: m, label: t(`payments.methods.${m}`) }))" data-test="pay-method" />
    <AppInput v-model="date" :label="t('payments.paidAt')" type="date" data-test="pay-date" />
    <AppInput v-model="reference" :label="t('payments.reference')" data-test="pay-reference" />
    <AppInput v-model="note" :label="t('payments.note')" class="col-span-2" />
    <p v-if="error" class="col-span-2 text-sm text-red-600" data-test="error">{{ error }}</p>
    <div class="col-span-2 flex justify-end"><AppButton type="submit" data-test="pay-submit">{{ t('payments.record') }}</AppButton></div>
  </form>
</template>
