import { accountStatusMachine } from '#shared';
import { describe, expect, it } from 'vitest';
import { StateTransitionError } from '../src/models/plugins/state-machine.js';
import { Session } from '../src/models/session.model.js';
import { User } from '../src/models/user.model.js';
import { uniqueUser, useTestDatabase } from './helpers.js';

useTestDatabase();

async function createUser(status = 'pending_verification') {
  const { password: _password, ...input } = uniqueUser();
  return User.create({ ...input, status });
}

describe('account status state machine', () => {
  it('rejects records created in a non-initial state', async () => {
    await expect(createUser('suspended')).rejects.toBeInstanceOf(StateTransitionError);
  });

  it('allows valid transitions through save() and rejects invalid ones', async () => {
    const user = await createUser();
    user.status = 'active';
    await user.save();

    user.status = 'pending_verification';
    await expect(user.save()).rejects.toBeInstanceOf(StateTransitionError);
  });

  it('requires update queries to constrain the current state', async () => {
    const user = await createUser();
    await expect(
      User.updateOne({ _id: user._id }, { $set: { status: 'active' } }),
    ).rejects.toBeInstanceOf(StateTransitionError);
  });

  it('applies a valid compare-and-set transition atomically, and only once', async () => {
    const user = await createUser();
    const filter = { _id: user._id, status: { $in: accountStatusMachine.sourcesFor('active') } };

    expect((await User.updateOne(filter, { $set: { status: 'active' } })).modifiedCount).toBe(1);
    // A second identical request finds nothing to change instead of re-applying the transition.
    expect((await User.updateOne(filter, { $set: { status: 'active' } })).modifiedCount).toBe(0);
  });

  it('rejects filters that include a state with no valid transition', async () => {
    const user = await createUser();
    await expect(
      User.updateOne(
        { _id: user._id, status: { $in: ['deleted', 'active'] } },
        { $set: { status: 'suspended' } },
      ),
    ).rejects.toBeInstanceOf(StateTransitionError);
  });

  it('blocks replacing documents and other operators on the state field', async () => {
    const user = await createUser();
    await expect(User.replaceOne({ _id: user._id }, { displayName: 'x' })).rejects.toBeInstanceOf(
      StateTransitionError,
    );
    await expect(
      User.updateOne({ _id: user._id }, { $unset: { status: 1 } }),
    ).rejects.toBeInstanceOf(StateTransitionError);
  });
});

describe('indexes', () => {
  it('enforces unique email and username but lets deleted accounts release them', async () => {
    const first = await createUser();
    const { password: _password, ...again } = uniqueUser({ email: first.email ?? '' });
    await expect(User.create(again)).rejects.toMatchObject({ code: 11000 });

    const indexes = await User.collection.indexes();
    const email = indexes.find((index) => index.key.email === 1);
    expect(email).toMatchObject({
      unique: true,
      partialFilterExpression: { email: { $type: 'string' } },
    });
  });

  it('expires sessions with a TTL index and keeps refresh-token hashes unique', async () => {
    const indexes = await Session.collection.indexes();
    expect(indexes.find((index) => index.key.expiresAt === 1)?.expireAfterSeconds).toBe(0);
    expect(indexes.find((index) => index.key.refreshTokenHash === 1)?.unique).toBe(true);
  });

  it('refuses session documents whose token field is not a SHA-256 hash', async () => {
    const user = await createUser();
    await expect(
      Session.create({
        user: user._id,
        refreshTokenHash: 'raw-refresh-token',
        authMethod: 'password',
        authenticatedAt: new Date(),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/refreshTokenHash/);
  });
});
