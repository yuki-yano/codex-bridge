import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from './cli.ts';
import { CodexSession } from './codex.ts';
import { CliError } from './errors.ts';
import { scrub } from './history.ts';

const IPC = join(homedir(), '.codex/ipc/ipc.sock');
const FRAME_LIMIT = 8 * 1024 * 1024;
const WAIT_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// shortcut: App の非公開 IPC v1/v2 に依存。バージョン不一致時は送信先を推測せず停止する。
async function ipc({
  method,
  params,
  version,
  owner,
}: {
  method: string;
  params: object;
  version: number;
  owner?: string;
}): Promise<Record<string, unknown>> {
  const directory = await lstat(dirname(IPC));
  const file = await lstat(IPC);
  const uid = process.getuid?.();
  if (
    !directory.isDirectory() ||
    directory.uid !== uid ||
    directory.mode & 0o022 ||
    !file.isSocket() ||
    file.uid !== uid ||
    file.mode & 0o077
  ) {
    throw new CliError('browser_unavailable', 'ChatGPT App のローカルソケットを確認できません');
  }
  const requestId = randomUUID();
  const payload = Buffer.from(
    JSON.stringify({
      type: 'request',
      requestId,
      sourceClientId: 'codex-bridge-browser',
      version,
      method,
      params,
      targetClientId: owner,
    }),
  );
  if (payload.length > FRAME_LIMIT) throw new CliError('invalid_arguments', '依頼文が長すぎます');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  const socket = createConnection(IPC);
  const deadline = setTimeout(() => socket.destroy(new Error('App IPC timed out')), 15_000);
  try {
    socket.write(Buffer.concat([header, payload]));
    let buffered = Buffer.alloc(0);
    for await (const chunk of socket) {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const size = buffered.readUInt32LE();
        if (size > FRAME_LIMIT) throw new Error('Unexpected App IPC frame size');
        if (buffered.length < size + 4) break;
        const response = record(JSON.parse(buffered.subarray(4, size + 4).toString()));
        buffered = buffered.subarray(size + 4);
        if (response.type === 'response' && response.requestId === requestId) return response;
      }
    }
    throw new Error('App IPC disconnected');
  } finally {
    clearTimeout(deadline);
    socket.destroy();
  }
}

