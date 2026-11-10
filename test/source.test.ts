import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Result } from '../src/remote.ts';
import { type Execute, findPackager, gitEnvironment, run, sourceOperation } from '../src/source.ts';
import { credential } from './helpers.ts';

const PACKAGER = 'scripts/package-site.mjs';

test('repository auth follows the Sites helper: Bearer only for http_extra_header, in the child environment', () => {
  const c = credential();
  const env = gitEnvironment(c);
  const config = Object.fromEntries(
    Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      env[`GIT_CONFIG_KEY_${i}`],
      env[`GIT_CONFIG_VALUE_${i}`],
    ]),
  );
  expect(config[`http.${c.remote_url}.extraHeader`]).toBe(`Authorization: Bearer ${c.token}`);
  expect(config['http.followRedirects']).toBe('false');
  expect(config['credential.helper']).toBe('');
  expect(() =>
    gitEnvironment({ ...c, remote_url: 'https://user:secret@example.invalid/r.git' }),
  ).toThrow();
  expect(() => gitEnvironment({ ...c, token_expires_at: '2000-01-01T00:00:00Z' })).toThrow(
    'expired',
  );
  expect(() => gitEnvironment({ ...c, auth_mode: 'basic' })).toThrow('auth_mode');
  expect(() => gitEnvironment({ ...c, token: 'a\nb' })).toThrow();
  const { token_expires_at: _expires, ...noExpiry } = c;
  expect(gitEnvironment(noExpiry).GIT_CONFIG_COUNT).toBe('4');
  const proxy = gitEnvironment({ auth_mode: 'work_proxy', remote_url: c.remote_url });
  expect(proxy.GIT_TERMINAL_PROMPT).toBe('0');
  expect(JSON.stringify(proxy)).not.toContain('Authorization');
});

test('packager resolves the newest installed Sites plugin and explains a missing one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-plugin-'));
  try {
    await expect(findPackager(root)).rejects.toThrow('install or update the Sites plugin');
    for (const version of ['1.1.4', '1.1.10']) {
      await mkdir(join(root, version, 'scripts'), { recursive: true });
      await writeFile(join(root, version, PACKAGER), '');
    }
    await mkdir(join(root, '1.2.0'));
    expect(await findPackager(root)).toBe(join(root, '1.1.10', PACKAGER));
  } finally {
    await rm(root, { recursive: true });
  }
});

test('source validates helper arguments and the packager before requesting a credential', async () => {
  let calls = 0;
  const relay = {
    call: async (): Promise<Result> => {
      calls++;
      return { ok: true };
    },
  };
  await expect(
    sourceOperation(
      'source_prepare',
      { project_id: 'x', project_dir: '/tmp/x', commands: [] },
      relay,
    ),
  ).rejects.toThrow();
  const valid = {
    project_id: 'x',
    project_dir: '/tmp/x',
    archive_path: '/tmp/x.tar.gz',
    commands: [],
  };
  const empty = await mkdtemp(join(tmpdir(), 'bridge-plugin-'));
  try {
    await expect(
      sourceOperation('source_prepare', valid, relay, run, () => findPackager(empty)),
    ).rejects.toThrow('Sites plugin');
  } finally {
    await rm(empty, { recursive: true });
  }
  expect(calls).toBe(0);
});

test('source archive matches approved commit, builds in a snapshot, gets the credential just before one push; dirty source is refused', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'bridge-source-'));
  const project = join(temp, 'project');
  const archive = join(temp, 'build.tar.gz');
  const packager = join(temp, 'package-site.cjs');
  try {
    // 実 package-site.mjs の代わりに、snapshot の dist を archive へ梱包するだけの fixture を使う。
    await writeFile(
      packager,
      "const [project, archive] = process.argv.slice(2); require('node:child_process').execFileSync('tar', ['-czf', archive, '-C', project, 'dist']);",
    );
    await mkdir(join(project, '.openai'), { recursive: true });
    await mkdir(join(project, 'dist'));
    await writeFile(
      join(project, '.openai/hosting.json'),
      JSON.stringify({ project_id: 'fixture-site', static: { directory: 'dist' } }),
    );
    await writeFile(
      join(project, 'dist/index.html'),
      '<!doctype html><title>Fixture</title><h1>Fixture</h1>',
    );
    await run(['git', 'init', '-q', '-b', 'main'], project);
    await run(['git', 'add', '.'], project);
    await run(
      [
        'git',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'user.name=Fixture',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'Disposable offline fixture',
      ],
      project,
    );
    const sha = await run(['git', 'rev-parse', 'HEAD'], project);
    const pushes: Array<Array<string>> = [];
    const execute: Execute = async (argv, cwd, env) => {
      if (argv[1] === 'push') {
        pushes.push(argv);
        expect(argv.join(' ')).not.toContain(credential().token);
        expect(JSON.stringify(env)).toContain('Authorization: Bearer');
        return '';
      }
      if (argv[1] === 'ls-remote') return sha + '\trefs/heads/main';
      return run(argv, cwd, env);
    };
    const relay = {
      call: async (_name: string, a: object): Promise<Result> => {
        expect(a).toEqual({ project_id: 'fixture-site' });
        // 一時認証は梱包が終わってから取得する。
        expect(existsSync(archive)).toBe(true);
        return { ok: true, data: credential() };
      },
    };
    const a = {
      project_id: 'fixture-site',
      project_dir: project,
      archive_path: archive,
      commands: [
        [process.execPath, '-e', 'await Bun.write("dist/index.html", "Built in snapshot")'],
      ],
    };
    const prepare = async () => packager;
    const result = await sourceOperation('source_prepare', a, relay, execute, prepare);
    expect(result.data).toMatchObject({ commit_sha: sha, packager_path: packager });
    expect(pushes.length).toBe(1);
    expect(pushes[0]).not.toContain('--force');
    expect(await run(['tar', '-xOf', archive, 'dist/index.html'], project)).toBe(
      'Built in snapshot',
    );
    expect(await readFile(join(project, 'dist/index.html'), 'utf8')).toContain('Fixture');
    await writeFile(join(project, 'dist/index.html'), 'Uncommitted');
    await expect(
      sourceOperation(
        'source_prepare',
        { ...a, archive_path: join(temp, 'second.tar.gz') },
        relay,
        execute,
        prepare,
      ),
    ).rejects.toThrow('uncommitted');
    expect(pushes.length).toBe(1);
    await writeFile(
      join(project, 'dist/index.html'),
      '<!doctype html><title>Fixture</title><h1>Fixture</h1>',
    );
    let attempts = 0;
    const failPush: Execute = async (argv, cwd, env) => {
      if (argv[1] === 'push') {
        attempts++;
        throw new Error('Ambiguous remote result');
      }
      return execute(argv, cwd, env);
    };
    const unknown = join(temp, 'unknown.tar.gz');
    const error = await sourceOperation(
      'source_prepare',
      { ...a, archive_path: unknown },
      { call: async () => ({ ok: true, data: credential() }) },
      failPush,
      prepare,
    ).then(
      () => undefined,
      (e: Error & { receipt?: object }) => e,
    );
    expect(error?.receipt).toEqual({
      project_id: 'fixture-site',
      commit_sha: sha,
      archive: unknown,
    });
    expect(attempts).toBe(1);
  } finally {
    await rm(temp, { recursive: true });
  }
});
