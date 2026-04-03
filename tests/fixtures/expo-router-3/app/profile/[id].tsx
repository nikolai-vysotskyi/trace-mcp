import { useLocalSearchParams, useRouter } from 'expo-router';

export default function ProfileScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();

  function goToSettings() {
    router.push('/settings');
  }

  return null;
}
