<script setup lang="ts">
const { data: users } = await useFetch('/api/users');
</script>

<template>
  <div>
    <h1>Home</h1>
    <ul>
      <li v-for="user in users" :key="user.id">{{ user.name }}</li>
    </ul>
  </div>
</template>
