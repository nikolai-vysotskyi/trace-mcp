<script setup lang="ts">
interface User {
  id: number;
  name: string;
  email: string;
}

const props = defineProps<{
  user: User;
  posts: { id: number; title: string }[];
}>();
</script>

<template>
  <div>
    <h1>{{ props.user.name }}</h1>
    <ul>
      <li v-for="post in props.posts" :key="post.id">{{ post.title }}</li>
    </ul>
  </div>
</template>
