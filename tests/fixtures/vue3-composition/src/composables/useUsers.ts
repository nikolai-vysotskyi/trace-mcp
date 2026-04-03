import { ref } from 'vue'

export function useUsers() {
  const users = ref<{ id: number; name: string; email: string }[]>([])
  const loading = ref(false)

  async function fetchUsers() {
    loading.value = true
    users.value = []
    loading.value = false
  }

  return { users, loading, fetchUsers }
}
