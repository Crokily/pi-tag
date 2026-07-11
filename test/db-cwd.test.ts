import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'HOME', 'PITAG_CONFIG', 'SESSIONS_DIR'];

afterEach(() => {
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('channel cwd migration', () => {
  it('adds cwd_override for legacy databases and preserves overrides on later re-registration', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pitag-db-cwd-'));
    tempDirs.push(tempDir);

    const dbPath = resolve(tempDir, 'gateway.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      create table channels (
        jid               text primary key,
        name              text not null,
        folder            text not null unique,
        requires_trigger  integer not null default 1,
        is_main           integer not null default 0,
        model_override    text not null default '',
        thinking_override text not null default '',
        created_at        text not null default (datetime('now'))
      );
    `);
    legacyDb
      .prepare(
        `
      insert into channels (jid, name, folder, requires_trigger, is_main, model_override, thinking_override)
      values (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run('sl:C123', 'legacy', 'ch_123', 1, 0, '', '');
    legacyDb.close();

    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    try {
      expect(db.getChannel('sl:C123')).toMatchObject({
        jid: 'sl:C123',
        cwdOverride: '',
      });

      db.registerChannel({
        jid: 'sl:C123',
        name: 'legacy',
        folder: 'ch_123',
        requiresTrigger: true,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '/workspace/project',
      });
      expect(db.getChannel('sl:C123')?.cwdOverride).toBe('/workspace/project');

      db.registerChannel({
        jid: 'sl:C123',
        name: 'legacy renamed',
        folder: 'ch_123',
        requiresTrigger: true,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      expect(db.getChannel('sl:C123')).toMatchObject({
        name: 'legacy renamed',
        cwdOverride: '/workspace/project',
      });
    } finally {
      db.closeDb();
    }

    const migratedDb = new Database(dbPath, { readonly: true });
    try {
      const columns = migratedDb.prepare('pragma table_info(channels)').all() as Array<{
        name: string;
      }>;
      expect(columns.some((column) => column.name === 'cwd_override')).toBe(true);
    } finally {
      migratedDb.close();
    }
  });
});

describe('message queue slack context migration', () => {
  it('adds event_ts/thread_ts to legacy databases and round-trips them through enqueue/claim', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pitag-db-queue-ctx-'));
    tempDirs.push(tempDir);

    const dbPath = resolve(tempDir, 'gateway.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      create table message_queue (
        rowid         integer primary key autoincrement,
        channel_jid   text not null,
        sender        text not null,
        sender_name   text not null,
        content       text not null,
        timestamp     text not null,
        status        text not null default 'pending',
        created_at    text not null default (datetime('now')),
        processed_at  text
      );
    `);
    legacyDb.close();

    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    try {
      db.enqueueMessage({
        channelJid: 'sl:C123',
        sender: 'U123',
        senderName: 'Alice',
        content: 'hello',
        timestamp: new Date().toISOString(),
        eventTs: '1751955000.000200',
        threadTs: '1751954000.000200',
      });
      db.enqueueMessage({
        channelJid: 'sl:C456',
        sender: 'U123',
        senderName: 'Alice',
        content: 'top-level',
        timestamp: new Date().toISOString(),
      });

      expect(db.claimNextMessage('sl:C123')).toMatchObject({
        channel_jid: 'sl:C123',
        event_ts: '1751955000.000200',
        thread_ts: '1751954000.000200',
      });
      expect(db.claimNextMessage('sl:C456')).toMatchObject({
        channel_jid: 'sl:C456',
        event_ts: null,
        thread_ts: null,
      });
    } finally {
      db.closeDb();
    }
  });
});
