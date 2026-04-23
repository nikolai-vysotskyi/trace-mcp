// @ts-nocheck
import { supabase } from './client';
import '@supabase/supabase-js';

export async function uploadAvatar(userId: string, file: File) {
  return supabase.storage.from('avatars').upload(`${userId}.png`, file);
}

export async function removeAvatar(userId: string) {
  return supabase.storage.from('avatars').remove([`${userId}.png`]);
}

export async function listBackups() {
  return supabase.storage.from('backups').list();
}
