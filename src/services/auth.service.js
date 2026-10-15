import { accountStatusMachine } from '#shared';

import { AuthToken } from '../models/auth-token.model.js';
import { MessageRequest } from '../models/message-request.model.js';
import { Notification } from '../models/notification.model.js';
import { Session } from '../models/session.model.js';
import { User } from '../models/user.model.js';
import {
  hashPassword,
  passwordNeedsRehash,
  simulatePasswordCheck,
  verifyPassword,
} from '../security/password.js';
import { generateToken, hashToken } from '../security/tokens.js';
import { AppError } from '../utils/app-error.js';

import { emails } from './mailer.js';
import { avatarUrlOf } from './user-dto.js';

const TOKEN_TTL_MS = {
  email_verification: 24 * 60 * 60_000,
  password_reset: 30 * 60_000,
};

/** Suspended and banned accounts can't sign in (checked after the password, so no enumeration). */
function assertNotModerated(user) {
  if (user.status === 'suspended') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended.');
  }
  if (user.status === 'banned') {
    throw new AppError(403, 'ACCOUNT_BANNED', 'This account has been banned.');
  }
}

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
const invalidLink = () =>
  new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired. Request a new one.');

/**
 * A Google account whose email Google has verified.
 *
 * @typedef {object} GoogleIdentity
 * @property {string} sub Google's stable account id.
 * @property {string} email Lowercased.
 * @property {string | null} name
 */

/** Converts a user document into the public `AuthUser` shape (see authUserSchema in #shared). */
export function toAuthUser(user) {
  return {
    id: String(user._id),
    username: user.username ?? '',
    displayName: user.displayName,
    email: user.email ?? '',
    emailVerified: user.emailVerifiedAt !== null && user.emailVerifiedAt !== undefined,
    status: user.status,
    role: user.role,
    hasPassword: Boolean(user.passwordHash),
    googleLinked: Boolean(user.googleId),
    avatarUrl: avatarUrlOf(user),
    createdAt: user.createdAt.toISOString(),
  };
}

