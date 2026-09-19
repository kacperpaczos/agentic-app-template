import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /*
     * Bezpiecznik ładowany przed każdym plikiem testowym: nic w regresji nie
     * zapisuje prawdziwego `~/.claude/.credentials.json`. Zob. nagłówek pliku.
     */
    setupFiles: ['tests/setup-credential-guard.ts'],
    pool: 'forks',
    reporters: ['default'],
  },
});
