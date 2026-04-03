<script setup lang="ts">
defineProps<{
  name: string
  email: string
}>()

defineEmits<{
  (e: 'click', id: number): void
}>()
</script>

<template>
  <div class="user-card">
    <h3>{{ name }}</h3>
    <p>{{ email }}</p>
  </div>
</template>