export function createAuthService(deps) {
  const { config, logger, mailer, sessions, storage, settings, groups, e2ee } = deps;

  /** New accounts can be turned off by a Super Admin (platform setting). */
  async function requireRegistrationOpen() {
    if (settings && !(await settings.get()).registrationEnabled) {
      throw new AppError(403, 'REGISTRATION_DISABLED', 'New registrations are paused right now.');
    }
  }

  /** Loads a user including whether a password exists (never the hash itself to callers). */
  async function loadUser(userId) {
    const user = await User.findById(userId).select('+passwordHash').lean();
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Please sign in to continue');
    return user;
  }

  async function buildSession(userId, sessionId, accessTokenExpiresAt) {
    const user = await loadUser(userId);
    const session = await Session.findById(sessionId).lean();
    if (!session) throw new AppError(401, 'SESSION_INVALID', 'Please sign in again.');
    return {
      user: toAuthUser(user),
      session: {
        id: sessionId,
        authMethod: session.authMethod,
        authenticatedAt: session.authenticatedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      },
    };
  }

  async function issueEmailToken(userId, purpose) {
    // Only the newest link of each kind works.
    await AuthToken.deleteMany({ user: userId, purpose, usedAt: null });
    const token = generateToken();
    await AuthToken.create({
      user: userId,
      purpose,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS[purpose]),
    });
    return token;
  }

  /** Atomically marks a token used; returns its user id or throws INVALID_TOKEN. */
  async function consumeEmailToken(token, purpose) {
    const record = await AuthToken.findOneAndUpdate(
      { tokenHash: hashToken(token), purpose, usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
    ).lean();
    if (!record) throw invalidLink();
    return String(record.user);
  }

  function sendInBackground(message, what) {
    mailer.send(message).catch((error) => {
      logger.error(`Failed to send ${what} email`, { error });
    });
  }

  async function sendVerificationEmail(user) {
    if (!user.email) return;
    const token = await issueEmailToken(String(user._id), 'email_verification');
    sendInBackground(
      emails.verifyEmail(user.email, `${config.webAppUrl}/verify-email?token=${token}`),
      'verification',
    );
  }

  /** Moves pending/deactivated accounts to active and records email verification. */
  async function activate(userId, { verifyEmail }) {
    const now = new Date();
    if (verifyEmail) {
      await User.updateOne(
        { _id: userId, emailVerifiedAt: null },
        { $set: { emailVerifiedAt: now } },
      );
    }
    await User.updateOne(
      {
        _id: userId,
        status: {
          $in: accountStatusMachine
            .sourcesFor('active')
            .filter((s) => s !== 'suspended' && s !== 'banned'),
        },
        ...(verifyEmail ? {} : { emailVerifiedAt: { $ne: null } }),
      },
      { $set: { status: 'active' } },
    );
  }

  async function generateUsername(email) {
    const local = email.split('@')[0] ?? '';
    let base = local
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^[^a-z]+/, '')
      .slice(0, 20);
    if (base.length < 3) base = `user${base}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate =
        attempt === 0 ? base : `${base}_${Math.floor(1_000 + Math.random() * 9_000)}`;
      if (!(await User.exists({ username: candidate }))) return candidate;
    }
    return `user_${generateToken(9)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')}`.slice(0, 30);
  }

  return {
    /** The response body for a newly issued session. */
    buildSession: (issued) =>
      buildSession(issued.userId, issued.sessionId, issued.accessTokenExpiresAt),

    /** The current user and session, read fresh from the database. */
    describe: (context) =>
      buildSession(context.userId, context.sessionId, context.accessTokenExpiresAt),

    async register(input, meta) {
      await requireRegistrationOpen();
      const [emailTaken, usernameTaken] = await Promise.all([
        User.exists({ email: input.email }),
        User.exists({ username: input.username }),
      ]);
      if (emailTaken || usernameTaken) {
        throw new AppError(409, 'CONFLICT', 'Some details are already in use.', [
          ...(emailTaken
            ? [{ path: 'email', message: 'An account with this email already exists' }]
            : []),
          ...(usernameTaken ? [{ path: 'username', message: 'This username is taken' }] : []),
        ]);
      }
      const user = await User.create({
        email: input.email,
        username: input.username,
        displayName: input.displayName,
        passwordHash: await hashPassword(input.password),
        passwordChangedAt: new Date(),
        status: 'pending_verification',
      });
      await sendVerificationEmail(user.toObject());
      return sessions.start({ userId: String(user._id), authMethod: 'password', meta });
    },

    async login(input, meta) {
      const user = await User.findOne({ email: input.email }).select('+passwordHash').lean();
      if (!user?.passwordHash || user.status === 'deleted') {
        await simulatePasswordCheck(input.password);
        throw invalidCredentials();
      }
      if (!(await verifyPassword(user.passwordHash, input.password))) throw invalidCredentials();
      assertNotModerated(user);
      const userId = String(user._id);
      if (user.status === 'deactivated') await activate(userId, { verifyEmail: false });
      if (passwordNeedsRehash(user.passwordHash)) {
        await User.updateOne(
          { _id: userId },
          { $set: { passwordHash: await hashPassword(input.password) } },
        );
      }
      return sessions.start({ userId, authMethod: 'password', meta });
    },

    /** Sign-in or sign-up with a Google identity whose email Google has verified. */
    /**
     * Signs in with a Google identity (sub + a Google-verified email; see google-oauth.service.js).
     * 1. An account already linked to this `sub` signs in.
     * 2. Otherwise an account with the same email is linked, unless it's already linked to a
     *    different Google account (GOOGLE_ACCOUNT_CONFLICT: never silently re-linked). Linking is
     *    a conditional update, so two sign-ins at once can't link two different Google accounts.
     *    If that account's email was never verified, someone registered it without proving
     *    ownership: its password and sessions are dropped (pre-account-hijacking defence).
     * 3. Otherwise a new, verified account is created; a concurrent first sign-in that wins the
     *    unique email/googleId index is picked up by looking again.
     * Suspended and banned accounts are refused before anything is changed.
     */
    async loginWithGoogle(identity, meta) {
      const conflict = () =>
        new AppError(
          409,
          'GOOGLE_ACCOUNT_CONFLICT',
          'This email belongs to an account linked to a different Google account.',
        );
      let user = null;
      for (let attempt = 0; attempt < 2 && !user; attempt++) {
        user = await User.findOne({ googleId: identity.sub }).lean();
        if (user) break;
        const byEmail = await User.findOne({ email: identity.email })
          .select('+passwordHash')
          .lean();
        if (byEmail) {
          if (byEmail.status === 'deleted') throw invalidCredentials();
          assertNotModerated(byEmail);
          if (byEmail.googleId && byEmail.googleId !== identity.sub) throw conflict();
          const userId = String(byEmail._id);
          const linked = await User.updateOne(
            { _id: userId, googleId: null },
            { $set: { googleId: identity.sub } },
          );
          if (linked.modifiedCount === 0) {
            // Linked meanwhile: fine if it was this Google account, refused otherwise.
            const current = await User.findById(userId, { googleId: 1 }).lean();
            if (current?.googleId !== identity.sub) throw conflict();
          } else if (!byEmail.emailVerifiedAt) {
            await sessions.revokeAll(userId, 'account_secured');
            await User.updateOne({ _id: userId }, { $set: { passwordHash: null } });
          }
          user = await User.findById(userId).lean();
          break;
        }
        await requireRegistrationOpen();
        try {
          const created = await User.create({
            email: identity.email,
            username: await generateUsername(identity.email),
            displayName: (identity.name ?? identity.email.split('@')[0] ?? 'New user').slice(0, 50),
            googleId: identity.sub,
            emailVerifiedAt: new Date(),
            status: 'active',
          });
          user = created.toObject();
        } catch (error) {
          // Another sign-in created it (or took the username) at the same moment: look again.
          if (error?.code !== 11000 || attempt > 0) throw error;
        }
      }
      if (!user || user.status === 'deleted') throw invalidCredentials();
      assertNotModerated(user);
      await activate(String(user._id), { verifyEmail: true });
      return sessions.start({ userId: String(user._id), authMethod: 'google', meta });
    },

    async verifyEmail(token) {
      const userId = await consumeEmailToken(token, 'email_verification');
      await activate(userId, { verifyEmail: true });
    },

    async resendVerification(auth) {
      const user = await loadUser(auth.userId);
      if (user.emailVerifiedAt) return;
      await sendVerificationEmail(user);
    },

    /**
     * Always resolves the same way and never awaits account-dependent work, so neither the
     * response nor its timing reveals whether the email is registered.
     */
    requestPasswordReset(email) {
      const work = async () => {
        const user = await User.findOne({ email, status: { $ne: 'deleted' } }).lean();
        if (!user || ['suspended', 'banned'].includes(user.status) || !user.email) return;
        const token = await issueEmailToken(String(user._id), 'password_reset');
        await mailer.send(
          emails.resetPassword(user.email, `${config.webAppUrl}/reset-password?token=${token}`),
        );
      };
      setImmediate(() => {
        work().catch((error) => logger.error('Password reset email failed', { error }));
      });
      return Promise.resolve();
    },

    /** Sets a new password from an email link and signs the account out everywhere. */
    async resetPassword(token, password) {
      const userId = await consumeEmailToken(token, 'password_reset');
      await User.updateOne(
        { _id: userId },
        { $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date() } },
      );
      await AuthToken.deleteMany({ user: userId, purpose: 'password_reset', usedAt: null });
      // Opening the link proved control of the mailbox.
      await activate(userId, { verifyEmail: true });
      await sessions.revokeAll(userId, 'password_reset');
      const user = await loadUser(userId);
      if (user.email) sendInBackground(emails.passwordChanged(user.email), 'password changed');
    },

    /**
     * Changes (or, for Google-only accounts, sets) the password. Requires the current password,
     * or a recent re-authentication when the account has none. Every session is revoked and a
     * fresh one is issued for this device.
     */
    async changePassword(auth, input, meta) {
      const user = await loadUser(auth.userId);
      if (user.passwordHash) {
        if (
          !input.currentPassword ||
          !(await verifyPassword(user.passwordHash, input.currentPassword))
        ) {
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Your current password is incorrect.', [
            { path: 'currentPassword', message: 'Your current password is incorrect' },
          ]);
        }
      } else if (
        Date.now() - auth.session.authenticatedAt.getTime() >
        config.auth.recentAuthMaxAgeMs
      ) {
        throw new AppError(403, 'REAUTHENTICATION_REQUIRED', 'Confirm it’s you to set a password.');
      }
      await User.updateOne(
        { _id: auth.userId },
        {
          $set: {
            passwordHash: await hashPassword(input.newPassword),
            passwordChangedAt: new Date(),
          },
        },
      );
      // Every session is revoked, including this device's old one. This device immediately gets a
      // new session below, so its old socket is closed without a "you were signed out" notice.
      await sessions.revokeAll(auth.userId, 'password_changed', {
        silentSessionIds: [auth.sessionId],
      });
      if (user.email) sendInBackground(emails.passwordChanged(user.email), 'password changed');
      return sessions.start({
        userId: auth.userId,
        authMethod: auth.session.authMethod,
        meta,
      });
    },

    async reauthenticateWithPassword(auth, password) {
      const user = await loadUser(auth.userId);
      if (!user.passwordHash) {
        throw new AppError(
          400,
          'BAD_REQUEST',
          'This account has no password. Confirm with Google instead.',
        );
      }
      if (!(await verifyPassword(user.passwordHash, password))) throw invalidCredentials();
      await sessions.markAuthenticated(auth.sessionId);
    },

    /**
     * Deletes the account: personal data is scrubbed (the record stays so references remain
     * valid), every session is revoked and outstanding email links are invalidated.
     */
    async deleteAccount(auth) {
      const deleted = await User.updateOne(
        { _id: auth.userId, status: { $in: accountStatusMachine.sourcesFor('deleted') } },
        {
          $set: {
            status: 'deleted',
            deletedAt: new Date(),
            email: null,
            username: null,
            displayName: 'Deleted user',
            passwordHash: null,
            googleId: null,
            emailVerifiedAt: null,
            bio: '',
            avatar: null,
            lastSeenAt: null,
          },
        },
      );
      if (deleted.modifiedCount !== 1) {
        throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This account is already deleted.');
      }
      await AuthToken.deleteMany({ user: auth.userId });
      await sessions.revokeAll(auth.userId, 'account_deleted');
      // Pending requests to or from a deleted account can never be answered.
      await MessageRequest.updateMany(
        { $or: [{ sender: auth.userId }, { recipient: auth.userId }], status: 'pending' },
        { $set: { status: 'cancelled', respondedAt: new Date() } },
      );
      // Your notifications go with the account; entries you caused for other people no longer
      // show who you were (a deleted account is never shown as the actor).
      await Notification.deleteMany({ recipient: auth.userId });
      // Leave every group (ownership passes on), so groups keep working without this account.
      await groups?.removeDeletedAccount(auth.userId);
      // Encryption devices (public keys) go with the account.
      await e2ee?.removeAllFor(auth.userId);
      const avatarKey = auth.user.avatar?.key;
      if (avatarKey) {
        await storage.remove(avatarKey).catch((error) => {
          logger.warn('Could not delete avatar of deleted account', { error });
        });
      }
    },
  };
}
