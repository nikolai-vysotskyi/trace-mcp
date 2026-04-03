<script setup lang="ts">
defineProps<{
  user: { id: number; name: string; email: string };
}>();
</script>

<template>
  <div class="user-card">
    <h3>{{ user.name }}</h3>
    <p>{{ user.email }}</p>
  </div>
</template>
