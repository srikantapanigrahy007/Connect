import { model, Schema } from 'mongoose';

/**
 * Two people who may talk without a request. Created when a message request is accepted.
 * A block always takes precedence over a connection.
 */
const connectionSchema = new Schema(
  {
    pairKey: { type: String, required: true },
    users: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      validate: { validator: (users) => users.length === 2, message: 'A connection has two users' },
    },
    /** The accepted request that created this connection. */
    request: { type: Schema.Types.ObjectId, ref: 'MessageRequest', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

connectionSchema.index({ pairKey: 1 }, { unique: true });
connectionSchema.index({ users: 1 });

export const Connection = model('Connection', connectionSchema);
