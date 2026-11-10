import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { parse } from '../src/cli.ts';
import { args } from './helpers.ts';

const cli = join(import.meta.dir, '../src/cli.ts');
const run = async (...argv: Array<string>) => {
  const p = Bun.spawn([process.execPath, cli, ...argv], { stdout: 'pipe', stderr: 'pipe' });
  return { code: await p.exited, stdout: await new Response(p.stdout).text() };
};

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
