/**
 * Outbound file uploads via Slack's external upload flow.
 *
 * files.upload was retired on 2025-11-12; the replacement is the three-step
 * external flow: files.getUploadURLExternal per file, an HTTP POST of the raw
 * bytes to each returned upload_url, then a single files.completeUploadExternal
 * that shares all files to the destination as one message. The installed
 * @slack/web-api SDK wraps exactly this flow in `files.uploadV2` (and groups
 * files that share a destination into one completeUploadExternal call), so we
 * delegate to it rather than re-implementing the steps.
 */

import { basename } from 'node:path';
import type { WebClient } from '@slack/web-api';

export interface UploadFileSpec {
  filePath: string;
  title?: string;
}

export async function uploadFilesExternal(
  client: WebClient,
  files: UploadFileSpec[],
  dest: { channelId: string; threadTs?: string; initialComment?: string },
): Promise<{ sentFiles: number }> {
  if (files.length === 0) {
    return { sentFiles: 0 };
  }

  // String `file` values are read from disk by the SDK; the destination is
  // top-level so every file lands in the same message (thread_ts requires
  // channel_id per FileThreadDestinationArgument).
  await client.files.uploadV2({
    channel_id: dest.channelId,
    thread_ts: dest.threadTs,
    initial_comment: dest.initialComment,
    file_uploads: files.map((spec) => ({
      file: spec.filePath,
      filename: basename(spec.filePath),
      title: spec.title,
    })),
  });

  return { sentFiles: files.length };
}
