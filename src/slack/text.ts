/**
 * Slack text utilities shared by the Socket Mode client and the one-shot
 * `pitag send` path.
 */

/**
 * chat.postMessage truncates `text` at 40,000 but chat.update rejects at
 * 4,000, and markdown_text caps at 12,000 — take the strictest so every
 * outbound path is safe.
 */
export const SLACK_MAX_MESSAGE_LENGTH = 4000;

/** Split a message at newline boundaries, hard-splitting only when forced. */
export function splitMessage(text: string, max: number = SLACK_MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', max);
    if (splitAt <= 0) {
      splitAt = max; // hard split if no newline
      // Never sever a surrogate pair: chat.postMessage rejects lone surrogates.
      const code = remaining.charCodeAt(splitAt - 1);
      if (code >= 0xd800 && code <= 0xdbff && splitAt > 1) splitAt -= 1;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Undo Slack's inbound message encoding so pi sees what the human typed.
 *
 * Slack escapes `&`, `<`, `>` as HTML entities and wraps links/refs in
 * angle-bracket syntax (https://docs.slack.dev/messaging/formatting-message-text).
 * User mentions (`<@U…>`) are intentionally left intact — the client handles
 * the bot's own mention, and other mentions pass through verbatim like the
 * Discord gateway did.
 */
export function normalizeSlackText(text: string): string {
  let result = text;

  // <#C123|general> / <#C123> → #general / #C123
  result = result.replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_m, id: string, label: string) =>
    label ? `#${label}` : `#${id}`,
  );
  result = result.replace(/<#([A-Z0-9]+)>/g, '#$1');

  // <!here> / <!channel> / <!everyone> → @here / @channel / @everyone
  result = result.replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1');
  // <!subteam^ID|@group> → @group
  result = result.replace(/<!subteam\^[A-Z0-9]+\|@?([^>]*)>/g, '@$1');

  // <url|label> → url when the label is just the rendered url, else [label](url)
  result = result.replace(
    /<((?:https?|mailto|tel):[^|>]*)\|([^>]*)>/g,
    (_m, url: string, label: string) => {
      const bareUrl = url.replace(/^(https?:\/\/|mailto:|tel:)/, '');
      if (!label || label === url || label === bareUrl) return url;
      return `[${label}](${url})`;
    },
  );
  // <https://url> → https://url
  result = result.replace(/<((?:https?|mailto|tel):[^|>]*)>/g, '$1');

  // HTML entities last (Slack only escapes these three); &amp; very last so
  // literal "&amp;lt;" typed by a user decodes to "&lt;", not "<".
  result = result.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  return result;
}
