import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const fromTestingLibrary = createRequire(
  createRequire(import.meta.url).resolve('@testing-library/react'),
);

it('resolves matching React and React DOM versions for testing-library', () => {
  const reactVersion = fromTestingLibrary('react').version as string;
  const reactDomVersion = fromTestingLibrary('react-dom').version as string;
  expect(reactDomVersion).toBe(reactVersion);
  expect(() => fromTestingLibrary('react-dom/client')).not.toThrow();
});
