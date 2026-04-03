<script setup lang="ts">
const route = useRoute();
const { data: user } = await useFetch(`/api/users/${route.params.id}`);
</script>

<template>
  <div>
    <h1>{{ user?.name }}</h1>
  </div>
</template>
