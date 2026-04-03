<script setup lang="ts">
import UserCard from './UserCard.vue'
import { useUsers } from '../composables/useUsers'

defineProps<{
  currentUser: { id: number; name: string }
}>()

defineEmits<{
  (e: 'select', id: number): void
}>()

const { users, loading } = useUsers()
</script>

<template>
  <div class="user-list">
    <UserCard
      v-for="user in users"
      :key="user.id"
      :name="user.name"
      :email="user.email"
      @click="$emit('select', user.id)"
    />
    <span v-if="loading">Loading...</span>
  </div>
</template>
