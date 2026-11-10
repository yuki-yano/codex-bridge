import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from './errors.ts';
import type { Result } from './remote.ts';

const exec = promisify(execFile);

export const SITES_PLUGIN_ROOT = join(
  homedir(),
  '.codex/plugins/cache/openai-curated-remote/sites',
);
const PACKAGER = 'scripts/package-site.mjs';

// Codex は Sites plugin を版ごとのディレクトリに置くため、梱包スクリプトを含む最新版を使う。
export async function findPackager(root = SITES_PLUGIN_ROOT): Promise<string> {
  let versions: Array<string> = [];
  try {
    versions = await readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const newest = versions
    .filter((v) => /^\d+(?:\.\d+)*$/.test(v) && existsSync(join(root, v, PACKAGER)))
    .toSorted((x, y) => y.localeCompare(x, 'en', { numeric: true }))[0];
  if (!newest)
    throw new CliError(
      'plugin_unavailable',
      `Sites packager not found at ${join(root, '<version>', PACKAGER)}; install or update the Sites plugin in Codex, then retry`,
    );
  return join(root, newest, PACKAGER);
}

export type Execute = (
  argv: Array<string>,
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

export const run: Execute = async (argv, cwd, env = process.env) => {
  try {
    const { stdout } = await exec(argv[0]!, argv.slice(1), {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 600000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (e) {
    const { stderr, stdout } = e as { stderr?: string; stdout?: string };
    throw new Error(stderr?.trim() || stdout?.trim() || 'Source command failed', { cause: e });
  }
};

const inside = (parent: string, child: string) => {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
};

type Credential = {
  remote_url: string;
  auth_mode?: string;
  token?: unknown;
  token_expires_at?: string;
  branch?: unknown;
};

// sites plugin の site-workflow.mjs と同じ規則で、子の git だけに認証を渡す環境を作る。
export function gitEnvironment(credential: Credential): NodeJS.ProcessEnv {
  const url = new URL(credential.remote_url);
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Repository URL must be credential-free HTTPS');
  const bearer = credential.auth_mode === 'http_extra_header';
  if (!bearer && credential.auth_mode !== 'work_proxy')
    throw new Error(
      'Unsupported repository auth_mode; request a new source credential for the same Site',
    );
  if (
    bearer &&
    (typeof credential.token !== 'string' || !credential.token || /[\r\n\0]/.test(credential.token))
  )
    throw new Error('Repository credential is missing');
  const expires = credential.token_expires_at;
  if (expires && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now()))
    throw new Error('Repository credential is expired; retry to request a new one');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith('GIT_TRACE') &&
        // 設定の注入だけを消す。GIT_CONFIG_GLOBAL 等の利用者の設定（proxy・CA）は残す。
        !/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(k) &&
        ![
          'GIT_CURL_VERBOSE',
          'GIT_DIR',
          'GIT_WORK_TREE',
          'GIT_INDEX_FILE',
          'GIT_COMMON_DIR',
          'GIT_ASKPASS',
          'SSH_ASKPASS',
        ].includes(k),
    ),
  );
  env.GIT_TERMINAL_PROMPT = '0';
  const entries = [
    ['credential.helper', ''],
    ['http.extraHeader', ''],
    ['http.followRedirects', 'false'],
  ];
  if (bearer)
    entries.push([
      `http.${credential.remote_url}.extraHeader`,
      `Authorization: Bearer ${credential.token}`,
    ]);
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], i) => {
    env['GIT_CONFIG_KEY_' + i] = key;
    env['GIT_CONFIG_VALUE_' + i] = value;
  });
  return env;
}

type Relay = { call(name: string, args: object): Promise<Result> };
type SourceArgs = {
  project_id: string;
  project_dir: string;
  archive_path: string;
  commands: Array<Array<string>>;
};

// 一時認証は使う直前に取得する。ビルド中の期限切れと、失敗時に使わない認証の発行を避ける。
async function repositoryAccess(relay: Relay, projectId: string) {
  const response = await relay.call('create_source_repository_write_credential', {
    project_id: projectId,
  });
  if (!response.ok) return { response };
  const credential = response.data as Credential;
  const env = gitEnvironment(credential);
  if (
    typeof credential.branch !== 'string' ||
    !credential.branch ||
    credential.branch.startsWith('-')
  )
    throw new Error('Missing repository branch');
  return { credential, env, branch: credential.branch };
}

