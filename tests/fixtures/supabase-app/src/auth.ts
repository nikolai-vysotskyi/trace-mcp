// @ts-nocheck
import { supabase } from './client';
import '@supabase/supabase-js';

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}
