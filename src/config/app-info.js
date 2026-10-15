import { readFileSync } from 'node:fs';

// Resolves to backend/package.json from src/config.
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

export const APP_VERSION = packageJson.version ?? '0.0.0';
