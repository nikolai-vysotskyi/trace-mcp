import { ref } from 'vue'

export function useAuth() {
  const user = ref<{ id: number; name: string } | null>(null)
  const isAuthenticated = ref(false)

  function login(name: string) {
    user.value = { id: 1, name }
    isAuthenticated.value = true
  }

  return { user, isAuthenticated, login }
}
