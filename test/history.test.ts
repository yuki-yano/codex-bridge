import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gaps, history, instant, scrub } from '../src/history.ts';
import { args } from './helpers.ts';

test('timezone and empty intervals are rejected; coverage gaps stay explicit', () => {
  expect(() => instant('2026-11-06T10:00')).toThrow('timezone');
  expect(
    gaps(0, 3000, [
      [0, 1000],
      [2000, 3000],
    ]),
  ).toEqual([['1970-01-01T00:00:01.000Z', '1970-01-01T00:00:02.000Z']]);
  expect(scrub('Bearer abc123 access_token:secret')).not.toContain('secret');
});

test('History selects coarse summaries, preserves truncation and excludes boundary overlaps', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'bridge-history-'));
  try {
    await writeFile(join(temp, '2026-11-06T00-00-00-fixture-6h-summary.md'), '長い要約の本文');
    await writeFile(join(temp, '2026-11-06T00-10-00-fixture-10min-summary.md'), '重複');
    let a = args(
      'history',
      'summaries',
      '--start',
      '2026-11-06T00:00:00Z',
      '--end',
      '2026-11-06T06:00:00Z',
      '--max-chars',
      '3',
    );
    let result = await history(a, temp, temp);
    expect(result).toMatchObject({ truncated: true, sources: [{ text: '長い要' }] });
    a = args(
      'history',
      'summaries',
      '--start',
      '2026-11-06T00:11:00Z',
      '--end',
      '2026-11-06T00:19:00Z',
    );
    result = await history(a, temp, temp);
    expect(result).toMatchObject({ sources: [], uncovered_intervals: [expect.any(Array)] });
    expect(await history(args('history', 'status'), join(temp, 'missing'), temp)).toMatchObject({
      summary_readable: false,
      summary_count: 0,
    });
    await expect(
      history(
        args(
          'history',
          'summaries',
          '--start',
          '2026-11-06T00:00:00Z',
          '--end',
          '2026-11-06T06:00:00Z',
        ),
        join(temp, 'missing'),
        temp,
      ),
    ).rejects.toThrow();
    a['max-chars'] = '0';
    await expect(history(a, temp, temp)).rejects.toThrow();
  } finally {
    await rm(temp, { recursive: true });
  }
});

test('raw events paginate, omit details by default, scrub secrets, count bad lines', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'bridge-events-'));
  const segment = join(temp, '2026-11-06T00-00-00Z');
  try {
    await mkdir(segment);
    const events = [0, 1, 2].map((i) => ({
      timestamp: `2026-11-06T00:0${i}:00Z`,
      kind: 'fixture',
      app: 'Terminal',
      keyboard: { text: 'password:fixture-secret' },
      ax: { text: 'x'.repeat(5000), password: 'plain-key-secret' },
    }));
    await writeFile(
      join(segment, 'events.jsonl'),
      'bad\n' + events.map((e) => JSON.stringify(e)).join('\n'),
    );
    const a = args(
      'history',
      'events',
      '--start',
      '2026-11-06T00:00:00Z',
      '--end',
      '2026-11-06T00:03:00Z',
      '--limit',
      '1',
    );
    const one = (await history(a, temp, temp)) as {
      events: Array<{ timestamp: string; data: Record<string, any>; truncated: boolean }>;
    };
    expect(one).toMatchObject({ has_more: true, next_offset: 1, invalid_lines: 1 });
    expect(one.events[0]!.data).not.toHaveProperty('keyboard');
    expect(one.events[0]!.truncated).toBe(false);
    const two = (await history({ ...a, offset: '1', details: true }, temp, temp)) as typeof one;
    expect(two.events[0]!.timestamp).not.toBe(one.events[0]!.timestamp);
    expect(two.events[0]!.data).toHaveProperty('keyboard');
    // 長いAXテキストは文字列ごとに切り詰め、data はオブジェクトのまま返す。
    expect(two.events[0]!.truncated).toBe(true);
    expect(two.events[0]!.data.ax.text.length).toBeLessThan(4100);
    expect(two.events[0]!.data.ax.password).toBe('[REDACTED]');
    expect(JSON.stringify(two)).not.toContain('fixture-secret');
    // キー入力にしかない語は、--details なしでは検索に一致しない。
    const hidden = await history({ ...a, query: 'password', limit: '10' }, temp, temp);
    expect(hidden).toMatchObject({ events: [] });
    const shown = (await history(
      { ...a, query: 'password', limit: '10', details: true },
      temp,
      temp,
    )) as typeof one;
    expect(shown.events.length).toBe(3);
  } finally {
    await rm(temp, { recursive: true });
  }
});
