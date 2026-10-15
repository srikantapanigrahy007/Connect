import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/audit-log.model.js';
import { Session } from '../src/models/session.model.js';
import { User } from '../src/models/user.model.js';
import { bootstrapSuperAdmin, BootstrapError } from '../src/services/admin-bootstrap.js';
import {
  connect,
  signedInUser,
  startTestServer,
  TestClient,
  uniqueUser,
  useTestDatabase,
} from './helpers.js';
import { createGroup, ownerWithFriends } from './group-helpers.js';
import { httpSend, newMessage, openSocket, waitForDisconnect } from './messaging-helpers.js';

useTestDatabase();

let server;
const sockets = [];
beforeAll(async () => {
  server = await startTestServer();
});
beforeEach(() => {
  server.services.settings.reset();
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await server.close();
});

/**
 * Test setup only: writes straight to the collection (the model's state machine rightly refuses
 * unguarded status changes, and the bootstrap/admin APIs are what's under test).
 */
const setUser = (id, fields) =>
  User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: fields });

/** A signed-in user with an admin role (set in the database, like the bootstrap does). */
async function adminWith(role) {
  const person = await signedInUser(server.baseUrl);
  await setUser(person.user.id, { role, status: 'active', emailVerifiedAt: new Date() });
  return person;
}

const reason = { reason: 'Test moderation reason' };
const post = (who, path, body = reason) => who.client.post(`/admin${path}`, body);