async function openOwner(thread: string): Promise<string> {
  const until = Date.now() + 20_000;
  let opened = false;
  do {
    const response = await ipc({
      method: 'thread-owner-discovery',
      params: { hostId: 'local', conversationId: thread },
      version: 1,
    }).catch((error: unknown): Record<string, unknown> => {
      if (record(error).code === 'ENOENT' || record(error).code === 'ECONNREFUSED') return {};
      throw error;
    });
    if (response.resultType === 'success' && typeof response.handledByClientId === 'string') {
      return response.handledByClientId;
    }
    if (response.error && response.error !== 'no-client-found') break;
    if (!opened) {
      const app = Bun.spawn(['/usr/bin/open', '-g', `codex://threads/${thread}`], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      if ((await app.exited) !== 0) break;
      opened = true;
    }
    await Bun.sleep(300);
  } while (Date.now() < until);
  throw new CliError('browser_unavailable', `App でチャット ${thread} を開けませんでした`);
}

async function startTurn(thread: string, owner: string, prompt: string): Promise<string> {
  const clientUserMessageId = randomUUID();
  const message = `以下の依頼を ChatGPT の公式ブラウザ拡張で実行してください。必要な承認は通常どおり App 側で求め、最終回答に実行結果を記載してください。\n\n${prompt}`;
  const response = await ipc({
    method: 'thread-follower-start-turn',
    version: 2,
    owner,
    params: {
      conversationId: thread,
      turnStart: {
        request: {
          threadId: thread,
          clientUserMessageId,
          input: [{ type: 'text', text: message, text_elements: [] }],
        },
      },
    },
  }).catch((): Record<string, unknown> => ({}));
  if (response.error === 'no-client-found') {
    throw new CliError('browser_unavailable', `App でチャット ${thread} を開き直してください`);
  }
  const turn = record(record(record(response.result).result).turn);
  if (response.resultType !== 'success' || typeof turn.id !== 'string' || !UUID.test(turn.id)) {
    throw new CliError(
      'browser_delivery_unknown',
      `App チャット ${thread} への送信結果を確認できません。再送前に App で確認してください`,
    );
  }
  return turn.id;
}

async function readTurns(session: CodexSession, threadId: string) {
  const result = record(
    await session.rpc<unknown>(
      'thread/turns/list',
      { threadId, limit: 8, itemsView: 'summary' },
      10_000,
    ),
  );
  if (!Array.isArray(result.data))
    throw new CliError('browser_unavailable', 'App チャットの履歴を取得できません');
  return result.data.map(record);
}

function turnStillOpen(turn: Record<string, unknown>): boolean {
  // 別プロセスの app-server は、App で実行中のターンも終了時刻なしの interrupted として返す。
  return (
    turn.status === 'inProgress' || (turn.status === 'interrupted' && turn.completedAt == null)
  );
}

async function runBrowser(thread: string, prompt: string) {
  const owner = await openOwner(thread);
  const session = new CodexSession();
  try {
    const { CODEX_SQLITE_HOME: _sqliteHome, ...env } = process.env;
    await session.launch(['apps._default.enabled=false'], {
      startThread: false,
      env: { ...env, CODEX_HOME: join(homedir(), '.codex') },
    });
    const [latest] = await readTurns(session, thread);
    if (latest && turnStillOpen(latest)) {
      throw new CliError(
        'browser_busy',
        `App チャット ${thread} の前のターンの終了を確認できません`,
      );
    }
    const turnId = await startTurn(thread, owner, prompt);
    if (turnId === latest?.id) {
      throw new CliError(
        'browser_delivery_unknown',
        `App チャット ${thread} の既存ターン ${turnId} が返りました。再送前に App で確認してください`,
      );
    }
    process.stderr.write(
      `App に依頼を送信しました。承認が必要な場合は App で応答してください（${turnId}）。\n`,
    );
    const until = Date.now() + WAIT_MS;
    do {
      let turn: Record<string, unknown> | undefined;
      try {
        turn = (await readTurns(session, thread)).find(({ id }) => id === turnId);
      } catch {
        throw new CliError(
          'browser_delivery_unknown',
          `App ターン ${turnId} の結果を取得できません。再送前に App で確認してください`,
        );
      }
      if (turn && !turnStillOpen(turn)) {
        if (turn.status !== 'completed') {
          throw new CliError(
            'browser_turn_failed',
            `App ターン ${turnId} の状態は ${String(turn.status)} です`,
          );
        }
        const messages = Array.isArray(turn.items) ? turn.items.map(record) : [];
        const final = messages.findLast(
          ({ type, phase }) => type === 'agentMessage' && phase === 'final_answer',
        );
        if (typeof final?.text === 'string')
          return { thread_id: thread, turn_id: turnId, text: scrub(final.text) };
        throw new CliError('browser_turn_failed', `App ターン ${turnId} に最終回答がありません`);
      }
      await Bun.sleep(900);
    } while (Date.now() < until);
    throw new CliError(
      'browser_wait_timeout',
      `App ターン ${turnId} の完了を確認できません。再送前に App で確認してください`,
    );
  } finally {
    await session.close();
  }
}

async function runWithThreadLock(directory: string, thread: string, prompt: string) {
  const db = new Database(join(directory, `${thread}.sqlite3`));
  try {
    // App が実行中のターンに依頼を合流させないよう、この CLI の送信を直列化する。
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (record(error).code === 'SQLITE_BUSY')
        throw new CliError('browser_busy', `App チャット ${thread} で別のブラウザ依頼を実行中です`);
      throw error;
    }
    return await runBrowser(thread, prompt);
  } finally {
    db.close();
  }
}

export async function browser(command: Command) {
  const configured =
    command.thread !== undefined
      ? [command.thread]
      : (process.env.CODEX_BRIDGE_BROWSER_THREAD_ID ?? '').split(',');
  const candidates = configured.map((id) => id.trim().toLowerCase());
  if (candidates.some((id) => !UUID.test(id))) {
    throw new CliError(
      'invalid_arguments',
      'App チャットの UUID を --thread で指定するか、CODEX_BRIDGE_BROWSER_THREAD_ID にカンマ区切りで設定してください',
    );
  }
  const caller = process.env.CODEX_THREAD_ID?.toLowerCase();
  const threads = [...new Set(candidates)].filter((id) => id !== caller);
  if (!threads.length)
    throw new CliError('browser_busy', '実行元とは別の App チャットを指定してください');

  const prompt = command.tool;
  if (!prompt?.trim())
    throw new CliError('invalid_arguments', 'ブラウザ操作の依頼を指定してください');
  const directory = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'codex-bridge/browser-locks',
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let unavailable: CliError | undefined;
  let busy: CliError | undefined;
  for (const thread of threads) {
    try {
      return await runWithThreadLock(directory, thread, prompt);
    } catch (error) {
      if (error instanceof CliError && error.code === 'browser_busy') busy ??= error;
      else if (error instanceof CliError && error.code === 'browser_unavailable')
        unavailable ??= error;
      else throw error;
    }
  }
  if (busy && threads.length > 1)
    throw new CliError('browser_busy', '指定した App チャットに空きがありません');
  throw busy ?? unavailable;
}
