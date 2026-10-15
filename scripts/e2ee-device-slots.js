#!/usr/bin/env node
/**
 * Gives every E2EE device registered before device slots existed a slot (0–9) of its account,
 * oldest first, through the (user, slot) unique index. Safe to run repeatedly; it never deletes
 * or changes a device's keys. Accounts that already have more than 10 devices (possible only
 * through the old registration race) keep the extra devices without a slot and are reported for
 * manual review; such an account can't register new devices until it is back under the limit.
 *
 *   npm run db:indexes       (first: creates the slot index)
 *   npm run db:e2ee-slots
 *
 * Registration also does this for an account before adding a device, so running the script is
 * only needed to fix accounts that don't register again. Never run it against a production or
 * shared database without approval.
 */
import { loadEnv } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/db/mongoose.js';
import { E2eeDevice } from '../src/models/e2ee-device.model.js';
import { assignMissingSlots } from '../src/services/e2ee.service.js';
import { createLogger } from '../src/utils/logger.js';

/** @returns {Promise<{ accounts: number, assigned: number, overLimitAccounts: number, devicesWithoutSlot: number }>} */
export async function assignAllMissingSlots() {
  const users = await E2eeDevice.distinct('user', { slot: { $exists: false } });
  const summary = {
    accounts: users.length,
    assigned: 0,
    overLimitAccounts: 0,
    devicesWithoutSlot: 0,
  };
  for (const userId of users) {
    const { assigned, withoutSlot } = await assignMissingSlots(userId);
    summary.assigned += assigned;
    if (withoutSlot > 0) {
      summary.overLimitAccounts += 1;
      summary.devicesWithoutSlot += withoutSlot;
    }
  }
  return summary;
}

// Run only when executed directly (the function is also used by tests).
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  try {
    await connectDatabase(
      { uri: env.MONGODB_URI, autoIndex: false, serverSelectionTimeoutMS: 15_000, maxAttempts: 1 },
      logger,
    );
    const summary = await assignAllMissingSlots();
    // Counts only: no user ids, device ids or keys in the output.
    logger.info('E2EE device slots assigned', summary);
    if (summary.overLimitAccounts > 0) {
      logger.warn('Some accounts have more devices than the limit; review them manually', {
        overLimitAccounts: summary.overLimitAccounts,
      });
    }
  } catch (error) {
    logger.error('Assigning E2EE device slots failed', { error });
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}
