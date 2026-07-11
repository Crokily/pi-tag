import { describe, expect, it } from 'vitest';
import { normalizeSlackText, splitMessage, SLACK_MAX_MESSAGE_LENGTH } from '../src/slack/text.js';

describe('normalizeSlackText', () => {
  it('decodes the three Slack HTML entities', () => {
    expect(normalizeSlackText('a &amp; b &lt; c &gt; d')).toBe('a & b < c > d');
  });

  it('decodes literal user-typed entities exactly once', () => {
    // User typed "&lt;" — Slack escapes the ampersand to "&amp;lt;".
    expect(normalizeSlackText('&amp;lt;')).toBe('&lt;');
  });

  it('unwraps bare links', () => {
    expect(normalizeSlackText('see <https://example.com/a?b=1>')).toBe(
      'see https://example.com/a?b=1',
    );
  });

  it('drops redundant link labels', () => {
    expect(normalizeSlackText('<https://example.com|example.com>')).toBe('https://example.com');
    expect(normalizeSlackText('<https://example.com|https://example.com>')).toBe(
      'https://example.com',
    );
    expect(normalizeSlackText('<mailto:a@b.com|a@b.com>')).toBe('mailto:a@b.com');
  });

  it('keeps meaningful link labels as markdown', () => {
    expect(normalizeSlackText('<https://example.com|the docs>')).toBe(
      '[the docs](https://example.com)',
    );
  });

  it('converts channel references', () => {
    expect(normalizeSlackText('ask in <#C0123ABC|general>')).toBe('ask in #general');
    expect(normalizeSlackText('ask in <#C0123ABC>')).toBe('ask in #C0123ABC');
  });

  it('converts special mentions', () => {
    expect(normalizeSlackText('<!here> and <!channel>')).toBe('@here and @channel');
    expect(normalizeSlackText('<!subteam^S012345|@devs>')).toBe('@devs');
  });

  it('leaves user mentions intact', () => {
    expect(normalizeSlackText('hey <@U0123456789> hi')).toBe('hey <@U0123456789> hi');
  });

  it('handles code-looking text a user typed', () => {
    expect(normalizeSlackText('if (a &lt; b &amp;&amp; b &gt; c) {}')).toBe(
      'if (a < b && b > c) {}',
    );
  });
});

describe('splitMessage', () => {
  it('returns short text as a single chunk', () => {
    expect(splitMessage('hello', 10)).toEqual(['hello']);
  });

  it('splits at newline boundaries within the limit', () => {
    const text = 'aaa\nbbb\nccc';
    expect(splitMessage(text, 8)).toEqual(['aaa\nbbb', 'ccc']);
  });

  it('hard-splits when no newline is available', () => {
    expect(splitMessage('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('never severs a surrogate pair on a hard split', () => {
    // '😀' is two UTF-16 code units; place the limit mid-pair.
    const text = 'abc😀def';
    const chunks = splitMessage(text, 4);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('defaults to the Slack outbound limit', () => {
    const text = 'x'.repeat(SLACK_MAX_MESSAGE_LENGTH + 1);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBeLessThanOrEqual(SLACK_MAX_MESSAGE_LENGTH);
  });
});
