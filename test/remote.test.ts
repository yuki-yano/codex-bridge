import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { input, READS, Relay, remote, type Result, SERVICES } from '../src/remote.ts';
import { args, credential, fake } from './helpers.ts';

test('JSON input preserves Unicode and literal newlines from stdin and file', async () => {
  const value = { text: '日本語\n\n本文' };
  const text = JSON.stringify(value);
  expect(await input(text)).toEqual(value);
  expect(await input('-', async () => text)).toEqual(value);
  const temp = await mkdtemp(join(tmpdir(), 'bridge-input-'));
  try {
    await writeFile(join(temp, 'a.json'), text);
    expect(await input('@' + join(temp, 'a.json'))).toEqual(value);
  } finally {
    await rm(temp, { recursive: true });
  }
  await expect(input('[1]')).rejects.toThrow('object');
  await expect(input('{"secret":"fixture-secret"')).rejects.toThrow('Invalid JSON');
});

test('writes and unknown actions are blocked before connection', async () => {
  for (const [service, tool] of [
    ['pages', 'create_page'],
    ['sites', 'create_site'],
    ['sites', 'source_prepare'],
  ] as const) {
    const f = fake(service);
    const result = await remote(args(service, 'call', tool), f.r);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('--write');
    expect(f.starts()).toBe(0);
    expect(f.calls.length).toBe(0);
  }
  const f = fake();
  expect((await remote(args('pages', 'call', 'progress_update', '--write'), f.r)).ok).toBe(false);
  expect(f.starts()).toBe(0);
});

test('Page guards and native receipts remain intact with one call', async () => {
  const f = fake();
  const data = { page_id: 'page_fixture', stream_kind: 'content', expected_hash: 'observed' };
  f.r.call = async (name, actual): Promise<Result> => {
    f.calls.push({ name, data: actual });
    return { ok: true, data: { commit_status: 'applied', through_sequence: 27 } };
  };
  const result = await remote(
    args('pages', 'call', 'patch_page', '--write', '--args', JSON.stringify(data)),
    f.r,
  );
  expect(result.data.through_sequence).toBe(27);
  expect(f.calls).toEqual([{ name: 'patch_page', data }]);
});

test('changed read annotation requires explicit write flag', async () => {
  const f = fake();
  f.r.catalog.list_pages!.annotations = {};
  const result = await remote(args('pages', 'call', 'list_pages'), f.r);
  expect(result.ok).toBe(false);
  expect(f.calls.length).toBe(0);
});

test('unexpected fields and missing required fields are rejected before native invocation', async () => {
  const f = fake();
  f.r.catalog.list_pages!.inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { limit: { type: 'integer', minimum: 1 } },
  };
  for (const data of [{ unexpected: true }, { limit: 0 }, { limit: '1' }]) {
    const result = await remote(
      args('pages', 'call', 'list_pages', '--args', JSON.stringify(data)),
      f.r,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('schema');
  }
  expect(f.calls.length).toBe(0);
});

test('source helpers expose no ephemeral credential action or handle', async () => {
  const f = fake('sites');
  const result = await remote(args('sites', 'tools'), f.r);
  const names = result.data.tools.map((t: { name: string }) => t.name);
  expect(names).toContain('source_prepare');
  expect(names).not.toContain('create_source_repository_write_credential');
  const detail = await remote(args('sites', 'tools', 'source_checkout'), f.r);
  expect(detail.data.inputSchema.properties.credential_handle).toBeUndefined();
  const prepare = await remote(args('sites', 'tools', 'source_prepare'), f.r);
  expect(prepare.data.packager).toBeObject();
});

test('tokens never reach CLI output, and short token fields do not rewrite unrelated text', async () => {
  const f = fake('sites');
  const c = credential();
  f.r.capture(c);
  f.r.capture({ token: 'abc' });
  f.r.call = async () => ({
    ok: true,
    data: { id: 'fixture', source_repository_credential: c, other: c.token, label: 'abc' },
  });
  const result = JSON.stringify(await remote(args('sites', 'call', 'create_site', '--write'), f.r));
  expect(result).not.toContain(c.token);
  expect(result).toContain('"label":"abc"');
});

