export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
}

export type UserRole = 'admin' | 'editor' | 'viewer';
