import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { CliError } from './errors.ts';
import { scrub } from './history.ts';

export const CODEX =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

// ChatGPT.app 同梱の Codex app-server を子プロセスとして起動し、JSON-RPC でやり取りする。
export class CodexSession {
  proc?: ChildProcessByStdio<Writable, Readable, Readable>;
  reader?: Interface;
  thread?: string;
  pending = new Map<number, Pending>();
  seq = 0;
  stderr = '';
  interaction?: string;
  onNotification?: (method: string, params: any) => void;
  codex: string;

  constructor(codex = CODEX) {
    this.codex = codex;
  }

  send(value: object): void {
    this.proc!.stdin.write(JSON.stringify(value) + '\n');
  }

  rpc<T>(method: string, params: object, timeout = 180000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex RPC timed out'));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ id, method, params });
    });
  }

  // 利用者の MCP サーバーはすべて無効にし、overrides で必要な機能だけを有効にして起動する。
  async launch(
    overrides: Array<string>,
    { startThread = true, env = process.env } = {},
  ): Promise<void> {
    if (!existsSync(this.codex))
      throw new CliError(
        'codex_unavailable',
        `Codex not found at ${this.codex}; install or update the ChatGPT app and sign in to Codex`,
      );
    const path = join(homedir(), '.codex/config.toml');
    const config = (existsSync(path) ? Bun.TOML.parse(await readFile(path, 'utf8')) : {}) as {
      mcp_servers?: Record<string, unknown>;
    };
    const names = Object.keys(config.mcp_servers ?? {});
    if (names.some((n) => !/^[A-Za-z0-9_-]+$/.test(n)))
      throw new CliError(
        'codex_unavailable',
        'Cannot safely isolate an MCP server name in ~/.codex/config.toml',
      );
    const settings = [...names.map((n) => `mcp_servers.${n}.enabled=false`), ...overrides];
    const proc = spawn(
      this.codex,
      ['app-server', '--stdio', ...settings.flatMap((v) => ['-c', v])],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      },
    );
    this.proc = proc;
    proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    const fail = () => {
      const detail = scrub(this.stderr.trim()).slice(-1000);
      for (const p of this.pending.values())
        p.reject(new Error('Codex disconnected' + (detail ? ': ' + detail : '')));
      this.pending.clear();
    };
    proc.on('error', fail);
    proc.on('exit', fail);
    proc.stdin.on('error', fail);
    this.reader = createInterface({ input: proc.stdout });
    this.reader.on('line', (line) => {
      let v: {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        v = JSON.parse(line);
      } catch {
        fail();
        return;
      }
      // Codex からの要求（認証・承認など）は、こちらの要求への応答と id が重なっても応答として扱わない。
      if (v.method !== undefined) {
        if (v.id !== undefined) {
          this.interaction = v.method;
          this.send({
            id: v.id,
            error: {
              code: -32601,
              message: 'Complete interactive authentication or approval in Codex.',
            },
          });
        } else this.onNotification?.(v.method, v.params);
        return;
      }
      const p = v.id === undefined ? undefined : this.pending.get(v.id);
      if (!p) return;
      this.pending.delete(v.id!);
      if (v.error) p.reject(new Error(v.error.message || 'Codex RPC error'));
      else p.resolve(v.result);
    });
    await this.rpc('initialize', {
      clientInfo: { name: 'codex-bridge-cli', title: 'Codex Bridge', version: '1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
    if (!startThread) return;
    const started = await this.rpc<{ thread: { id: string } }>('thread/start', {
      ephemeral: true,
      cwd: process.cwd(),
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    this.thread = started.thread.id;
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      proc.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise((r) => proc.once('exit', r)),
        new Promise<void>((r) => {
          timer = setTimeout(() => {
            proc.kill('SIGKILL');
            r();
          }, 3000);
        }),
      ]);
      clearTimeout(timer);
    }
    this.reader?.close();
  }
}
