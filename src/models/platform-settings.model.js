import { PLATFORM_SETTING_BOUNDS } from '#shared';
import { model, Schema } from 'mongoose';

const { uploadMaxBytes, groupMaxMembers, maintenanceMessageMaxLength } = PLATFORM_SETTING_BOUNDS;

/** Defaults used until a Super Admin changes anything. */
export const DEFAULT_PLATFORM_SETTINGS = Object.freeze({
  registrationEnabled: true,
  uploadMaxBytes: uploadMaxBytes.max,
  groupMaxMembers: groupMaxMembers.max,
  maintenanceBanner: Object.freeze({ enabled: false, message: '' }),
});

/**
 * Platform settings: one document with _id "platform". Bounds are enforced here and by the
 * shared schema; values can never exceed the hard limits (5 MB uploads, 256 group members).
 */
const platformSettingsSchema = new Schema(
  {
    _id: { type: String, default: 'platform' },
    registrationEnabled: { type: Boolean, default: true },
    uploadMaxBytes: {
      type: Number,
      min: uploadMaxBytes.min,
      max: uploadMaxBytes.max,
      default: uploadMaxBytes.max,
    },
    groupMaxMembers: {
      type: Number,
      min: groupMaxMembers.min,
      max: groupMaxMembers.max,
      default: groupMaxMembers.max,
    },
    maintenanceBanner: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          message: { type: String, maxlength: maintenanceMessageMaxLength, default: '' },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

export const PlatformSettings = model('PlatformSettings', platformSettingsSchema);
