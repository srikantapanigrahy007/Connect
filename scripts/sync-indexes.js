#!/usr/bin/env node
/**
 * Creates every index the models define (unique constraints included). Run on each deployment
 * before starting the API in production, where automatic index creation is off:
 *
 *   npm run db:indexes
 *
 * Creating indexes is safe to repeat. Indexes that exist in the database but are no longer
 * defined are reported, never dropped.
 */
import { loadEnv } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/mongoose.js';
import { allModels } from '../src/models/index.js';
import { createLogger } from '../src/utils/logger.js';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

try {
  await connectDatabase(
    { uri: env.MONGODB_URI, autoIndex: false, serverSelectionTimeoutMS: 15_000, maxAttempts: 1 },
    logger,
  );
  for (const model of allModels) {
    await model.createIndexes();
    const { toDrop } = await model.diffIndexes();
    const name = model.collection.collectionName;
    if (toDrop.length > 0) {
      logger.warn(`Indexes ready: ${name} (not defined any more, left in place)`, { toDrop });
    } else {
      logger.info(`Indexes ready: ${name}`);
    }
  }
  logger.info('All indexes are in place');
} catch (error) {
  logger.error('Creating indexes failed', { error });
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
