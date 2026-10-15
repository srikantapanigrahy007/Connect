import { DEFAULT_PLATFORM_SETTINGS, PlatformSettings } from '../models/platform-settings.model.js';

/** Other API instances pick up changes within this time. */
const CACHE_MS = 10_000;

function toDto(doc) {
  return {
    registrationEnabled: doc?.registrationEnabled ?? DEFAULT_PLATFORM_SETTINGS.registrationEnabled,
    uploadMaxBytes: doc?.uploadMaxBytes ?? DEFAULT_PLATFORM_SETTINGS.uploadMaxBytes,
    groupMaxMembers: doc?.groupMaxMembers ?? DEFAULT_PLATFORM_SETTINGS.groupMaxMembers,
    maintenanceBanner: {
      enabled: doc?.maintenanceBanner?.enabled ?? false,
      message: doc?.maintenanceBanner?.message ?? '',
    },
  };
}

/**
 * Platform settings, applied where they matter: registration (auth service), upload size
 * (attachment service), group size (group service) and the maintenance banner (public
 * endpoint). Reads are cached briefly; this instance sees its own changes immediately.
 */
export function createSettingsService() {
  let cached = null;
  let cachedAt = 0;

  return {
    async get() {
      if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
      cached = toDto(await PlatformSettings.findById('platform').lean());
      cachedAt = Date.now();
      return cached;
    },

    /** Applies validated changes (see platformSettingsUpdateSchema); returns before/after. */
    async update(actorId, changes) {
      const before = await this.get();
      const set = { updatedBy: actorId };
      for (const key of ['registrationEnabled', 'uploadMaxBytes', 'groupMaxMembers']) {
        if (changes[key] !== undefined) set[key] = changes[key];
      }
      if (changes.maintenanceBanner) set.maintenanceBanner = changes.maintenanceBanner;
      const doc = await PlatformSettings.findOneAndUpdate(
        { _id: 'platform' },
        { $set: set },
        { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
      ).lean();
      cached = toDto(doc);
      cachedAt = Date.now();
      return { before, after: cached };
    },

    /** Forget the cache (tests). */
    reset() {
      cached = null;
    },
  };
}