test('non-JSON native response is withheld and writes become outcome unknown', async () => {
  const r = new Relay('sites');
  r.thread = 'fixture';
  r.rpc = async <T>() => ({ content: [{ type: 'text', text: 'unexpected fixture-secret' }] }) as T;
  const result = await r.call('create_site', {});
  expect(result.ok).toBe(false);
  expect(result.error?.commit_status).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
});

test('native transport timeout is not retried or reported as empty success', async () => {
  const r = new Relay('pages');
  r.thread = 'fixture';
  let count = 0;
  r.rpc = async () => {
    count++;
    throw new Error('timeout');
  };
  expect((await r.call('patch_page', {})).error?.commit_status).toBe('unknown');
  const read = await r.call('list_pages', {});
  expect(read.ok).toBe(false);
  expect(read.error?.commit_status).toBeUndefined();
  expect(count).toBe(2);
});

test('native call uses exact namespace, arguments, and structured output', async () => {
  const r = new Relay('pages');
  r.thread = 'fixture';
  let request: { method: string; value: { tool?: string; arguments?: object } } | undefined;
  r.rpc = async <T>(method: string, value: object) => {
    request = { method, value };
    return {
      structuredContent: { content: { page_id: 'page_x' }, metadata: { stream_kind: 'content' } },
    } as T;
  };
  const data = { page_id: 'page_x' };
  const result = await r.call('read_page', data);
  expect(request?.value.tool).toBe('chatgpt_space.read_page');
  expect(request?.value.arguments).toEqual(data);
  expect(result.data.metadata.stream_kind).toBe('content');
});

test('service-reported failures carry a top-level tool_error and keep the data', async () => {
  const r = new Relay('pages');
  r.thread = 'fixture';
  r.rpc = async <T>() =>
    ({ structuredContent: { error: { message: 'stale hash' }, commit_status: 'rejected' } }) as T;
  expect(await r.call('patch_page', {})).toMatchObject({
    ok: false,
    data: { commit_status: 'rejected' },
    error: { code: 'tool_error', message: 'stale hash' },
  });
  r.rpc = async <T>() =>
    ({ isError: true, content: [{ type: 'text', text: 'denied Bearer abc.def' }] }) as T;
  const text = await r.call('read_page', {});
  expect(text.error).toMatchObject({ code: 'tool_error' });
  expect(text.error?.message).not.toContain('abc.def');
});

test('image content is saved to a file instead of being dropped', async () => {
  const r = new Relay('pages');
  r.thread = 'fixture';
  const png = Buffer.from('fixture-image');
  r.rpc = async <T>() =>
    ({ content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] }) as T;
  const result = await r.call('read_page_reference', {});
  expect(result.ok).toBe(true);
  expect(result.images?.[0]?.mime_type).toBe('image/png');
  expect(Buffer.from(await Bun.file(result.images![0]!.path).arrayBuffer())).toEqual(png);
});

test('only the called tool must exist; missing tools are named', async () => {
  const f = fake();
  delete f.r.catalog.move_page;
  expect((await remote(args('pages', 'call', 'list_pages'), f.r)).ok).toBe(true);
  const missing = await remote(args('pages', 'call', 'move_page', '--write'), f.r);
  expect(missing.error).toMatchObject({ code: 'tool_unavailable' });
  expect(missing.error?.message).toContain('move_page');
  f.r.catalog.list_pages!.description = 'List pages. Use the cursor. More details.';
  const list = await remote(args('pages', 'tools'), f.r);
  expect(list.data.unavailable).toEqual(['move_page']);
  expect(list.data.tools.find((t: { name: string }) => t.name === 'list_pages').description).toBe(
    'List pages. Use the cursor.',
  );
});

