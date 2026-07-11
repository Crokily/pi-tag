import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/slack/client.js', () => ({
  sendResponse: vi.fn().mockResolvedValue(true),
  setBusy: vi.fn().mockResolvedValue(undefined),
}));

const originalDbPath = process.env.DB_PATH;

let abortChannelTask!: (jid: string) => { aborted: boolean; cleared: number };
let closeDb: (() => void) | undefined;

beforeAll(async () => {
  process.env.DB_PATH = ':memory:';
  vi.resetModules();

  const db = await import('../src/db.js');
  db.initDb();
  closeDb = db.closeDb;

  ({ abortChannelTask } = await import('../src/agent/queue.js'));
});

afterAll(() => {
  closeDb?.();
  vi.resetModules();

  if (originalDbPath === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = originalDbPath;
  }
});

describe('abortChannelTask', () => {
  it('returns aborted=false and cleared=0 when no task is active', () => {
    const result = abortChannelTask('sl:nonexistent');
    expect(result.aborted).toBe(false);
    expect(result.cleared).toBe(0);
  });
});
