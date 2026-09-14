// Slack tools exposed to the agent. The Slack channel/thread/bot-token are
// bound at agent-build time via closure - the agent only sees thin schemas
// and cannot target a different channel or thread.
//
// Four tools:
//   get_slack_thread     - read messages (with file attachments) in the thread
//   download_slack_file  - fetch a thread file into /workspace
//   respond_to_thread    - post a final text reply
//   upload_to_thread     - upload a /workspace file as an attachment
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, resolve as pathResolve } from 'node:path';

import { z } from 'zod';

import { errMsg } from './emit.js';

import { tool } from './tools.js';

import { SLACK_API_BASE as API_BASE, WORKSPACE_DIR as WORKSPACE } from './config.js';

export interface SlackContext {
  botToken: string;
  channel: string;
  threadTs: string;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Slack's stated cap is 1GB but
// we keep responses snappy.

async function slackPost<T>(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<T> {
  const r = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

async function slackGet<T>(
  method: string,
  token: string,
  params: Record<string, string>,
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${API_BASE}/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await r.json()) as T;
}

interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  files?: SlackFile[];
}

/** Every Slack Web API response carries these; the rest varies per call. */
interface SlackOk {
  ok: boolean;
  error?: string;
}

function workspacePath(rel: string): string {
  const p = isAbsolute(rel) ? pathResolve(rel) : pathResolve(WORKSPACE, rel);
  if (p !== WORKSPACE && !p.startsWith(WORKSPACE + '/')) {
    throw new Error(`path must be inside ${WORKSPACE}`);
  }
  return p;
}

// Direct fallback poster used when the agent itself fails to call
// respond_to_thread (build error, stream crash before the tool fires,
// agent terminating without a reply). Goes through the same chat.postMessage
// path the tool uses, but doesn't require the agent to be alive.
export async function postFallbackToThread(ctx: SlackContext, text: string): Promise<void> {
  await slackPost<SlackOk & { ts?: string }>('chat.postMessage', ctx.botToken, {
    channel: ctx.channel,
    thread_ts: ctx.threadTs,
    text,
  });
}

export function buildSlackTools(ctx: SlackContext) {
  // respond_to_thread is the agent's only user-visible output channel, and the
  // server posts a fallback if it was never used. This tool is the only place
  // that knows, so it records it here rather than the caller inferring it.
  let replied = false;
  const getSlackThread = tool({
    name: 'get_slack_thread',
    description: `Read the messages in the Slack thread you were @-mentioned in.

Returns oldest-first messages, each with {user, text, ts, files?}. Files are
listed as {id, name, mimetype, size}. To inspect a file's contents, call
download_slack_file with its id - it lands in /workspace and you can then
use read_file (or bash - e.g. python3 - for other formats) to inspect it.

Always call this first so you have full context, including any uploaded files.`,
    inputSchema: z.object({
      limit: z.number().int().optional().describe('Max messages to return (default 50).'),
    }),
    callback: async ({ limit = 50 }) => {
      try {
        const r = await slackGet<SlackOk & { messages?: SlackMessage[] }>(
          'conversations.replies',
          ctx.botToken,
          {
            channel: ctx.channel,
            ts: ctx.threadTs,
            limit: String(limit),
          },
        );
        if (!r.ok) {
          return {
            error: r.error ?? 'unknown slack error',
            hint: 'check bot scopes (channels:history, groups:history)',
          };
        }
        const messages = (r.messages ?? []).map((m) => {
          const out: Record<string, unknown> = {
            user: m.user ?? m.bot_id ?? 'unknown',
            text: m.text ?? '',
            ts: m.ts ?? '',
          };
          if (m.files && m.files.length > 0) {
            out.files = m.files.map((f) => ({
              id: f.id,
              name: f.name,
              mimetype: f.mimetype,
              size: f.size,
            }));
          }
          return out;
        });
        return { count: messages.length, messages };
      } catch (e) {
        return {
          error: errMsg(e),
          hint: 'check network and SLACK_API_BASE',
        };
      }
    },
  });

  const downloadSlackFile = tool({
    name: 'download_slack_file',
    description: `Download a file attached to the Slack thread into /workspace.

Use the file id returned by get_slack_thread. The file is saved at
/workspace/<save_as or original name>. Returns {path, size, mimetype} on
success. After downloading, read it with read_file (or bash for other
formats). Requires the bot scope files:read.`,
    inputSchema: z.object({
      file_id: z.string().describe('Slack file id from get_slack_thread (e.g. F0123ABCD).'),
      save_as: z
        .string()
        .optional()
        .describe(
          'Filename to save under inside /workspace. Defaults to the original Slack filename.',
        ),
    }),
    callback: async ({ file_id, save_as }) => {
      try {
        const info = await slackGet<SlackOk & { file?: SlackFile }>('files.info', ctx.botToken, {
          file: file_id,
        });
        if (!info.ok || !info.file) {
          return {
            error: info.error ?? 'file not found',
            hint: 'check the file_id and the files:read scope',
          };
        }
        const url = info.file.url_private_download;
        if (!url) {
          return { error: 'no download url', hint: 'file may be expired or external' };
        }
        const name = save_as ?? info.file.name ?? `${file_id}.bin`;
        const dest = workspacePath(name);
        const r = await fetch(url, { headers: { Authorization: `Bearer ${ctx.botToken}` } });
        if (!r.ok) {
          return {
            error: `download failed: ${r.status}`,
            hint: 'check bot has files:read and is in the channel',
          };
        }
        const buf = Buffer.from(await r.arrayBuffer());
        // Slack returns the public sign-in HTML when the token can't access
        // the file - refuse anything that decodes as HTML so the agent
        // doesn't end up parsing a login page as data.
        if (buf.subarray(0, 256).toString('utf8').toLowerCase().includes('<!doctype html')) {
          return {
            error: 'received HTML instead of file content',
            hint: 'token likely missing files:read or not invited to the channel',
          };
        }
        writeFileSync(dest, buf);
        return { path: dest, size: buf.length, mimetype: info.file.mimetype ?? null };
      } catch (e) {
        return {
          error: errMsg(e),
          hint: 'check network, scopes (files:read), and the file_id',
        };
      }
    },
  });

  const respondToThread = tool({
    name: 'respond_to_thread',
    description: `Post your final text answer back to the Slack thread.

Slack mrkdwn formatting: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, <url|label>.
Use plain newlines. Tables don't render - use code blocks for aligned columns.

Call this exactly once with your final answer. If you also need to attach a
generated diagram or file, call upload_to_thread separately. Don't output
text outside of these tools.`,
    inputSchema: z.object({
      text: z.string().describe('The message content. Slack mrkdwn formatted.'),
    }),
    callback: async ({ text }) => {
      try {
        const r = await slackPost<SlackOk & { ts?: string }>('chat.postMessage', ctx.botToken, {
          channel: ctx.channel,
          thread_ts: ctx.threadTs,
          text,
        });
        if (!r.ok) {
          return { error: r.error ?? 'unknown slack error', hint: 'check bot scopes (chat:write)' };
        }
        replied = true;
        return { success: true, ts: r.ts };
      } catch (e) {
        return {
          error: errMsg(e),
          hint: 'check network and SLACK_API_BASE',
        };
      }
    },
  });

  const uploadToThread = tool({
    name: 'upload_to_thread',
    description: `Upload a file from /workspace as an attachment in the Slack thread.

Typical use: write a Python script that generates a chart (matplotlib) or a
diagram, run it with bash (python3), save it to /workspace/<name>.png, then
upload it here. Slack
renders images inline and other types as downloadable attachments.

Returns {file_id, title} on success. Requires the bot scope files:write.`,
    inputSchema: z.object({
      path: z.string().describe('Path to the file to upload, inside /workspace.'),
      title: z.string().optional().describe('Title shown above the file in Slack.'),
      comment: z.string().optional().describe('Optional comment posted alongside the file.'),
    }),
    callback: async ({ path, title, comment }) => {
      try {
        const abs = workspacePath(path);
        const stat = statSync(abs);
        if (!stat.isFile()) {
          return {
            error: 'path is not a file',
            hint: 'pass a path to a regular file inside /workspace',
          };
        }
        if (stat.size === 0) {
          return { error: 'file is empty', hint: 'write content to the file before uploading' };
        }
        if (stat.size > MAX_UPLOAD_BYTES) {
          return {
            error: `file too large (${stat.size} bytes)`,
            hint: `keep uploads under ${MAX_UPLOAD_BYTES} bytes`,
          };
        }
        const filename = basename(abs);

        // 1. Reserve an upload URL.
        const reserve = await slackGet<SlackOk & { upload_url?: string; file_id?: string }>(
          'files.getUploadURLExternal',
          ctx.botToken,
          {
            filename,
            length: String(stat.size),
          },
        );
        if (!reserve.ok || !reserve.upload_url || !reserve.file_id) {
          return {
            error: reserve.error ?? 'getUploadURLExternal failed',
            hint: 'check bot scope files:write',
          };
        }

        // 2. Upload the bytes to the signed URL, which takes a POST.
        const put = await fetch(reserve.upload_url, {
          method: 'POST',
          // Slack's signed URL accepts the raw stream; setting Content-Length
          // lets undici stream from disk without buffering.
          body: createReadStream(abs) as any,
          duplex: 'half' as any,
          headers: { 'Content-Length': String(stat.size) },
        });
        if (!put.ok) {
          return {
            error: `upload failed: ${put.status}`,
            hint: 'transient - retry, or check file size',
          };
        }

        // 3. Complete the upload, attaching to the thread.
        const complete = await slackPost<
          SlackOk & { files?: Array<{ id: string; title?: string }> }
        >('files.completeUploadExternal', ctx.botToken, {
          files: [{ id: reserve.file_id, title: title ?? filename }],
          channel_id: ctx.channel,
          thread_ts: ctx.threadTs,
          ...(comment ? { initial_comment: comment } : {}),
        });
        if (!complete.ok) {
          return {
            error: complete.error ?? 'completeUploadExternal failed',
            hint: 'check bot is in the channel and has files:write',
          };
        }
        const f = complete.files?.[0];
        return { file_id: f?.id ?? reserve.file_id, title: f?.title ?? filename };
      } catch (e) {
        return {
          error: errMsg(e),
          hint: 'check the path is in /workspace and the file exists',
        };
      }
    },
  });

  return {
    getSlackThread,
    downloadSlackFile,
    respondToThread,
    uploadToThread,
    hasReplied: () => replied,
  };
}
