import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from './cli.ts';
import { CliError } from './errors.ts';

export const SUMMARY_ROOT = join(homedir(), '.codex/memories/extensions/skysight/resources');
export const EVENT_ROOT = join(
  homedir(),
  'Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Caches/ComputerUse/Skysight/segments',
);

export function scrub(text: string): string {
  return text
    .replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
    .replace(
      /((?:access_token|refresh_token|client_secret|api[_-]?key|password|authorization)["\s:=]+)[^\s,"}]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(?:sk-[\w-]{15,}|gh[pousr]_\w{15,}|xox[baprs]-[\w-]{15,}|ya29\.[\w-]{15,})/g,
      '[REDACTED]',
    );
}

export function instant(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CliError('invalid_arguments', 'Invalid timestamp');
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    throw new CliError('invalid_arguments', 'An ISO timestamp with explicit timezone is required');
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new CliError('invalid_arguments', 'Invalid timestamp');
  return at;
}

const iso = (value: number) => new Date(value).toISOString();

export function gaps(
  start: number,
  end: number,
  intervals: Array<[number, number]>,
): Array<[string, string]> {
  let cursor = start;
  const result: Array<[string, string]> = [];
  for (let [a, b] of intervals.toSorted((x, y) => x[0] - y[0])) {
    a = Math.max(a, start);
    b = Math.min(b, end);
    if (a >= b) continue;
    if (a > cursor) result.push([iso(cursor), iso(a)]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < end) result.push([iso(cursor), iso(end)]);
  return result;
}

type Summary = { start: number; end: number; kind: string; file: string };

const SECRET_KEY =
  /^(?:access_token|refresh_token|client_secret|api[_-]?key|password|authorization)$/i;

// 文字列ごとにマスクと切り詰めを行う。JSON全体を文字列で切らないので、data は常に有効なJSONのまま返る。
function redact(value: unknown, limit = Infinity, state = { truncated: false }, key = ''): unknown {
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) return '[REDACTED]';
    const text = scrub(value);
    if (text.length <= limit) return text;
    state.truncated = true;
    return text.slice(0, limit) + '…[truncated]';
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, limit, state));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v, limit, state, k)]),
    );
  return value;
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export async function history(a: Command, summaryRoot = SUMMARY_ROOT, eventRoot = EVENT_ROOT) {
  const index: Array<Summary> = [];
  let summaryReadable = true;
  let files: Array<string> = [];
  if (a.action !== 'events')
    try {
      files = await readdir(summaryRoot);
    } catch (e) {
      // status は状態を報告するコマンドなので、要約の保存先がないことも結果として返す。
      if (a.action !== 'status' || !isMissing(e)) throw e;
      summaryReadable = false;
    }
  for (const file of files) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z?-.*-(6h|10min)-/.exec(file);
    if (m) {
      const start = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
      index.push({ start, end: start + (m[5] === '6h' ? 21600000 : 600000), kind: m[5]!, file });
    }
  }
  index.sort((x, y) => x.start - y.start || x.file.localeCompare(y.file));
  if (a.action === 'status') {
    let eventsReadable = false;
    try {
      eventsReadable = (await stat(eventRoot)).isDirectory();
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    return {
      now: iso(Date.now()),
      recording_state: 'unknown',
      summary_root: summaryRoot,
      event_root: eventRoot,
      summary_count: index.length,
      summary_readable: summaryReadable,
      event_root_readable: eventsReadable,
      oldest_summary_start: index[0] ? iso(index[0].start) : null,
      newest_summary_end: index.length ? iso(Math.max(...index.map((r) => r.end))) : null,
      warning: '保存ファイルだけでは収録中か判断できない。欠測は活動なしの証拠ではない。',
    };
  }
  const start = instant(a.start);
  const end = instant(a.end);
  if (end <= start) throw new CliError('invalid_arguments', '--end must follow --start');
  const query = a.query?.toLowerCase();
  if (a.action === 'summaries') {
    let remaining = Number(a['max-chars']);
    if (!Number.isInteger(remaining) || remaining < 1 || remaining > 100000)
      throw new CliError('invalid_arguments', '--max-chars must be 1..100000');
    const coarse = index.filter((r) => r.kind === '6h' && r.start >= start && r.end <= end);
    const selected = index.filter(
      (r) =>
        r.start >= start &&
        r.end <= end &&
        (r.kind === '6h' || !coarse.some((c) => c.start <= r.start && c.end >= r.end)),
    );
    const sources = [];
    let omitted = 0;
    for (const r of selected) {
      const text = scrub(await readFile(join(summaryRoot, r.file), 'utf8'));
      if (query && !text.toLowerCase().includes(query)) continue;
      if (remaining <= 0) {
        omitted++;
        continue;
      }
      const clipped = text.slice(0, Math.min(24000, remaining));
      remaining -= clipped.length;
      sources.push({
        id: r.file.slice(0, -3),
        kind: 'history_summary',
        scope: 'unclassified',
        start: iso(r.start),
        end: iso(r.end),
        granularity: r.kind,
        path: join(summaryRoot, r.file),
        text: clipped,
        truncated: clipped.length < text.length,
      });
    }
    return {
      sources,
      uncovered_intervals: gaps(
        start,
        end,
        sources.map((r) => [Date.parse(r.start), Date.parse(r.end)]),
      ),
      omitted_documents: omitted,
      truncated: !!omitted || sources.some((r) => r.truncated),
      recording_state: 'unknown',
      coverage_note: '要約の時間枠は収録の連続性を保証しない。境界をまたぐ要約は含めない。',
    };
  }
  const limit = Number(a.limit);
  const offset = Number(a.offset);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw new CliError('invalid_arguments', '--limit must be 1..100; --offset must be nonnegative');
  const fields = [
    'timestamp',
    'kind',
    'app',
    'window',
    ...(a.details ? ['ax', 'keyboard', 'mouse', 'selection'] : []),
  ];
  const events = [];
  let matched = 0;
  let invalid = 0;
  for (const folder of (await readdir(eventRoot)).toSorted()) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(folder);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    if (at >= end || at + 21600000 <= start) continue;
    const path = join(eventRoot, folder, 'events.jsonl');
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      let line = 0;
      for await (const text of lines) {
        line++;
        let event: Record<string, unknown>;
        let time: number;
        try {
          event = JSON.parse(text);
          time = instant(event.timestamp);
        } catch {
          invalid++;
          continue;
        }
        if (time < start || time >= end) continue;
        // 検索は返す項目（--details なしならメタデータだけ）をマスクした後の内容に対して行う。
        const full = redact(
          Object.fromEntries(fields.filter((k) => k in event).map((k) => [k, event[k]])),
        );
        if (query && !JSON.stringify(full).toLowerCase().includes(query)) continue;
        if (++matched <= offset) continue;
        if (events.length >= limit)
          return {
            events,
            has_more: true,
            next_offset: offset + events.length,
            invalid_lines: invalid,
          };
        const state = { truncated: false };
        events.push({
          path,
          line,
          timestamp: iso(time),
          data: redact(full, 4000, state),
          truncated: state.truncated,
        });
      }
    } catch (e) {
      if (!isMissing(e)) throw e;
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return { events, has_more: false, next_offset: null, invalid_lines: invalid };
}
