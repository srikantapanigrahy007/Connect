/*
 * Product rules for message actions and attachments (Phase 7), shared by the API and every
 * client. The API enforces all of them; clients use them to show the right controls.
 */

/** The fixed reaction set. Each person has at most one reaction per message (a new one replaces it). */
export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** At most this many pinned messages per conversation. Either participant may pin or unpin. */
export const PINNED_MESSAGES_LIMIT = 3;

/** The controlled sticker catalog: messages store only the sticker id. */
export const STICKERS = [
  { id: 'wave', label: 'Waving hand', emoji: '👋' },
  { id: 'heart', label: 'Heart', emoji: '💜' },
  { id: 'party', label: 'Party popper', emoji: '🎉' },
  { id: 'thumbs-up', label: 'Thumbs up', emoji: '👍' },
  { id: 'laugh', label: 'Tears of joy', emoji: '😂' },
  { id: 'cool', label: 'Cool', emoji: '😎' },
  { id: 'think', label: 'Thinking', emoji: '🤔' },
  { id: 'clap', label: 'Clapping', emoji: '👏' },
  { id: 'fire', label: 'Fire', emoji: '🔥' },
  { id: 'coffee', label: 'Coffee', emoji: '☕' },
  { id: 'sparkles', label: 'Sparkles', emoji: '✨' },
  { id: 'sleep', label: 'Sleeping', emoji: '😴' },
];
export const STICKER_IDS = STICKERS.map((sticker) => sticker.id);

/** Every attachment is at most 5 MB. The API is authoritative; clients check first to save time. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** "voice" is a recorded audio message; it is stored and validated like other audio. */
export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'voice', 'document'];

/**
 * The allowlist. The API detects the real type from the file's content (signature) and then
 * requires the file name's extension to belong to that type, and the browser-declared MIME type
 * to be one of `aliases` (or empty / application/octet-stream, which browsers send for some
 * documents). Anything else is rejected.
 */
export const ATTACHMENT_TYPES = [
  {
    contentType: 'image/jpeg',
    kind: 'image',
    extensions: ['.jpg', '.jpeg'],
    aliases: ['image/jpg'],
  },
  { contentType: 'image/png', kind: 'image', extensions: ['.png'], aliases: [] },
  { contentType: 'image/webp', kind: 'image', extensions: ['.webp'], aliases: [] },
  { contentType: 'image/gif', kind: 'image', extensions: ['.gif'], aliases: [] },
  { contentType: 'video/mp4', kind: 'video', extensions: ['.mp4', '.m4v'], aliases: [] },
  { contentType: 'video/webm', kind: 'video', extensions: ['.webm'], aliases: [] },
  { contentType: 'audio/mpeg', kind: 'audio', extensions: ['.mp3'], aliases: ['audio/mp3'] },
  {
    contentType: 'audio/mp4',
    kind: 'audio',
    extensions: ['.m4a', '.mp4', '.aac'],
    aliases: ['audio/x-m4a', 'audio/aac', 'video/mp4'],
  },
  { contentType: 'audio/ogg', kind: 'audio', extensions: ['.ogg', '.oga', '.opus'], aliases: [] },
  {
    contentType: 'audio/webm',
    kind: 'audio',
    extensions: ['.webm', '.weba'],
    aliases: ['video/webm'],
  },
  {
    contentType: 'audio/wav',
    kind: 'audio',
    extensions: ['.wav'],
    aliases: ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  },
  { contentType: 'application/pdf', kind: 'document', extensions: ['.pdf'], aliases: [] },
  { contentType: 'text/plain', kind: 'document', extensions: ['.txt'], aliases: [] },
  {
    contentType: 'text/csv',
    kind: 'document',
    extensions: ['.csv'],
    aliases: ['application/vnd.ms-excel', 'text/plain'],
  },
  {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
    extensions: ['.docx'],
    aliases: ['application/zip'],
  },
  {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'document',
    extensions: ['.xlsx'],
    aliases: ['application/zip'],
  },
  {
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'document',
    extensions: ['.pptx'],
    aliases: ['application/zip'],
  },
];

/** Extensions offered by the attachment picker (the `accept` attribute). */
export const ATTACHMENT_EXTENSIONS = [
  ...new Set(ATTACHMENT_TYPES.flatMap((type) => type.extensions)),
];
