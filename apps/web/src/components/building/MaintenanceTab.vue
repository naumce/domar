<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { MaintenanceCategory, MaintenancePriority, MaintenanceRequest, MaintenanceRow, MaintenanceStatus, Supplier, Unit, User } from '@/api/types';
import MaintenancePanel from '@/components/maintenance/MaintenancePanel.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ buildingId: string }>();
const { t, te } = useI18n();
const auth = useAuthStore();

/** The board's columns, in the order the domain declares the statuses. */
const STATUSES: MaintenanceStatus[] = ['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected'];
const CATEGORIES: MaintenanceCategory[] = ['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other'];
const PRIORITIES: MaintenancePriority[] = ['low', 'normal', 'high', 'urgent'];
/** Spec §8: a request is given to a person who can work it, never to a readonly account. */
const ASSIGNABLE: User['role'][] = ['owner', 'accountant', 'technician'];

const rows = ref<MaintenanceRow[]>([]);
const units = ref<Unit[]>([]);
const users = ref<User[]>([]);
const suppliers = ref<Supplier[]>([]);
const selected = ref<MaintenanceRequest | null>(null);
const filter = ref({ status: '', category: '' });
const blank = () => ({ title: '', description: '', category: 'other' as MaintenanceCategory, priority: 'normal' as MaintenancePriority, unitId: '' });
const form = ref(blank());
const error = ref('');
const saving = ref(false);
const loaded = ref(false);

const canWrite = computed(() => auth.user?.role === 'owner' || auth.user?.role === 'accountant');
const columnRows = (s: MaintenanceStatus) => rows.value.filter((r) => r.status === s);
const message = (e: unknown) => {
  const code = (e as { code?: string }).code ?? 'generic';
  return te(`maintenance.errors.${code}`) ? t(`maintenance.errors.${code}`) : t('app.error');
};

async function load() {
  const q: Record<string, string> = {};
  if (filter.value.status) q.status = filter.value.status;
  if (filter.value.category) q.category = filter.value.category;
  rows.value = (await api.get<{ rows: MaintenanceRow[] }>(`/api/buildings/${props.buildingId}/maintenance`, q)).rows;
}

onMounted(async () => {
  try {
    // Three independent reads, fired together; the board follows because it is the one that can fail
    // on a filter the user has not set yet.
    const [u, us, sup] = await Promise.all([
      api.get<{ rows: Unit[] }>(`/api/buildings/${props.buildingId}/units`),
      api.get<{ rows: User[] }>('/api/users'),
      api.get<{ rows: Supplier[] }>('/api/suppliers'),
    ]);
    units.value = u.rows;
    users.value = us.rows.filter((x) => x.isActive && ASSIGNABLE.includes(x.role));
    suppliers.value = sup.rows;
    await load();
  } catch (e) { error.value = message(e); } finally { loaded.value = true; }
});
// A watcher, not `@change`: AppSelect emits no change event of its own.
watch(filter, () => { void load().catch((e) => { error.value = message(e); }); }, { deep: true });

async function openCard(id: string) {
  error.value = '';
  try { selected.value = await api.get<MaintenanceRequest>(`/api/maintenance-requests/${id}`); }
  catch (e) { error.value = message(e); }
}

async function create() {
  error.value = '';
  if (!form.value.title.trim()) { error.value = t('maintenance.errors.validation'); return; }
  saving.value = true;
  try {
    const created = await api.post<MaintenanceRequest>(`/api/buildings/${props.buildingId}/maintenance`, {
      title: form.value.title.trim(),
      description: form.value.description.trim(),
      category: form.value.category,
      priority: form.value.priority,
      unitId: form.value.unitId || null,
    });
    form.value = blank();
    selected.value = created;
    await load();
  } catch (e) { error.value = message(e); } finally { saving.value = false; }
}

async function onUpdated(request: MaintenanceRequest) {
  selected.value = request;
  error.value = '';
  try { await load(); } catch (e) { error.value = message(e); }
}
</script>
<template>
  <div v-if="loaded" class="space-y-4">
    <form v-if="canWrite" class="grid grid-cols-5 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="create">
      <AppInput v-model="form.title" :label="t('maintenance.requestTitle')" data-test="maintenance-title" />
      <AppInput v-model="form.description" :label="t('maintenance.description')" data-test="maintenance-description" />
      <AppSelect v-model="form.category" :label="t('maintenance.category')" data-test="maintenance-category"
        :options="CATEGORIES.map((c) => ({ value: c, label: t(`maintenance.categories.${c}`) }))" />
      <AppSelect v-model="form.priority" :label="t('maintenance.priority')" data-test="maintenance-priority"
        :options="PRIORITIES.map((p) => ({ value: p, label: t(`maintenance.priorities.${p}`) }))" />
      <div class="flex items-end gap-3">
        <AppSelect v-model="form.unitId" :label="t('maintenance.unit')" data-test="maintenance-unit"
          :options="[{ value: '', label: t('maintenance.noUnit') }, ...units.map((u) => ({ value: u.id, label: u.label }))]" />
        <AppButton type="button" :loading="saving" data-test="maintenance-create" @click="create">{{ t('maintenance.add') }}</AppButton>
      </div>
    </form>

    <div class="flex gap-3">
      <AppSelect v-model="filter.status" :label="t('maintenance.filterStatus')" data-test="maintenance-filter-status"
        :options="[{ value: '', label: t('maintenance.all') }, ...STATUSES.map((s) => ({ value: s, label: t(`maintenance.statuses.${s}`) }))]" />
      <AppSelect v-model="filter.category" :label="t('maintenance.filterCategory')" data-test="maintenance-filter-category"
        :options="[{ value: '', label: t('maintenance.all') }, ...CATEGORIES.map((c) => ({ value: c, label: t(`maintenance.categories.${c}`) }))]" />
    </div>

    <p v-if="error" class="text-sm text-red-600" data-test="maintenance-error">{{ error }}</p>

    <!-- A board of buttons, never drag-and-drop: every move is an explicit, audited transition. -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-6">
      <section v-for="s in STATUSES" :key="s" class="rounded-xl bg-slate-100 p-2" :data-test="`maintenance-column-${s}`">
        <h3 class="mb-2 flex items-center justify-between text-sm font-semibold">
          {{ t(`maintenance.statuses.${s}`) }}
          <span class="rounded-full bg-white px-2 text-xs" :data-test="`maintenance-count-${s}`">{{ columnRows(s).length }}</span>
        </h3>
        <button v-for="r in columnRows(s)" :key="r.id" type="button" data-test="maintenance-card"
          class="mb-2 block w-full rounded-lg bg-white p-2 text-left text-sm shadow-sm hover:ring-2 hover:ring-emerald-400"
          :class="selected?.id === r.id ? 'ring-2 ring-emerald-500' : ''" @click="openCard(r.id)">
          <span class="block font-medium">{{ r.title }}</span>
          <span class="block text-xs text-slate-500">
            {{ t(`maintenance.categories.${r.category}`) }} · {{ t(`maintenance.priorities.${r.priority}`) }}
            <template v-if="r.unitLabel"> · {{ r.unitLabel }}</template>
            <template v-if="r.photoCount > 0"> · {{ r.photoCount }} 📷</template>
          </span>
          <span class="block text-xs text-slate-500">{{ r.assigneeName ?? r.reporterName }}</span>
        </button>
      </section>
    </div>

    <MaintenancePanel v-if="selected" :key="selected.id" :request="selected" :users="users" :suppliers="suppliers" :can-write="canWrite"
      @updated="onUpdated" @error="(m) => (error = m)" />
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
