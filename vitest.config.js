import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js', 'src/**/*.test.js'],
    globalSetup: ['./test/global-setup.js'],
    // Argon2 hashing and a real mongod make these slower than unit tests.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
