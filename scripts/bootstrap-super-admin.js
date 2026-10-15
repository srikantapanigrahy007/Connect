/**
 * Makes an existing, verified account the Super Admin. Run on the server, with the API's
 * environment (backend/.env or real environment variables):
 *
 *   npm run admin:bootstrap -- --email you@example.com
 *   npm run admin:bootstrap -- --email you@example.com --force   (recovery)
 *
 * There is deliberately no HTTP endpoint for this.
 */
import { parseArgs } from 'node:util';
import { loadEnv } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/mongoose.js';
import { allModels } from '../src/models/index.js';
import { bootstrapSuperAdmin, BootstrapError } from '../src/services/admin-bootstrap.js';
import { createLogger } from '../src/utils/logger.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, force: { type: 'boolean', default: false } },
});
const env = loadEnv();
const logger = createLogger('warn');

try {
  await connectDatabase(
    { uri: env.MONGODB_URI, autoIndex: false, serverSelectionTimeoutMS: 10_000, maxAttempts: 1 },
    logger,
  );
  // The audit log needs its indexes even when production runs without autoIndex.
  await Promise.all(allModels.map((model) => model.createIndexes()));
  const result = await bootstrapSuperAdmin({ email: values.email, force: values.force });
  process.stdout.write(`@${result.username} is now a Super Admin.\n`);
  process.exitCode = 0;
} catch (error) {
  console.error(error instanceof BootstrapError ? error.message : 'Bootstrap failed.');
  process.exitCode = 1;
} finally {
  await disconnectDatabase().catch(() => undefined);
}
