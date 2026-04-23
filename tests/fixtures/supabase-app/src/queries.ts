// @ts-nocheck
import { supabase } from './client';
import '@supabase/supabase-js';

export async function listUsers() {
  return supabase.from('users').select('id, name');
}

export async function createUser(name: string) {
  return supabase.from('users').insert({ name });
}

export async function touchPost(id: number) {
  return supabase.from('posts').update({ updated_at: new Date().toISOString() }).eq('id', id);
}

export async function removePost(id: number) {
  return supabase.from('posts').delete().eq('id', id);
}

export async function upsertTag(name: string) {
  return supabase.from('tags').upsert({ name });
}

export async function countActive() {
  return supabase.rpc('count_active_users');
}
