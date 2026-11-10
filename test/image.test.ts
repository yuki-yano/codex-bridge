import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Command, parse } from '../src/cli.ts';
import { CodexSession } from '../src/codex.ts';
import { generateImage } from '../src/image.ts';

const args = (...argv: Array<string>) => parse(argv) as Command;

// launch と rpc を差し替え、turn/start を受けたら通知を流すだけの偽の Codex。
function fakeSession(items: Array<object>, turnError?: string) {
  const s = new CodexSession('/nonexistent');
  const sent: Array<{ method: string; params: any }> = [];
  s.launch = async () => {
    s.thread = 'thread-fixture';
  };
  s.close = async () => {};
  s.rpc = async <T>(method: string, params: any) => {
    sent.push({ method, params });
    queueMicrotask(() => {
      for (const item of items) s.onNotification?.('item/completed', { item });
      s.onNotification?.('turn/completed', {
        turn: {
          status: turnError ? 'failed' : 'completed',
          error: turnError ? { message: turnError } : null,
        },
      });
    });
    return {} as T;
  };
  return { s, sent };
}

test('image generate parses its own options and rejects others', () => {
  expect(
    args('image', 'generate', '--prompt', 'a cat', '--input', 'a.png', '--input', 'b.png'),
  ).toMatchObject({
    service: 'image',
    input: ['a.png', 'b.png'],
  });
  expect(() => args('image', 'generate', '--prompt', 'x', '--write')).toThrow('not used');
  expect(() => args('image', 'edit')).toThrow();
});

test('a generated image is returned by path and copied to --out without overwriting', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'bridge-image-'));
  try {
    const saved = join(temp, 'saved.png');
    await writeFile(saved, 'png-bytes');
    const { s, sent } = fakeSession([
      {
        type: 'imageGeneration',
        status: 'completed',
        savedPath: saved,
        revisedPrompt: 'a cat, watercolor',
      },
    ]);
    const out = join(temp, 'out.png');
    const result = await generateImage(
      args('image', 'generate', '--prompt', 'a cat', '--out', out),
      s,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { path: out, saved_path: saved, revised_prompt: 'a cat, watercolor' },
    });
    expect(await readFile(out, 'utf8')).toBe('png-bytes');
    expect(sent[0]?.method).toBe('turn/start');
    expect(JSON.stringify(sent[0]?.params.input)).toContain('a cat');
    await expect(
      generateImage(args('image', 'generate', '--prompt', 'a cat', '--out', out), s),
    ).rejects.toThrow('already exists');
  } finally {
    await rm(temp, { recursive: true });
  }
});

test('failures and missing prompts are reported without a file', async () => {
  const limited = fakeSession([
    {
      type: 'imageGeneration',
      status: 'failed',
      failure: { type: 'usageLimitExceeded', limitId: 'images' },
    },
  ]);
  expect(await generateImage(args('image', 'generate', '--prompt', 'x'), limited.s)).toMatchObject({
    ok: false,
    data: { failure: { type: 'usageLimitExceeded' } },
    error: { code: 'tool_error' },
  });
  const none = fakeSession([], 'model refused');
  expect(
    (await generateImage(args('image', 'generate', '--prompt', 'x'), none.s)).error,
  ).toMatchObject({ code: 'tool_error', message: 'model refused' });
  await expect(generateImage(args('image', 'generate', '--prompt', '  '), none.s)).rejects.toThrow(
    '--prompt',
  );
  await expect(
    generateImage(
      args('image', 'generate', '--prompt', 'x', '--input', '/nonexistent.png'),
      none.s,
    ),
  ).rejects.toThrow('not found');
  expect(existsSync('/nonexistent.png')).toBe(false);
});