test('failed writes keep the outcome unknown unless the service reports it', async () => {
  const r = new Relay('sites');
  r.thread = 'fixture';
  r.rpc = async <T>() =>
    ({ isError: true, content: [{ type: 'text', text: 'upstream timed out' }] }) as T;
  expect((await r.call('create_site', {})).error).toMatchObject({
    code: 'tool_error',
    commit_status: 'unknown',
    retryable: false,
  });
  expect((await r.call('list_sites', {})).error?.commit_status).toBeUndefined();
  const pages = new Relay('pages');
  pages.thread = 'fixture';
  pages.rpc = async <T>() =>
    ({ structuredContent: { error: { message: 'stale', commit_status: 'not_committed' } } }) as T;
  expect((await pages.call('patch_page', {})).error).toMatchObject({
    commit_status: 'not_committed',
  });
});

test('a sign-in or approval request from Codex becomes interaction_required with the original message', async () => {
  const f = fake();
  f.r.call = async (): Promise<Result> => {
    f.r.interaction = 'account/login';
    return { ok: false, error: { code: 'transport_error', message: 'Codex RPC timed out' } };
  };
  const result = await remote(args('pages', 'call', 'list_pages'), f.r);
  expect(result.error?.code).toBe('interaction_required');
  expect(result.error?.message).toContain('account/login');
  expect(result.error?.message).toContain('Codex RPC timed out');
});

test('an unreadable arguments file is an argument error and nothing is sent', async () => {
  const f = fake();
  const result = await remote(
    args('pages', 'call', 'list_pages', '--args', '@/nonexistent/args.json'),
    f.r,
  );
  expect(result.error?.code).toBe('invalid_arguments');
  expect(f.starts()).toBe(0);
});

test('a sign-in request during a Sites source operation is reported as interaction_required', async () => {
  const f = fake('sites');
  f.r.call = async (): Promise<Result> => {
    f.r.interaction = 'account/login';
    return { ok: false, error: { code: 'transport_error', message: 'declined' } };
  };
  const dir = join(tmpdir(), `bridge-checkout-${process.pid}-${Date.now()}`);
  const data = JSON.stringify({ project_id: 'fixture-site', project_dir: dir });
  const result = await remote(
    args('sites', 'call', 'source_checkout', '--write', '--args', data),
    f.r,
  );
  expect(result.error?.code).toBe('interaction_required');
  expect(result.error?.message).toContain('nothing was cloned');
});

test('error messages do not carry values removed from data by key', async () => {
  const r = new Relay('sites');
  r.thread = 'fixture';
  r.rpc = async <T>() =>
    ({
      isError: true,
      structuredContent: { detail: 'partial', credential_handle: 'handle-value-xyz' },
    }) as T;
  expect(JSON.stringify(r.clean(await r.call('create_site', {})))).not.toContain(
    'handle-value-xyz',
  );
});

test('read-only list covers only exposed tools, and new destructive tools still require --write', async () => {
  const exposed = new Set([...SERVICES.pages.tools, ...SERVICES.sites.tools]);
  for (const name of READS) expect(exposed.has(name)).toBe(true);
  for (const [service, tool] of [
    ['pages', 'trash_page'],
    ['pages', 'update_page_sharing'],
    ['sites', 'delete_site'],
  ] as const) {
    const f = fake(service);
    expect((await remote(args(service, 'call', tool), f.r)).error?.code).toBe('write_required');
    expect(f.starts()).toBe(0);
  }
});

test('secret environment variable values are not printed', async () => {
  const f = fake('sites');
  f.r.call = async (): Promise<Result> => ({
    ok: true,
    data: {
      entries: [
        { key: 'API_KEY', value: 'live-secret-value', is_secret: true },
        { key: 'MODE', value: 'prod' },
      ],
    },
  });
  const result = await remote(
    args('sites', 'call', 'get_environment_variables', '--args', '{"project_id":"x"}'),
    f.r,
  );
  expect(JSON.stringify(result)).not.toContain('live-secret-value');
  expect(result.data.entries[1].value).toBe('prod');
});
