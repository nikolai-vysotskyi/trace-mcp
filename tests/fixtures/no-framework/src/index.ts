import { add, subtract } from './utils';
import type { User, UserRole } from './types';

export function createUser(name: string, email: string): User {
  return {
    id: add(1, 0),
    name,
    email,
    role: 'viewer' as UserRole,
  };
}

export { add, subtract };
