<script setup lang="ts">
interface User {
  id: number;
  name: string;
  email: string;
}

const props = defineProps<{
  users: User[];
  filters: { search?: string };
}>();
</script>

<template>
  <div>
    <h1>Users</h1>
    <UserCard v-for="user in props.users" :key="user.id" :user="user" />
  </div>
</template>
