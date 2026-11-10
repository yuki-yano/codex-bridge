#!/usr/bin/env bun
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError } from './errors.ts';
import { history } from './history.ts';
import { generateImage } from './image.ts';
import { remote, SERVICES, type Result, type Service } from './remote.ts';

const help = `codex-bridge — 結果は1行のJSON（成功0／失敗1／構文エラー2）
  history status
  history summaries --start ISO+09:00 --end ISO+09:00 [--query 検索語] [--max-chars 20000]
  history events --start ISO+09:00 --end ISO+09:00 [--query 検索語] [--limit 20] [--offset 0] [--details]
  pages|sites tools [ツール名]      ツール一覧、またはツールの説明と引数のJSON Schema
  pages|sites call ツール名 [--args 'JSON'|@絶対パス|-] [--write]
  image generate --prompt 内容 [--input 元画像]... [--out 保存先]
変更操作には依頼・承認と--writeが必要。モデルを呼ぶのは image generate だけ（ChatGPTの利用枠を消費）。
説明書: ${join(import.meta.dir, '../README.md')}`;

const options = {
  help: { type: 'boolean', short: 'h' },
  args: { type: 'string', default: '{}' },
  write: { type: 'boolean' },
  start: { type: 'string' },
  end: { type: 'string' },
  query: { type: 'string' },
  details: { type: 'boolean' },
  limit: { type: 'string', default: '20' },
  offset: { type: 'string', default: '0' },
  'max-chars': { type: 'string', default: '20000' },
  prompt: { type: 'string' },
  input: { type: 'string', multiple: true },
  out: { type: 'string' },
} as const;

// サブコマンドごとに受け付けるオプション。ほかを黙って無視すると、絞り込んだつもりの結果を誤解させる。
const accepted: Record<string, Array<string>> = {
  'history status': [],
  'history summaries': ['start', 'end', 'query', 'max-chars'],
  'history events': ['start', 'end', 'query', 'limit', 'offset', 'details'],
  tools: [],
  call: ['args', 'write'],
  'image generate': ['prompt', 'input', 'out'],
};

export type Command = {
  service: 'history' | 'image' | Service;
  action: string;
  tool?: string;
  args: string;
  write?: boolean;
  start?: string;
  end?: string;
  query?: string;
  details?: boolean;
  limit: string;
  offset: string;
  'max-chars': string;
  prompt?: string;
  input?: Array<string>;
  out?: string;
};

export function parse(argv: Array<string>): Command | { help: true } {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    options,
    tokens: true,
  });
  if (values.help || !positionals.length) return { help: true };
  let [service, action, tool, ...rest] = positionals;
  if (service === 'computer-history') service = 'history';
  const valid =
    service === 'history'
      ? !tool && ['status', 'summaries', 'events'].includes(action ?? '')
      : service === 'image'
        ? !tool && action === 'generate'
        : Object.hasOwn(SERVICES, service ?? '') &&
          (action === 'tools' || (action === 'call' && !!tool));
  if (rest.length || !valid) throw new Error('Invalid command; use --help');
  const given = tokens.flatMap((t) => (t.kind === 'option' ? [t.name] : []));
  const allowed =
    accepted[service === 'history' || service === 'image' ? `${service} ${action}` : action!] ?? [];
  const unsupported = given.find((name) => !allowed.includes(name));
  if (unsupported) throw new Error(`--${unsupported} is not used by this command; use --help`);
  const repeated = given.find((name, i) => name !== 'input' && given.indexOf(name) !== i);
  if (repeated) throw new Error(`--${repeated} is given more than once`);
  const { help: _help, ...flags } = values;
  return { service, action, tool, ...flags } as Command;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let a: Command | { help: true };
  try {
    a = parse(argv);
  } catch (e) {
    console.log(
      JSON.stringify({ ok: false, error: { code: 'syntax_error', message: (e as Error).message } }),
    );
    return 2;
  }
  if ('help' in a) {
    console.log(help);
    return 0;
  }
  let result: Result;
  try {
    result =
      a.service === 'history'
        ? { ok: true, data: await history(a) }
        : a.service === 'image'
          ? await generateImage(a)
          : await remote(a as Command & { service: Service });
  } catch (e) {
    result = {
      ok: false,
      error: { code: e instanceof CliError ? e.code : 'cli_error', message: (e as Error).message },
    };
  }
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
