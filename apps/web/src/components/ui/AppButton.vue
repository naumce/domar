<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'primary' | 'secondary' | 'danger'; loading?: boolean; disabled?: boolean; type?: 'button' | 'submit' }>(), { variant: 'primary', loading: false, disabled: false, type: 'button' });
</script>
<template>
  <button :type="type" :disabled="loading || disabled" class="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60"
    :class="{ 'bg-emerald-600 text-white hover:bg-emerald-700': variant === 'primary', 'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50': variant === 'secondary', 'bg-red-600 text-white hover:bg-red-700': variant === 'danger' }">
    <span v-if="loading" class="h-3 w-3 animate-spin rounded-full border-2 border-white/60 border-t-transparent" />
    <slot />
  </button>
</template>
