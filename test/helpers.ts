import { type Command, parse } from '../src/cli.ts';
import { Relay, type Result, SERVICES, type Service } from '../src/remote.ts';

export const args = (...argv: Array<string>) => parse(argv) as Command & { service: Service };

export function fake(service: Service = 'pages') {
  const r = new Relay(service);
  let starts = 0;
  const calls: Array<{ name: string; data: object }> = [];
  r.start = async () => {
    starts++;
  };
  r.close = async () => {};
  r.catalog = Object.fromEntries(
    SERVICES[service].tools.map((name) => [
      name,
      {
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: /^(list_|read_|get_|find_|inspect_|check_)/.test(name) },
      },
    ]),
  );
  r.call = async (name, data): Promise<Result> => {
    calls.push({ name, data });
    return { ok: true, data: { fixture: true } };
  };
  return { r, calls, starts: () => starts };
}

export const credential = () => ({
  auth_mode: 'http_extra_header',
  token: 'fixture-secret-token-0123',
  token_expires_at: new Date(Date.now() + 600000).toISOString(),
  remote_url: 'https://example.invalid/fixture.git',
  branch: 'main',
});
