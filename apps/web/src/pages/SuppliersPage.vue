<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { AccountCode, AccountCodeList, Supplier } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { swallow, useResource } from '@/composables/useResource';

const { t, te } = useI18n();
const suppliers = useResource<Supplier>('/api/suppliers');
const open = ref(false);
const editing = ref<Supplier | null>(null);
const error = ref('');
const showInactive = ref(false);
// The organization's own chart (spec §3): a supplier's expenses book to the account picked here
// instead of `expense_default`. Offered as the chart's own slots and codes rather than as an id the
// manager would have to know — and only the usable rows, since an inactive code is not a mapping.
const accountCodes = ref<AccountCode[]>([]);
const blank = () => ({ name: '', companyNumber: '', vatNumber: '', email: '', phone: '', iban: '', accountCodeId: '' });
const form = ref(blank());
// Active suppliers only until the manager asks to see the rest.
onMounted(() => {
  swallow(suppliers.load());
  swallow(api.get<AccountCodeList>('/api/account-codes').then((r) => { accountCodes.value = (r.rows ?? []).filter((c) => c.isActive && c.code !== ''); }));
});
watch(showInactive, (v) => swallow(suppliers.load(v ? { includeInactive: 'true' } : undefined)));

function fail(e: unknown) {
  const code = (e as { code?: string }).code ?? 'generic';
  error.value = te(`suppliers.errors.${code}`) ? t(`suppliers.errors.${code}`) : t('app.error');
}

function openNew() { editing.value = null; form.value = blank(); error.value = ''; open.value = true; }
function openEdit(row: Supplier) {
  editing.value = row;
  form.value = {
    name: row.name, companyNumber: row.companyNumber ?? '', vatNumber: row.vatNumber ?? '', email: row.email ?? '',
    phone: row.phone ?? '', iban: row.iban ?? '', accountCodeId: row.accountCodeId ?? '',
  };
  error.value = '';
  open.value = true;
}

/** Only the fields the manager actually changed: `supplierPatch` is `.strict()` and rejects an empty body. */
function diff(orig: Supplier, next: ReturnType<typeof blank>): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  if (next.name !== orig.name) patch.name = next.name;
  for (const key of ['companyNumber', 'vatNumber', 'email', 'phone', 'iban', 'accountCodeId'] as const) {
    const value = next[key] || null;
    if (value !== (orig[key] ?? null)) patch[key] = value;
  }
  return patch;
}

async function submit() {
  error.value = '';
  try {
    if (editing.value) {
      const patch = diff(editing.value, form.value);
      if (Object.keys(patch).length > 0) await suppliers.update(editing.value.id, patch);
    } else {
      await suppliers.create({
        name: form.value.name, companyNumber: form.value.companyNumber || null, vatNumber: form.value.vatNumber || null,
        email: form.value.email || null, phone: form.value.phone || null, iban: form.value.iban || null,
        accountCodeId: form.value.accountCodeId || null,
      });
    }
    open.value = false;
  } catch (e) { fail(e); }
}
async function toggleActive(row: Supplier) {
  error.value = '';
  try { await suppliers.update(row.id, { isActive: !row.isActive }); } catch (e) { fail(e); }
}
async function remove(id: string) {
  error.value = '';
  try { await suppliers.remove(id); } catch (e) { fail(e); }
}
</script>
<template>
  <div>
    <div class="mb-3 flex items-center justify-between"><h1 class="text-2xl font-semibold">{{ t('suppliers.title') }}</h1><AppButton data-test="add-supplier" @click="openNew">{{ t('suppliers.add') }}</AppButton></div>
    <label class="mb-3 flex items-center gap-2 text-sm"><input v-model="showInactive" type="checkbox" data-test="supplier-show-inactive" /> {{ t('suppliers.showInactive') }}</label>
    <p v-if="error" class="mb-2 text-sm text-red-600" data-test="page-error">{{ error }}</p>
    <DataTable
      :columns="[{ key: 'name', label: t('suppliers.name') }, { key: 'companyNumber', label: t('contacts.companyNumber') }, { key: 'vatNumber', label: t('contacts.vatNumber') }, { key: 'email', label: t('auth.email') }, { key: 'phone', label: t('contacts.phone') }, { key: 'iban', label: t('suppliers.iban') }]"
      :rows="suppliers.rows.value"
      :row-class="(row) => (row.isActive ? '' : 'opacity-50')"
    >
      <template #actions="{ row }">
        <AppButton variant="secondary" @click="openEdit(row)">{{ t('app.edit') }}</AppButton>
        <AppButton variant="secondary" class="ml-2" data-test="supplier-toggle" @click="toggleActive(row)">{{ row.isActive ? t('suppliers.deactivate') : t('suppliers.activate') }}</AppButton>
        <AppButton variant="danger" class="ml-2" @click="remove(row.id)">{{ t('app.delete') }}</AppButton>
      </template>
    </DataTable>
    <ModalDialog :open="open" :title="editing ? t('app.edit') : t('suppliers.add')" @close="open = false">
      <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
        <AppInput v-model="form.name" :label="t('suppliers.name')" data-test="supplier-name" class="col-span-2" />
        <AppInput v-model="form.companyNumber" :label="t('contacts.companyNumber')" />
        <AppInput v-model="form.vatNumber" :label="t('contacts.vatNumber')" />
        <AppInput v-model="form.email" :label="t('auth.email')" />
        <AppInput v-model="form.phone" :label="t('contacts.phone')" />
        <AppInput v-model="form.iban" :label="t('suppliers.iban')" class="col-span-2" />
        <label class="col-span-2 text-sm">{{ t('suppliers.accountCode') }}
          <select v-model="form.accountCodeId" class="mt-1 w-full rounded border p-2" data-test="supplier-account-code">
            <option value="">{{ t('suppliers.accountCodeDefault') }}</option>
            <option v-for="c in accountCodes" :key="c.id" :value="c.id">{{ c.code }} — {{ c.name }} ({{ t(`accounting.slots.${c.slot}`) }})</option>
          </select>
        </label>
        <div class="col-span-2 flex justify-end"><AppButton type="button" data-test="supplier-submit" @click="submit">{{ editing ? t('app.save') : t('app.create') }}</AppButton></div>
      </form>
    </ModalDialog>
  </div>
</template>
