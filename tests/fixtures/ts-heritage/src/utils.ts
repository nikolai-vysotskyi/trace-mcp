/** Utility functions — imported by classes.ts */
export function toJSON(obj: unknown): string {
  return JSON.stringify(obj);
}

export function fromJSON<T>(str: string): T {
  return JSON.parse(str) as T;
}
