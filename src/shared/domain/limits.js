/** Product limits shared by validation on the API and every client. */
export const LIMITS = {
  bioMaxLength: 160,
  avatarMaxBytes: 5 * 1024 * 1024,
  /** Avatars are re-encoded to a square WebP of this size. */
  avatarSizePx: 512,
  messageTextMaxLength: 4_000,
  /** Base64 ciphertext; leaves room for the encrypted equivalent of the longest text message. */
  messageCiphertextMaxLength: 16_384,
  messageRequestNoteMaxLength: 300,
  groupNameMaxLength: 60,
  groupDescriptionMaxLength: 200,
  groupMaxMembers: 256,
  pollQuestionMaxLength: 300,
  pollOptionTextMaxLength: 100,
  pollMinOptions: 2,
  pollMaxOptions: 12,
  reactionEmojiMaxLength: 32,
  reportDetailsMaxLength: 1_000,
  reportEvidenceMaxLength: 4_000,
  /** Per file (the same as ATTACHMENT_MAX_BYTES). */
  attachmentMaxBytes: 5 * 1024 * 1024,
  attachmentFileNameMaxLength: 255,
  pageSizeDefault: 30,
  pageSizeMax: 100,
};

/** Image types accepted for avatars. The API also checks the file's actual content. */
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