export async function sourceOperation(
  name: string,
  a: Record<string, unknown>,
  relay: Relay,
  execute: Execute = run,
  packager: () => Promise<string> = findPackager,
): Promise<Result> {
  const allowed =
    name === 'source_checkout'
      ? ['project_id', 'project_dir']
      : ['project_id', 'project_dir', 'archive_path', 'commands'];
  if (
    Object.keys(a).some((k) => !allowed.includes(k)) ||
    allowed.some((k) => !(k in a)) ||
    typeof a.project_id !== 'string' ||
    !a.project_id ||
    typeof a.project_dir !== 'string' ||
    !isAbsolute(a.project_dir)
  )
    throw new CliError(
      'invalid_arguments',
      'Use the source tool schema and an absolute project_dir',
    );
  if (
    name === 'source_prepare' &&
    (typeof a.archive_path !== 'string' ||
      !isAbsolute(a.archive_path) ||
      !Array.isArray(a.commands) ||
      a.commands.some(
        (c) => !Array.isArray(c) || !c.length || c.some((v) => typeof v !== 'string'),
      ))
  )
    throw new CliError(
      'invalid_arguments',
      'Use an absolute new archive_path and commands as argument arrays',
    );
  const args = a as SourceArgs;
  if (name === 'source_checkout') {
    if (
      existsSync(args.project_dir) &&
      ((await lstat(args.project_dir)).isSymbolicLink() ||
        !(await lstat(args.project_dir)).isDirectory() ||
        (await readdir(args.project_dir)).length)
    )
      throw new CliError('invalid_arguments', 'Choose a new empty checkout directory');
    const access = await repositoryAccess(relay, args.project_id);
    if (access.response)
      throw new CliError(
        'source_error',
        `${access.response.error?.message ?? 'Could not get a repository credential'}; nothing was cloned`,
      );
    await mkdir(dirname(args.project_dir), { recursive: true });
    await execute(
      ['git', 'check-ref-format', '--branch', access.branch],
      dirname(args.project_dir),
    );
    await execute(
      [
        'git',
        'clone',
        '--single-branch',
        '--branch',
        access.branch,
        '--',
        access.credential.remote_url,
        args.project_dir,
      ],
      dirname(args.project_dir),
      access.env,
    );
    return {
      ok: true,
      data: { checkout_path: await realpath(args.project_dir), project_id: args.project_id },
    };
  }
  const packagerPath = await packager();
  const project = await realpath(args.project_dir);
  const archive = resolve(args.archive_path);
  if (existsSync(archive)) throw new CliError('invalid_arguments', 'Archive already exists');
  await mkdir(dirname(archive), { recursive: true });
  if (inside(project, join(await realpath(dirname(archive)), archive.split(sep).at(-1)!)))
    throw new CliError('invalid_arguments', 'Archive must be outside the source checkout');
  if ((await realpath(await execute(['git', 'rev-parse', '--show-toplevel'], project))) !== project)
    throw new CliError('invalid_arguments', 'Use the repository root');
  const clean = async () => {
    if (await execute(['git', 'status', '--porcelain', '--untracked-files=normal'], project))
      throw new Error('Source has uncommitted changes; obtain approval and commit first');
  };
  await clean();
  const sha = await execute(['git', 'rev-parse', 'HEAD'], project);
  const manifest = JSON.parse(
    await execute(['git', 'show', sha + ':.openai/hosting.json'], project),
  );
  if (manifest.project_id !== args.project_id)
    throw new Error('Committed hosting manifest belongs to another Site');
  // shortcut: tracked symlinks are rejected; add safe link extraction only when a real Site needs it.
  const tree = await execute(['git', 'ls-tree', '-r', sha], project);
  if (tree.split('\n').some((line) => line.startsWith('120000 ')))
    throw new Error('Tracked source symlinks are not supported');
  const temp = await mkdtemp(join(tmpdir(), 'codex-sites-'));
  try {
    const sourceTar = join(temp, 'source.tar');
    const snapshot = join(temp, 'source');
    await execute(['git', 'archive', '--output=' + sourceTar, sha], project);
    await mkdir(snapshot);
    await execute(['tar', '-xf', sourceTar, '-C', snapshot], project);
    if (existsSync(join(project, 'node_modules')) && !existsSync(join(snapshot, 'node_modules')))
      await symlink(await realpath(join(project, 'node_modules')), join(snapshot, 'node_modules'));
    for (const command of args.commands) await execute(command, snapshot);
    // 梱包は sites plugin の package-site.mjs に任せる（Worker の manifest、artifact_metadata、drizzle、archive の検査を含む）。
    await execute([process.execPath, packagerPath, snapshot, archive], snapshot);
    if ((await execute(['git', 'rev-parse', 'HEAD'], project)) !== sha)
      throw new Error('Source changed while building');
    await clean();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const receipt = { project_id: args.project_id, commit_sha: sha, archive };
  // 一時認証が取れなければpushしていない。結果不明と区別し、残ったarchiveの場所を示す。
  const notPushed = (message: string) =>
    new CliError(
      'source_error',
      `${message}; nothing was pushed and the archive remains at ${archive}`,
    );
  const access = await repositoryAccess(relay, args.project_id).catch((e: Error) => {
    throw notPushed(e.message);
  });
  if (access.response)
    throw notPushed(access.response.error?.message ?? 'Could not get a repository credential');
  try {
    await execute(['git', 'check-ref-format', '--branch', access.branch], project);
    await execute(
      ['git', 'push', access.credential.remote_url, sha + ':refs/heads/' + access.branch],
      project,
      access.env,
    );
    const remote = await execute(
      ['git', 'ls-remote', access.credential.remote_url, 'refs/heads/' + access.branch],
      project,
      access.env,
    );
    if (!remote || remote.split(/\s/)[0] !== sha)
      throw new Error('Remote source no longer matches packaged commit');
  } catch (e) {
    throw Object.assign(
      new Error('Git publish outcome must be checked before retrying: ' + (e as Error).message),
      {
        receipt,
      },
    );
  }
  return {
    ok: true,
    data: {
      ...receipt,
      archive_sha256: createHash('sha256')
        .update(await readFile(archive))
        .digest('hex'),
      packager_path: packagerPath,
    },
  };
}
