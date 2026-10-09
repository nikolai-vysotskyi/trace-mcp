import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['app.test.tsx'],
    environment: 'jsdom',
    reporters: ['default'],
  },
});
