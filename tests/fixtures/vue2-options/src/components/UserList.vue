<script>
export default {
  name: 'UserList',
  props: {
    title: {
      type: String,
      required: true
    }
  },
  data() {
    return {
      users: []
    }
  },
  methods: {
    selectUser(id) {
      this.$emit('select', id)
    }
  }
}
</script>

<template>
  <div class="user-list">
    <h2>{{ title }}</h2>
    <ul>
      <li v-for="user in users" :key="user.id" @click="selectUser(user.id)">
        {{ user.name }}
      </li>
    </ul>
  </div>
</template>
