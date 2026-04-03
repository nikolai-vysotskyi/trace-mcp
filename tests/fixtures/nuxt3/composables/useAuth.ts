export function useAuth() {
  const user = useState('auth-user', () => null);
  const isLoggedIn = computed(() => !!user.value);

  async function login(email: string, password: string) {
    const data = await $fetch('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    user.value = data;
  }

  return { user, isLoggedIn, login };
}
