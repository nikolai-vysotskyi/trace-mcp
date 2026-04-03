<script>
import UserList from './components/UserList.vue'

export default {
  name: 'App',
  components: { UserList },
  data() {
    return {
      title: 'My App'
    }
  }
}
</script>

<template>
  <div id="app">
    <UserList :title="title" />
  </div>
</template>
