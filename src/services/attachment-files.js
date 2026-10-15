import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, LIMITS } from '#shared';
import sharp from 'sharp';
import { AppError } from '../utils/app-error.js';

/** Refuse decompression bombs: at most ~40 megapixels. */
const MAX_INPUT_PIXELS = 40_000_000;
/** Generic MIME types browsers send when they don't know a file; they carry no claim. */
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const OFFICE_FOLDERS = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word/',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xl/',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ppt/',
};
const REENCODE = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

const unsupported = () =>
  new AppError(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    "This file type isn't supported, or its contents don't match its name.",
  );
const invalidFile = () => new AppError(400, 'INVALID_FILE', 'This file is damaged or not valid.');

const ascii = (data, start, end) => data.toString('latin1', start, end);

/**
 * The content types a file can be, judging only by its bytes ("magic numbers"). Several are
 * possible for container formats (WebM and MP4 hold audio or video; ZIP holds Office files).
 */
export function detectContentTypes(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return ['image/jpeg'];
  }
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ['image/png'];
  }
  if (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a') return ['image/gif'];
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return ['image/webp'];
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WAVE') return ['audio/wav'];
  if (ascii(data, 0, 5) === '%PDF-') return ['application/pdf'];
  if (ascii(data, 0, 4) === 'OggS') return ['audio/ogg'];
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    // EBML; the DocType near the start must be "webm" (Matroska .mkv is not allowed).
    return ascii(data, 0, 64).includes('webm') ? ['video/webm', 'audio/webm'] : [];
  }
  if (ascii(data, 4, 8) === 'ftyp') {
    const brand = ascii(data, 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ') return ['audio/mp4'];
    if (['qt  '].includes(brand)) return [];
    return ['video/mp4', 'audio/mp4'];
  }
  if (ascii(data, 0, 3) === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) {
    return ['audio/mpeg'];
  }
  if (data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    // Office Open XML: the ZIP's file list (stored uncompressed) names its parts.
    const listing = ascii(data, 0, data.length);
    if (!listing.includes('[Content_Types].xml')) return [];
    return Object.entries(OFFICE_FOLDERS)
      .filter(([, folder]) => listing.includes(folder))
      .map(([contentType]) => contentType);
  }
  if (isPlainText(data)) return ['text/plain', 'text/csv'];
  return [];
}

/** Valid UTF-8 without NUL or other control characters (tabs and line breaks allowed). */
function isPlainText(data) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

/**
 * A safe display name: no folders, no control or bidi-override characters, at most 255
 * characters. It is only ever shown to people; storage keys are generated separately.
 */
export function sanitizeFileName(name) {
  const base = String(name ?? '')
    .normalize('NFC')
    .split(/[/\\]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩"<>|:*?]/g, '')
    .trim()
    .replace(/^\.+/, '');
  const safe = base || 'file';
  if (safe.length <= LIMITS.attachmentFileNameMaxLength) return safe;
  const dot = safe.lastIndexOf('.');
  const extension = dot > 0 ? safe.slice(dot) : '';
  return safe.slice(0, LIMITS.attachmentFileNameMaxLength - extension.length) + extension;
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Validates an uploaded file against the allowlist and returns what will be stored:
 * 1. size between 1 byte and 5 MB;
 * 2. the real type is detected from the content (signature);
 * 3. the file name's extension must belong to that type;
 * 4. the browser's declared MIME type, if specific, must agree (spoofing is rejected);
 * 5. images must decode; JPEG/PNG/WebP are re-encoded, which drops EXIF/GPS metadata and any
 *    data appended after the image.
 *
 * @param {{ buffer: Buffer, originalname: string, mimetype: string }} file
 * @param {{ kind?: 'voice' }} [options]
 */
export async function inspectUpload(file, { kind: requestedKind } = {}) {
  if (!file?.buffer?.length) throw AppError.badRequest('Choose a file to upload.');
  if (file.buffer.length > ATTACHMENT_MAX_BYTES) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Files must be 5 MB or smaller.');
  }
  const name = sanitizeFileName(file.originalname);
  const extension = extensionOf(name);
  const candidates = detectContentTypes(file.buffer);
  const matching = ATTACHMENT_TYPES.filter(
    (type) => candidates.includes(type.contentType) && type.extensions.includes(extension),
  );
  const preferred =
    requestedKind === 'voice' ? matching.filter((type) => type.kind === 'audio') : matching;
  const type = preferred[0];
  if (!type) throw unsupported();

  const claimed = String(file.mimetype ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (
    !GENERIC_MIME.has(claimed) &&
    claimed !== type.contentType &&
    !type.aliases.includes(claimed)
  ) {
    throw unsupported();
  }

  let buffer = file.buffer;
  let width = null;
  let height = null;
  if (type.kind === 'image') {
    const options = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: true };
    let metadata;
    try {
      metadata = await sharp(buffer, options).metadata();
    } catch {
      throw invalidFile();
    }
    if (metadata.format !== (REENCODE[type.contentType] ?? 'gif')) throw invalidFile();
    if (REENCODE[type.contentType]) {
      try {
        const output = await sharp(buffer, {
          ...options,
          animated: type.contentType === 'image/webp',
        })
          .rotate()
          .toFormat(REENCODE[type.contentType], { quality: 88 })
          .toBuffer({ resolveWithObject: true });
        buffer = output.data;
        width = output.info.width;
        height = output.info.pageHeight ?? output.info.height;
      } catch {
        throw invalidFile();
      }
      if (buffer.length > ATTACHMENT_MAX_BYTES) {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Files must be 5 MB or smaller.');
      }
    } else {
      width = metadata.width ?? null;
      height = metadata.pageHeight ?? metadata.height ?? null;
    }
  }

  return {
    buffer,
    size: buffer.length,
    contentType: type.contentType,
    kind: requestedKind === 'voice' ? 'voice' : type.kind,
    originalName: name,
    width,
    height,
  };
}
