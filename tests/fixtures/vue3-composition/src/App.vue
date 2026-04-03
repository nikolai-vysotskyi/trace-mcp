<script setup lang="ts">
import UserList from './components/UserList.vue'
import { useAuth } from './composables/useAuth'

const { user } = useAuth()
</script>

<template>
  <div id="app">
    <UserList :currentUser="user" />
  </div>
</template>
