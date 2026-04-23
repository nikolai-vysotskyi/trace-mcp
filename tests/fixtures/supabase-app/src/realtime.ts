// @ts-nocheck
import { supabase } from './client';
import '@supabase/supabase-js';

export function subscribePosts(onChange: (payload: unknown) => void) {
  return supabase
    .channel('posts-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, onChange)
    .subscribe();
}
