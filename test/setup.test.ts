import { describe, expect, it } from 'vitest';
import { buildConfigFile } from '../src/cli/setup.js';

describe('buildConfigFile', () => {
  it('includes the generated tokens and local path settings', () => {
    const text = buildConfigFile({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      triggerName: 'PiBot',
      workingDir: '/workspace/project',
      sessionsDir: '/var/lib/pi-tag/sessions',
      dbPath: '/var/lib/pi-tag/gateway.db',
    });

    expect(text).toContain('SLACK_BOT_TOKEN=xoxb-test-token');
    expect(text).toContain('SLACK_APP_TOKEN=xapp-test-token');
    expect(text).toContain('TRIGGER_NAME=PiBot');
    expect(text).toContain('PI_CWD=/workspace/project');
    expect(text).toContain('SESSIONS_DIR=/var/lib/pi-tag/sessions');
    expect(text).toContain('DB_PATH=/var/lib/pi-tag/gateway.db');
    expect(text).not.toContain('AUTO_REGISTER_DMS');
  });

  it('defaults DM policy to open and reply-in-thread to true', () => {
    const text = buildConfigFile({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      triggerName: 'PiBot',
      workingDir: '/workspace/project',
      sessionsDir: '/var/lib/pi-tag/sessions',
      dbPath: '/var/lib/pi-tag/gateway.db',
    });

    expect(text).toContain('DM_POLICY=open');
    expect(text).toContain('REPLY_IN_THREAD=true');
  });

  it('writes the selected DM policy and thread preference', () => {
    const text = buildConfigFile({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      triggerName: 'PiBot',
      workingDir: '/workspace/project',
      dmPolicy: 'disabled',
      replyInThread: false,
      sessionsDir: '/var/lib/pi-tag/sessions',
      dbPath: '/var/lib/pi-tag/gateway.db',
    });

    expect(text).toContain('DM_POLICY=disabled');
    expect(text).toContain('REPLY_IN_THREAD=false');
  });
});