describe('normal users and anonymous visitors', () => {
  it('are denied every admin endpoint', async () => {
    const normal = await signedInUser(server.baseUrl);
    const id = normal.user.id;
    const calls = [
      ['get', '/admin/dashboard'],
      ['get', '/admin/system'],
      ['get', '/admin/users'],
      ['get', `/admin/users/${id}`],
      ['post', `/admin/users/${id}/suspend`, reason],
      ['post', `/admin/users/${id}/ban`, reason],
      ['post', `/admin/users/${id}/revoke-sessions`, reason],
      ['get', '/admin/groups'],
      ['get', `/admin/groups/${id}`],
      ['post', `/admin/groups/${id}/suspend`, reason],
      ['get', '/admin/reports'],
      ['patch', `/admin/reports/${id}`, { status: 'under_review' }],
      ['get', '/admin/roles'],
      ['put', `/admin/roles/${id}`, { role: 'super_admin', reason: 'self escalation' }],
      ['get', '/admin/audit'],
      ['get', '/admin/settings'],
      ['put', '/admin/settings', { registrationEnabled: false, reason: 'x x x' }],
    ];
    for (const [method, path, body] of calls) {
      const res =
        method === 'get'
          ? await normal.client.get(path)
          : await normal.client.send(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    const anonymous = new TestClient(server.baseUrl);
    expect((await anonymous.get('/admin/dashboard')).status).toBe(401);
    expect((await normal.client.get('/admin/me')).body.data).toEqual({
      role: null,
      permissions: [],
    });
    expect((await User.findById(id).lean()).role).toBe('user');
  });

  it('cannot gain a role through registration or profile updates', async () => {
    const client = new TestClient(server.baseUrl);
    const res = await client.post('/auth/register', { ...uniqueUser(), role: 'super_admin' });
    expect(res.status).toBe(201);
    expect((await User.findById(res.body.data.user.id).lean()).role).toBe('user');
    expect((await client.patch('/me/profile', { role: 'super_admin' })).status).toBe(400);
  });
});

describe('Super Admin bootstrap', () => {
  it('promotes an existing verified account once, server-side, and audits it', async () => {
    await User.updateMany({ role: { $ne: 'user' } }, { $set: { role: 'user' } });
    const person = await signedInUser(server.baseUrl);
    await expect(bootstrapSuperAdmin({ email: person.user.email })).rejects.toBeInstanceOf(
      BootstrapError,
    ); // not verified yet
    await setUser(person.user.id, { status: 'active', emailVerifiedAt: new Date() });
    const result = await bootstrapSuperAdmin({ email: person.user.email.toUpperCase() });
    expect(result.userId).toBe(person.user.id);
    expect((await User.findById(person.user.id).lean()).role).toBe('super_admin');
    expect(
      await AuditLog.exists({ action: 'admin.bootstrap', targetId: person.user.id }),
    ).toBeTruthy();

    // A second bootstrap is refused unless it's an explicit recovery.
    const other = await adminWith('user');
    await expect(bootstrapSuperAdmin({ email: other.user.email })).rejects.toThrow(
      /already exists/,
    );
    await bootstrapSuperAdmin({ email: other.user.email, force: true });
    expect((await User.findById(other.user.id).lean()).role).toBe('super_admin');
  });
});

describe('role-based access', () => {
  it('each admin role gets exactly its permissions', async () => {
    const target = await signedInUser(server.baseUrl);
    const expectations = {
      support: {
        dashboard: 200,
        users: 200,
        sessions: 200,
        moderate: 403,
        groups: 403,
        reports: 403,
        roles: 403,
        audit: 403,
        settings: 403,
      },
      moderator: {
        dashboard: 200,
        users: 200,
        sessions: 200,
        moderate: 200,
        groups: 200,
        reports: 200,
        roles: 403,
        audit: 403,
        settings: 403,
      },
      super_admin: {
        dashboard: 200,
        users: 200,
        sessions: 200,
        moderate: 200,
        groups: 200,
        reports: 200,
        roles: 200,
        audit: 200,
        settings: 200,
      },
    };
    for (const [role, expected] of Object.entries(expectations)) {
      const admin = await adminWith(role);
      await setUser(target.user.id, { status: 'active' });
      const actual = {
        dashboard: (await admin.client.get('/admin/dashboard')).status,
        users: (await admin.client.get('/admin/users')).status,
        sessions: (await post(admin, `/users/${target.user.id}/revoke-sessions`)).status,
        moderate: (await post(admin, `/users/${target.user.id}/suspend`)).status,
        groups: (await admin.client.get('/admin/groups')).status,
        reports: (await admin.client.get('/admin/reports')).status,
        roles: (await admin.client.get('/admin/roles')).status,
        audit: (await admin.client.get('/admin/audit')).status,
        settings: (await admin.client.get('/admin/settings')).status,
      };
      expect(actual, role).toEqual(expected);
      const me = (await admin.client.get('/admin/me')).body.data;
      expect(me.role).toBe(role);
    }
  });

  it('a demoted admin loses access on the very next request', async () => {
    const boss = await adminWith('super_admin');
    const moderator = await adminWith('moderator');
    expect((await moderator.client.get('/admin/reports')).status).toBe(200);
    await boss.client.send('put', `/admin/roles/${moderator.user.id}`, {
      role: 'user',
      reason: 'No longer on the team',
    });
    expect((await moderator.client.get('/admin/reports')).status).toBe(403);
  });
});

describe('user moderation', () => {
  it('suspends (sessions and sockets end), restores, bans and unbans with reasons and audit', async () => {
    const moderator = await adminWith('moderator');
    const target = await signedInUser(server.baseUrl);
    const socket = await openSocket(server, target, sockets);
    const closed = waitForDisconnect(socket);

    expect((await post(moderator, `/users/${target.user.id}/suspend`, {})).status).toBe(400);
    const suspended = await post(moderator, `/users/${target.user.id}/suspend`);
    expect(suspended.body.data).toMatchObject({ status: 'suspended', activeSessions: 0 });
    await closed;
    expect((await target.client.get('/me/profile')).status).toBe(401);
    const login = await new TestClient(server.baseUrl).post('/auth/login', {
      email: target.user.email,
      password: target.user.password,
    });
    expect(login.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await post(moderator, `/users/${target.user.id}/suspend`)).status).toBe(409);

    const restored = await post(moderator, `/users/${target.user.id}/restore`);
    expect(restored.body.data.status).toBe('pending_verification'); // email never verified
    const ban = await post(moderator, `/users/${target.user.id}/ban`);
    expect(ban.body.data.status).toBe('banned');
    const bannedLogin = await new TestClient(server.baseUrl).post('/auth/login', {
      email: target.user.email,
      password: target.user.password,
    });
    expect(bannedLogin.body.error.code).toBe('ACCOUNT_BANNED');
    expect((await post(moderator, `/users/${target.user.id}/unban`)).body.data.status).toBe(
      'pending_verification',
    );

    const history = (await moderator.client.get(`/admin/users/${target.user.id}`)).body.data
      .history;
    expect(history.map((entry) => entry.action)).toEqual([
      'user.unban',
      'user.ban',
      'user.restore',
      'user.suspend',
    ]);
    expect(history[3]).toMatchObject({
      reason: 'Test moderation reason',
      outcome: 'success',
      actorRole: 'moderator',
    });
    // Never exposes credentials.
    const details = await moderator.client.get(`/admin/users/${target.user.id}`);
    expect(JSON.stringify(details.body)).not.toMatch(/passwordHash|refreshToken|argon2/);
  });

  it('bans need a recent sign-in', async () => {
    const moderator = await adminWith('moderator');
    const target = await signedInUser(server.baseUrl);
    await Session.updateMany(
      { user: moderator.user.id },
      { $set: { authenticatedAt: new Date(Date.now() - 60 * 60_000) } },
    );
    const res = await post(moderator, `/users/${target.user.id}/ban`);
    expect(res.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    // Suspension (reversible) doesn't.
    expect((await post(moderator, `/users/${target.user.id}/suspend`)).status).toBe(200);
  });

  it('protects admins: no self-moderation, and only Super Admins act on admins', async () => {
    const moderator = await adminWith('moderator');
    const support = await adminWith('support');
    expect((await post(moderator, `/users/${moderator.user.id}/suspend`)).status).toBe(403);
    expect((await post(support, `/users/${moderator.user.id}/revoke-sessions`)).status).toBe(403);
    expect((await post(moderator, `/users/${support.user.id}/suspend`)).status).toBe(403);
  });

  it('force logout ends every session of the account', async () => {
    const support = await adminWith('support');
    const target = await signedInUser(server.baseUrl);
    const socket = await openSocket(server, target, sockets);
    const closed = waitForDisconnect(socket);
    const res = await post(support, `/users/${target.user.id}/revoke-sessions`);
    expect(res.body.data.revoked).toBe(1);
    await closed;
    expect((await target.client.get('/me/profile')).status).toBe(401);
    expect(
      await AuditLog.exists({ action: 'session.revoke', targetId: target.user.id }),
    ).toBeTruthy();
  });

  it('searches by username prefix or exact email', async () => {
    const support = await adminWith('support');
    const target = await signedInUser(server.baseUrl);
    const byName = await support.client.get(`/admin/users?q=${target.user.username}`);
    expect(byName.body.data.map((u) => u.id)).toEqual([target.user.id]);
    const byEmail = await support.client.get(
      `/admin/users?q=${encodeURIComponent(target.user.email)}`,
    );
    expect(byEmail.body.data[0]).toMatchObject({ id: target.user.id, email: target.user.email });
    const page = await support.client.get('/admin/users?limit=2');
    expect(page.body.meta.hasMore).toBe(true);
  });
});

describe('admin roles', () => {
  it('only Super Admins change roles, with a reason, never their own', async () => {
    const boss = await adminWith('super_admin');
    const moderator = await adminWith('moderator');
    const target = await signedInUser(server.baseUrl);
    const put = (who, id, body) => who.client.send('put', `/admin/roles/${id}`, body);

    const granted = await put(boss, target.user.id, { role: 'support', reason: 'Joins support' });
    expect(granted.body.data.role).toBe('support');
    expect((await put(boss, target.user.id, { role: 'support' })).status).toBe(400);
    expect(
      (await put(moderator, moderator.user.id, { role: 'super_admin', reason: 'Promote me' }))
        .status,
    ).toBe(403);
    expect((await put(boss, boss.user.id, { role: 'user', reason: 'Step down' })).status).toBe(403);
    const entry = await AuditLog.findOne({
      action: 'user.role_change',
      targetId: target.user.id,
    }).lean();
    expect(entry).toMatchObject({
      actorRole: 'super_admin',
      reason: 'Joins support',
      outcome: 'success',
      details: { from: 'user', to: 'support' },
    });
  });

  it('never leaves the platform without a working Super Admin', async () => {
    await User.updateMany({ role: { $in: ['super_admin', 'admin'] } }, { $set: { role: 'user' } });
    const a = await adminWith('super_admin');
    const b = await adminWith('super_admin');

    // Two Super Admins demoting each other at the same moment: at least one remains.
    await Promise.all([
      a.client.send('put', `/admin/roles/${b.user.id}`, { role: 'user', reason: 'Race one' }),
      b.client.send('put', `/admin/roles/${a.user.id}`, { role: 'user', reason: 'Race two' }),
    ]);
    const working = await User.countDocuments({
      role: { $in: ['super_admin', 'admin'] },
      status: 'active',
    });
    expect(working).toBeGreaterThanOrEqual(1);

    // The rule itself: removing, suspending or banning the only working Super Admin is refused
    // and the refusal is audited.
    await User.updateMany({ role: { $in: ['super_admin', 'admin'] } }, { $set: { role: 'user' } });
    const last = await adminWith('super_admin');
    const context = {
      actor: a.user.id,
      actorRole: 'super_admin',
      requestId: null,
      ipAddress: null,
    };
    const admin = server.services.admin;
    await expect(
      admin.changeRole(context, last.user.id, 'moderator', 'Rotate'),
    ).rejects.toMatchObject({
      code: 'LAST_SUPER_ADMIN',
    });
    await expect(
      admin.moderateUser(context, last.user.id, 'suspend', 'Test'),
    ).rejects.toMatchObject({
      code: 'LAST_SUPER_ADMIN',
    });
    await expect(admin.moderateUser(context, last.user.id, 'ban', 'Test')).rejects.toMatchObject({
      code: 'LAST_SUPER_ADMIN',
    });
    expect(await User.findById(last.user.id).lean()).toMatchObject({
      role: 'super_admin',
      status: 'active',
    });
    expect(await AuditLog.countDocuments({ targetId: last.user.id, outcome: 'denied' })).toBe(3);
  });
});

describe('group moderation', () => {
  it('moderators suspend (read-only), unsuspend and remove groups; support cannot', async () => {
    const moderator = await adminWith('moderator');
    const support = await adminWith('support');
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const group = await createGroup(owner, friends);
    const invite = (await owner.client.post(`/groups/${group.id}/invites`, {})).body.data;

    expect((await post(support, `/groups/${group.id}/suspend`)).status).toBe(403);
    const suspended = await post(moderator, `/groups/${group.id}/suspend`);
    expect(suspended.body.data).toMatchObject({
      status: 'suspended',
      suspendedReason: 'Test moderation reason',
    });
    expect(suspended.body.data.members).toHaveLength(2);
    expect(JSON.stringify(suspended.body.data)).not.toContain('messages');

    expect((await httpSend(owner, group.id)).status).toBe(403);
    expect((await owner.client.patch(`/groups/${group.id}`, { name: 'x' })).status).toBe(403);
    const joiner = await signedInUser(server.baseUrl);
    expect((await joiner.client.post('/group-invites/join', { token: invite.token })).status).toBe(
      403,
    );
    // History stays readable and members can still leave.
    expect((await friends[0].client.get(`/conversations/${group.id}/messages`)).status).toBe(200);
    expect(
      (await friends[0].client.get(`/conversations/${group.id}`)).body.data.group.suspended,
    ).toBe(true);

    expect((await post(moderator, `/groups/${group.id}/unsuspend`)).body.data.status).toBe(
      'active',
    );
    expect((await httpSend(owner, group.id, newMessage('back'))).status).toBe(201);

    const removed = await post(moderator, `/groups/${group.id}/remove`);
    expect(removed.body.data.status).toBe('deleted');
    expect((await owner.client.get(`/groups/${group.id}`)).status).toBe(404);
    const actions = (await AuditLog.find({ targetId: group.id }).sort({ _id: 1 }).lean()).map(
      (e) => e.action,
    );
    expect(actions).toEqual(['group.suspend', 'group.unsuspend', 'group.remove']);
  });
});

describe('reports', () => {
  it('validates targets, snapshots only chosen evidence and prevents duplicates', async () => {
    const reporter = await signedInUser(server.baseUrl);
    const offender = await signedInUser(server.baseUrl);
    await connect(reporter, offender);
    const conversation = (
      await reporter.client.post('/conversations', { userId: offender.user.id })
    ).body.data;
    const bad = (await httpSend(offender, conversation.id, newMessage('abusive text'))).body.data
      .message;
    await httpSend(offender, conversation.id, newMessage('not shared'));

    const created = await reporter.client.post('/reports', {
      targetType: 'message',
      targetId: bad.id,
      reason: 'harassment',
      details: 'Repeated insults',
    });
    expect(created.status).toBe(201);
    expect(
      (
        await reporter.client.post('/reports', {
          targetType: 'message',
          targetId: bad.id,
          reason: 'spam',
        })
      ).status,
    ).toBe(409);
    const outsider = await signedInUser(server.baseUrl);
    expect(
      (
        await outsider.client.post('/reports', {
          targetType: 'message',
          targetId: bad.id,
          reason: 'spam',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await reporter.client.post('/reports', {
          targetType: 'user',
          targetId: reporter.user.id,
          reason: 'spam',
        })
      ).status,
    ).toBe(400);

    const moderator = await adminWith('moderator');
    const report = (await moderator.client.get(`/admin/reports/${created.body.data.id}`)).body.data;
    expect(report).toMatchObject({ status: 'open', reason: 'harassment', targetType: 'message' });
    expect(report.evidence.map((e) => e.text)).toEqual(['abusive text']);
    expect(JSON.stringify(report)).not.toContain('not shared');
    expect(report.targetUser.id).toBe(offender.user.id);
  });

  it('moves through pending → reviewing → resolved/dismissed with rules and audit', async () => {
    const reporter = await signedInUser(server.baseUrl);
    const target = await signedInUser(server.baseUrl);
    const id = (
      await reporter.client.post('/reports', {
        targetType: 'user',
        targetId: target.user.id,
        reason: 'spam',
      })
    ).body.data.id;
    const moderator = await adminWith('moderator');
    const support = await adminWith('support');
    const decide = (who, body) => who.client.patch(`/admin/reports/${id}`, body);

    expect((await decide(support, { status: 'under_review' })).status).toBe(403);
    const taken = await decide(moderator, { status: 'under_review' });
    expect(taken.body.data).toMatchObject({
      status: 'under_review',
      assignedTo: { id: moderator.user.id },
    });
    expect((await decide(moderator, { status: 'resolved', note: 'done' })).status).toBe(400);
    const resolved = await decide(moderator, {
      status: 'resolved',
      action: 'warning',
      note: 'Warned the user',
    });
    expect(resolved.body.data.resolution).toMatchObject({
      action: 'warning',
      note: 'Warned the user',
    });
    expect((await decide(moderator, { status: 'under_review' })).status).toBe(409);
    expect((await decide(moderator, { status: 'open' })).body.data.status).toBe('open');
    expect(
      (await decide(moderator, { status: 'dismissed', note: 'Not a violation' })).body.data.status,
    ).toBe('dismissed');

    const list = await moderator.client.get('/admin/reports?status=dismissed');
    expect(list.body.data.map((r) => r.id)).toContain(id);
    const actions = (await AuditLog.find({ targetId: id }).sort({ _id: 1 }).lean()).map(
      (e) => e.action,
    );
    expect(actions).toEqual(['report.assign', 'report.resolve', 'report.reopen', 'report.dismiss']);
  });
});

describe('audit log', () => {
  it('is append-only in the application and readable only by Super Admins', async () => {
    const entry = await AuditLog.findOne().lean();
    await expect(
      AuditLog.updateOne({ _id: entry._id }, { $set: { reason: 'edited' } }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(AuditLog.deleteMany({})).rejects.toThrow(/cannot be changed/);
    const doc = await AuditLog.findById(entry._id);
    doc.reason = 'edited';
    await expect(doc.save()).rejects.toThrow(/cannot be changed/);

    expect((await (await adminWith('moderator')).client.get('/admin/audit')).status).toBe(403);
    expect((await (await adminWith('support')).client.get('/admin/audit')).status).toBe(403);
    const boss = await adminWith('super_admin');
    const page = await boss.client.get('/admin/audit?limit=5&action=user.suspend');
    expect(page.status).toBe(200);
    expect(page.body.data.every((e) => e.action === 'user.suspend')).toBe(true);
    expect(JSON.stringify(page.body)).not.toMatch(/password|token|cookie/i);
  });
});

describe('platform settings', () => {
  it('validates bounds and applies registration, upload and group-size limits', async () => {
    const boss = await adminWith('super_admin');
    // People for the group checks, created before registration is switched off.
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const put = (body) =>
      boss.client.send('put', '/admin/settings', { reason: 'Test change', ...body });
    expect((await put({ uploadMaxBytes: 10 * 1024 * 1024 })).status).toBe(400);
    expect((await put({ groupMaxMembers: 300 })).status).toBe(400);
    expect((await put({ maintenanceBanner: { enabled: true, message: '' } })).status).toBe(400);
    expect(
      (await boss.client.send('put', '/admin/settings', { registrationEnabled: false })).status,
    ).toBe(400);

    const saved = await put({
      registrationEnabled: false,
      uploadMaxBytes: 100 * 1024,
      groupMaxMembers: 2,
      maintenanceBanner: { enabled: true, message: 'Maintenance at 22:00 UTC' },
    });
    expect(saved.status).toBe(200);
    const pub = await new TestClient(server.baseUrl).get('/settings/public');
    expect(pub.body.data).toMatchObject({
      registrationEnabled: false,
      maintenanceBanner: { enabled: true, message: 'Maintenance at 22:00 UTC' },
    });

    const blocked = await new TestClient(server.baseUrl).post('/auth/register', uniqueUser());
    expect(blocked.body.error.code).toBe('REGISTRATION_DISABLED');

    const group = await createGroup(owner, [friends[0]]);
    const full = await owner.client.post(`/groups/${group.id}/members`, {
      userIds: [friends[1].user.id],
    });
    expect(full.body.error.code).toBe('GROUP_FULL');
    const upload = await owner.client.send(
      'post',
      `/conversations/${group.id}/attachments`,
      undefined,
      (t) => t.attach('file', Buffer.from('a'.repeat(150 * 1024)), { filename: 'big.txt' }),
    );
    expect(upload.status).toBe(413);
    expect(await AuditLog.exists({ action: 'settings.update', outcome: 'success' })).toBeTruthy();

    await put({
      registrationEnabled: true,
      uploadMaxBytes: 5 * 1024 * 1024,
      groupMaxMembers: 256,
      maintenanceBanner: { enabled: false, message: '' },
    });
    expect((await new TestClient(server.baseUrl).post('/auth/register', uniqueUser())).status).toBe(
      201,
    );
  });
});

describe('dashboard and system', () => {
  it('reports real counts and health without secrets', async () => {
    const boss = await adminWith('super_admin');
    const before = (await boss.client.get('/admin/dashboard?days=7')).body.data;
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const group = await createGroup(owner, friends);
    await httpSend(owner, group.id, newMessage('counted'));
    await friends[0].client.post('/reports', {
      targetType: 'group',
      targetId: group.id,
      reason: 'spam',
    });
    const after = (await boss.client.get('/admin/dashboard?days=7')).body.data;
    expect(after.users.total).toBe(before.users.total + 2);
    expect(after.users.new).toBe(before.users.new + 2);
    expect(after.conversations.groups).toBe(before.conversations.groups + 1);
    expect(after.messages.inPeriod).toBe(before.messages.inPeriod + 2); // "created" event + text
    expect(after.reports.pending).toBe(before.reports.pending + 1);
    expect(after.users.active).toBeGreaterThan(0);
    expect((await boss.client.get('/admin/dashboard?days=5')).status).toBe(400);

    const system = (await boss.client.get('/admin/system')).body.data;
    expect(system).toMatchObject({
      api: { status: 'ok' },
      database: { status: 'ok' },
      realtime: { status: 'ok' },
    });
    expect(system.requests.requests).toBeGreaterThan(0);
    expect(JSON.stringify(system)).not.toMatch(/mongodb:\/\/|secret|password/i);
  });
});
