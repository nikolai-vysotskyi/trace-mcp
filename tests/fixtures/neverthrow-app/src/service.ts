// @ts-nocheck
import { ok, err, Result, fromPromise } from 'neverthrow';

interface User {
  id: string;
  name: string;
}

type AppError = 'NOT_FOUND' | 'DB_ERROR' | 'VALIDATION_ERROR';

export function validateName(name: string): Result<string, AppError> {
  if (name.length < 2) return err('VALIDATION_ERROR');
  return ok(name.trim());
}

export function findUser(id: string): Result<User, AppError> {
  if (id === '0') return err('NOT_FOUND');
  return ok({ id, name: 'John' });
}

export function createUser(name: string): Result<User, AppError> {
  return validateName(name)
    .map((validName) => ({ id: '1', name: validName }))
    .mapErr((e) => e);
}

export function getUserDisplay(id: string): Result<string, AppError> {
  return findUser(id)
    .andThen((user) => ok(`${user.name} (${user.id})`));
}

export function fetchExternal(url: string) {
  return fromPromise(
    fetch(url).then((r) => r.json()),
    () => 'DB_ERROR' as AppError,
  );
}
