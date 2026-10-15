import { AVATAR_MIME_TYPES, LIMITS } from '#shared';
import sharp from 'sharp';
import { AppError } from '../utils/app-error.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Magic bytes at the start of each allowed file type. */
const SIGNATURES = {
  'image/jpeg': (data) =>
    data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  'image/png': (data) => data.subarray(0, 8).equals(PNG_SIGNATURE),
  'image/webp': (data) =>
    data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP',
};

/** The format name the image decoder must report for each MIME type. */
const DECODER_FORMATS = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

/** Refuse decompression bombs: at most ~40 megapixels before resizing. */
const MAX_INPUT_PIXELS = 40_000_000;

const invalidFile = () =>
  new AppError(400, 'INVALID_FILE', 'That file is not a valid JPEG, PNG or WebP image.');

/**
 * Validates an uploaded avatar and converts it to a safe image:
 * 1. the declared MIME type must be allowed;
 * 2. the file's first bytes must match that type (a renamed file is rejected);
 * 3. the whole image must decode, and the decoder must agree on the format;
 * 4. it is re-encoded as a 512×512 WebP, which drops all metadata (EXIF, GPS location) and any
 *    data hidden after the image.
 * The 5 MB size limit is enforced while uploading (see middleware/upload.js).
 *
 * @param {{ buffer: Buffer, mimetype: string }} file
 * @returns {Promise<Buffer>} WebP image data
 */
export async function processAvatarImage(file) {
  if (!AVATAR_MIME_TYPES.includes(file.mimetype)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a JPEG, PNG or WebP image.');
  }
  if (!SIGNATURES[file.mimetype](file.buffer)) throw invalidFile();

  const decoderOptions = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false };
  let metadata;
  try {
    metadata = await sharp(file.buffer, decoderOptions).metadata();
  } catch {
    throw invalidFile();
  }
  if (metadata.format !== DECODER_FORMATS[file.mimetype]) throw invalidFile();

  try {
    return await sharp(file.buffer, decoderOptions)
      .rotate() // apply the camera's orientation before the metadata is dropped
      .resize(LIMITS.avatarSizePx, LIMITS.avatarSizePx, { fit: 'cover', position: 'attention' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw invalidFile();
  }
}
