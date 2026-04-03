import { useRouter, Link } from 'expo-router';

export default function FeedScreen() {
  const router = useRouter();

  function openProfile(id: string) {
    router.push(`/profile/${id}`);
  }

  return null;
}
