import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/cli.ts';
import { args } from './helpers.ts';

const cli = join(import.meta.dir, '../src/cli.ts');
const runWithEnv = async (argv: Array<string>, env = process.env) => {
  const p = Bun.spawn([process.execPath, cli, ...argv], { env, stdout: 'pipe', stderr: 'pipe' });
  return { code: await p.exited, stdout: await new Response(p.stdout).text() };
};
const run = (...argv: Array<string>) => runWithEnv(argv);

test('parse commands, aliases, and reject invalid syntax', () => {
  expect(parse(['computer-history', 'status'])).toMatchObject({ service: 'history' });
  expect(parse(['--help'])).toEqual({ help: true });
  expect(() => args('pages', 'call')).toThrow();
  expect(() => args('pages', 'call', 'list_pages', 'extra')).toThrow();
  expect(() => args('history', 'unknown')).toThrow();
  expect(() => args('toString', 'tools')).toThrow();
  expect(() => args('pages', 'tools', '--unknown')).toThrow();
  expect(() => args('pages', 'call', 'list_pages', '--limit', '5')).toThrow('not used');
  expect(() => args('history', 'status', '--write')).toThrow('not used');
  expect(() => args('history', 'events', '--args', '{}')).toThrow('not used');
  expect(() => args('pages', 'call', 'list_pages', '--args', '{}', '--args', '{}')).toThrow(
    'more than once',
  );
});

test('browser run uses the environment default and gives --thread precedence', async () => {
  const thread = 'a56251c2-4389-48c9-af08-eabcb26b0e57';
  const directory = await mkdtemp(join(tmpdir(), 'codex-bridge-test-'));
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: directory,
    CODEX_THREAD_ID: thread,
    CODEX_BRIDGE_BROWSER_THREAD_ID: '',
  };
  try {
    expect(await runWithEnv(['browser', 'run'], env)).toMatchObject({ code: 2 });
    const unconfigured = await runWithEnv(['browser', 'run', 'list tabs'], env);
    expect(JSON.parse(unconfigured.stdout).error.code).toBe('invalid_arguments');
    const self = await runWithEnv(['browser', 'run', 'list tabs'], {
      ...env,
      CODEX_BRIDGE_BROWSER_THREAD_ID: thread,
    });
    expect(JSON.parse(self.stdout).error.code).toBe('browser_busy');
    const override = await runWithEnv(['browser', 'run', '--thread', thread, 'list tabs'], {
      ...env,
      CODEX_BRIDGE_BROWSER_THREAD_ID: 'invalid',
    });
    expect(JSON.parse(override.stdout).error.code).toBe('browser_busy');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser run skips the caller and reports when all remaining chats are locked', async () => {
  const caller = 'a56251c2-4389-48c9-af08-eabcb26b0e57';
  const threads = ['105655fd-f785-4ab2-9c88-11a0df16ba65', '34cb22b7-f3c6-466c-bcf2-5d5eec283648'];
  const directory = await mkdtemp(join(tmpdir(), 'codex-bridge-test-'));
  const locks = join(directory, 'codex-bridge', 'browser-locks');
  const databases: Array<Database> = [];
  try {
    await mkdir(locks, { recursive: true });
    for (const thread of threads) {
      const db = new Database(join(locks, `${thread}.sqlite3`));
      databases.push(db);
      db.exec('BEGIN IMMEDIATE');
    }
    const result = await runWithEnv(['browser', 'run', 'list tabs'], {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      CODEX_THREAD_ID: caller,
      CODEX_BRIDGE_BROWSER_THREAD_ID: [caller, ...threads].join(', '),
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toEqual({
      code: 'browser_busy',
      message: '指定した App チャットに空きがありません',
    });
  } finally {
    for (const db of databases) db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('bin entry returns 0 for help, 2 for syntax errors and 1 for refused writes', async () => {
  expect((await run('--help')).code).toBe(0);
  const syntax = await run('pages', 'call');
  expect(syntax.code).toBe(2);
  expect(JSON.parse(syntax.stdout).error.code).toBe('syntax_error');
  const write = await run('pages', 'call', 'create_page', '--args', '{}');
  expect(write.code).toBe(1);
  expect(JSON.parse(write.stdout).error).toMatchObject({ code: 'write_required' });
  const json = await run('pages', 'call', 'list_pages', '--args', '{bad');
  expect(json.code).toBe(1);
  expect(JSON.parse(json.stdout).error).toMatchObject({ code: 'invalid_arguments' });
  expect((await run('pages', 'call', 'list_pages', '--limit', '5')).code).toBe(2);
});
