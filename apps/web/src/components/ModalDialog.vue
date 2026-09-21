<script setup lang="ts">
defineProps<{ open: boolean; title: string }>();
const emit = defineEmits<{ close: [] }>();
</script>
<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 pt-16" @click.self="emit('close')">
      <div class="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl" role="dialog">
        <div class="mb-4 flex items-center justify-between"><h2 class="text-lg font-semibold">{{ title }}</h2><button class="text-slate-500" @click="emit('close')">✕</button></div>
        <slot />
      </div>
    </div>
  </Teleport>
</template>
