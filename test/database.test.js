import { describe, expect, it } from 'vitest';
import {
  connectDatabase,
  DatabaseConnectionError,
  pingDatabase,
  redactMongoUri,
  sanitizeDatabaseError,
} from '../src/db/mongoose.js';
import { silentLogger } from '../src/utils/logger.js';

describe('database connection module', () => {
  it('redacts credentials and query options from connection strings', () => {
    expect(
      redactMongoUri('mongodb+srv://admin:s3cret@cluster0.example.net/connect?retryWrites=true'),
    ).toBe('mongodb+srv://<credentials>@cluster0.example.net/connect');
    expect(redactMongoUri('mongodb://localhost:27017/connect')).toBe(
      'mongodb://localhost:27017/connect',
    );
  });

  it('removes credentials from driver error messages', () => {
    const uri = 'mongodb://admin:p%40ss@db.example.net/connect';
    const message = sanitizeDatabaseError(new Error('auth failed for admin with p@ss'), uri);
    expect(message).not.toContain('p@ss');
    expect(message).not.toContain('admin');
  });

  it('fails startup with a clear, credential-free error after the configured attempts', async () => {
    const uri = 'mongodb://startup-user:startup-secret@127.0.0.1:1/connect';
    const error = await connectDatabase(
      { uri, autoIndex: false, serverSelectionTimeoutMS: 1_000, maxAttempts: 2, retryDelayMs: 10 },
      silentLogger,
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(DatabaseConnectionError);
    const message = error.message;
    expect(message).toMatch(/after 2 attempt/);
    expect(message).not.toContain('startup-secret');
    expect(message).not.toContain('startup-user');
  });

  it('reports not ready when there is no connection', async () => {
    expect(await pingDatabase(500)).toEqual({ ok: false });
  });
});
