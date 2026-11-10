import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Command } from './cli.ts';
import { CODEX, CodexSession } from './codex.ts';
import { CliError } from './errors.ts';
import { scrub } from './history.ts';
import { findPackager, sourceOperation } from './source.ts';

export type Service = 'pages' | 'sites';
type Spec = { namespace: string; connector: string; tools: Array<string> };

export const SERVICES: Record<Service, Spec> = {
  pages: {
    namespace: 'chatgpt_space',
    connector: 'connector_openai_pages',
    tools: [
      'find_pages',
      'list_pages',
      'list_spaces',
      'get_space',
      'read_page',
      'read_page_changes',
      'read_page_transcript',
      'inspect_page_reference',
      'read_page_reference',
      'create_page',
      'create_space',
      'edit_page',
      'patch_page',
      'move_page',
      'list_page_comments',
      'manage_page_comment',
      'reply_page_comment',
      'trash_page',
      'trash_space',
      'edit_page_metadata',
      'create_page_visualization',
      'search_page_file_references',
      'write_page_reference',
      'get_sharing_availability',
      'get_page_sharing',
      'get_space_sharing',
      'search_sharing_recipients',
      'update_page_sharing',
      'update_space_sharing',
      'list_page_automations',
      'get_page_auto_update',
      'set_page_auto_update',
      'run_page_auto_update',
      'attach_automation_to_page',
      'create_controller_automation',
      'create_presentation',
      'inspect_artifact',
      'execute_artifact_code',
      'get_artifact_execution_status',
    ],
  },
  sites: {
    namespace: 'sites',
    connector: 'connector_20205bf7d4e99a89d7154bb849718324',
    tools: [
      'list_sites',
      'get_site',
      'list_site_versions',
      'get_site_version',
      'create_site',
      'create_source_repository_write_credential',
      'update_site_metadata',
      'save_site_version',
      'save_version_and_deploy_private',
      'deploy_private_site_version',
      'deploy_site_version',
      'get_deployment_status',
      'check_slug_availability',
      'delete_site',
      'change_site_slug',
      'update_site_access',
      'add_custom_domain',
      'list_custom_domains',
      'refresh_custom_domain_status',
      'remove_custom_domain',
      'get_site_analytics_overview',
      'list_site_analytics_events',
      'query_site_analytics_event',
      'get_site_worker_logs',
      'read_database_overview',
      'read_database_table_rows',
      'get_environment_variables',
      'update_environment_variables',
      'create_schedule',
    ],
  },
};

export const READS = new Set([
  'find_pages',
  'list_pages',
  'list_spaces',
  'get_space',
  'read_page',
  'read_page_changes',
  'read_page_transcript',
  'inspect_page_reference',
  'read_page_reference',
  'list_page_comments',
  'list_sites',
  'get_site',
  'list_site_versions',
  'get_site_version',
  'get_deployment_status',
  'check_slug_availability',
  'search_page_file_references',
  'get_sharing_availability',
  'get_page_sharing',
  'get_space_sharing',
  'search_sharing_recipients',
  'list_page_automations',
  'get_page_auto_update',
  'inspect_artifact',
  'get_artifact_execution_status',
  'list_custom_domains',
  'get_site_analytics_overview',
  'list_site_analytics_events',
  'query_site_analytics_event',
  'get_site_worker_logs',
  'read_database_overview',
  'read_database_table_rows',
  'get_environment_variables',
]);

const CREDENTIAL_TOOL = 'create_source_repository_write_credential';

const HELPERS: Record<string, ToolDef> = {
  source_checkout: {
    description:
      '同じSiteの一時認証を内部で取得し、Siteのソースを新しい空ディレクトリへcloneする。認証情報は出力しない。',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      required: ['project_id', 'project_dir'],
      additionalProperties: false,
      properties: { project_id: { type: 'string' }, project_dir: { type: 'string' } },
    },
  },
  source_prepare: {
    description:
      '承認済みcommitのsnapshotでcommandsを実行し、Sites pluginのpackage-site.mjsで梱包してから、同じSiteの一時認証で通常pushする。commitは作らない。',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      required: ['project_id', 'project_dir', 'archive_path', 'commands'],
      additionalProperties: false,
      properties: {
        project_id: { type: 'string' },
        project_dir: { type: 'string' },
        archive_path: { type: 'string' },
        commands: {
          type: 'array',
          items: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
      },
    },
  },
};

export type ToolDef = {
  description?: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean };
  _meta?: { connector_id?: string };
};
export type ErrorBody = {
  code: string;
  message: string;
  commit_status?: string;
  retryable?: false;
  source?: unknown;
};
// data は各サービスのJSONをそのまま返すため型を固定しない。
export type Result = {
  ok: boolean;
  data?: any;
  images?: Array<{ path: string; mime_type: string }>;
  error?: ErrorBody;
};

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };
type ToolOutput = { structuredContent?: unknown; content?: Array<ContentBlock>; isError?: boolean };
type ServerStatusPage = {
  data?: Array<{ name: string; tools?: Record<string, ToolDef> }>;
  nextCursor?: string;
};

// 認証情報を表すキー。値ごと出力から除く。
const SECRET_KEYS =
  /^(?:token|access_token|refresh_token|client_secret|password|authorization|credential_handle|[a-z_]*bearer_token)$/i;

const unknownWrite = { commit_status: 'unknown', retryable: false } as const;

const errorText = (error: unknown) =>
  typeof error === 'string'
    ? error
    : typeof (error as { message?: unknown })?.message === 'string'
      ? (error as { message: string }).message
      : JSON.stringify(error).slice(0, 2000);

export class Relay extends CodexSession {
  catalog: Record<string, ToolDef> = {};
  secrets = new Set<string>();
  service: Service;
  spec: Spec;

  constructor(service: Service, codex = CODEX) {
    super(codex);
    this.service = service;
    this.spec = SERVICES[service];
  }

  clean<T>(value: T): T {
    if (Array.isArray(value)) return value.map((v) => this.clean(v)) as T;
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => !SECRET_KEYS.test(k))
          .map(([k, v]) => [k, this.clean(v)]),
      ) as T;
    if (typeof value === 'string') {
      let text: string = value;
      for (const secret of [...this.secrets].toSorted((a, b) => b.length - a.length))
        text = text.replaceAll(secret, '[redacted]');
      return text as T;
    }
    return value;
  }

  // 認証tokenとして十分長い値だけを覚える。短い値まで置換すると無関係な出力が壊れる。
  capture(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const token = (value as { token?: unknown }).token;
    if (typeof token === 'string' && token.length >= 16) this.secrets.add(token);
    for (const v of Object.values(value)) this.capture(v);
  }

  async start(): Promise<void> {
    const c = this.spec.connector;
    await this.launch([
      'apps._default.enabled=false',
      `apps.${c}.enabled=true`,
      `apps.${c}.default_tools_enabled=false`,
      `apps.${c}.destructive_enabled=true`,
      ...this.spec.tools.map((n) => `apps.${c}.tools.${n}.enabled=true`),
    ]);
    let cursor: string | undefined;
    do {
      const result: ServerStatusPage = await this.rpc<ServerStatusPage>('mcpServerStatus/list', {
        threadId: this.thread,
        serverName: 'codex_apps',
        limit: 100,
        detail: 'toolsAndAuthOnly',
        ...(cursor ? { cursor } : {}),
      });
      for (const server of result.data ?? [])
        if (server.name === 'codex_apps')
          for (const [name, def] of Object.entries(server.tools ?? {})) {
            const short = name.slice(this.spec.namespace.length + 1);
            if (
              name === this.spec.namespace + '.' + short &&
              this.spec.tools.includes(short) &&
              // oxlint-disable-next-line no-underscore-dangle -- MCP のツール定義が持つフィールド名
              def._meta?.connector_id === c
            )
              this.catalog[short] = def;
          }
      cursor = result.nextCursor;
    } while (cursor);
  }

  // 呼ぶツールだけを必須にする。上流で別のツールが消えても、ほかのツールは使える。
  ensureTools(names: Array<string>): void {
    const missing = names.filter((n) => !this.catalog[n]);
    if (missing.length)
      throw new CliError(
        'tool_unavailable',
        `Not available from Codex: ${missing.join(', ')}; check the ${this.service} connection in Codex`,
      );
  }

  async saveImages(
    blocks: Array<ContentBlock>,
  ): Promise<Array<{ path: string; mime_type: string }>> {
    const images = blocks.filter((b) => b.type === 'image' && b.data);
    if (!images.length) return [];
    const dir = await mkdtemp(join(tmpdir(), 'codex-bridge-'));
    return Promise.all(
      images.map(async (b, i) => {
        const mime = b.mimeType ?? 'application/octet-stream';
        const path = join(
          dir,
          `image-${i + 1}.${mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin'}`,
        );
        await writeFile(path, Buffer.from(b.data!, 'base64'));
        return { path, mime_type: mime };
      }),
    );
  }

  async call(name: string, args: object): Promise<Result> {
    const readonly = READS.has(name);
    // 変更操作の失敗は、サービスが反映状況を返さない限り結果不明として扱う。再実行による重複作成を防ぐ。
    const writeStatus = (status?: unknown) =>
      readonly
        ? {}
        : {
            commit_status: typeof status === 'string' ? status : 'unknown',
            retryable: false as const,
          };
    try {
      const raw = await this.rpc<ToolOutput>('mcpServer/tool/call', {
        threadId: this.thread,
        server: 'codex_apps',
        tool: this.spec.namespace + '.' + name,
        arguments: args,
      });
      const blocks = raw.content ?? [];
      const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '');
      let data: any = raw.structuredContent;
      if ((data === undefined || data === null) && texts.length === 1)
        try {
          data = JSON.parse(texts[0]!);
        } catch {}
      const images = await this.saveImages(blocks);
      if ((data === undefined || data === null) && !images.length) {
        if (raw.isError && texts.length)
          return {
            ok: false,
            error: {
              code: 'tool_error',
              message: scrub(texts.join('\n')).slice(0, 2000),
              ...writeStatus(),
            },
          };
        throw new Error(
          texts.length === 1
            ? 'Non-JSON tool output withheld; check operation before retrying'
            : 'Unexpected tool output withheld; check operation before retrying',
        );
      }
      this.capture(data);
      const failed = Boolean(raw.isError) || Boolean(data?.error);
      return {
        ok: !failed,
        data,
        ...(images.length ? { images } : {}),
        ...(failed
          ? {
              error: {
                code: 'tool_error',
                message: scrub(
                  errorText(this.clean(data?.error ?? data ?? 'Tool reported an error')),
                ),
                ...writeStatus(data?.error?.commit_status ?? data?.commit_status),
              },
            }
          : {}),
      };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'transport_error',
          message: (e as Error).message,
          ...(!readonly ? unknownWrite : {}),
        },
      };
    }
  }

  async close(): Promise<void> {
    await super.close();
    this.secrets.clear();
  }
}

export async function input(
  value: string,
  stdin = () => Bun.stdin.text(),
): Promise<Record<string, unknown>> {
  if (value === '-') value = await stdin();
  else if (value.startsWith('@'))
    value = await readFile(value.slice(1), 'utf8').catch(() => {
      throw new CliError(
        'invalid_arguments',
        `Cannot read the arguments file ${value.slice(1)}; arguments were not sent`,
      );
    });
  let data: unknown;
  try {
    data = JSON.parse(value);
  } catch {
    throw new CliError('invalid_arguments', 'Invalid JSON; arguments were not sent');
  }
  if (!data || Array.isArray(data) || typeof data !== 'object')
    throw new CliError('invalid_arguments', 'Arguments must be a JSON object');
  return data as Record<string, unknown>;
}

// 一覧は説明の2文目までにする（1文目が別ツールへの案内のことがある）。全文は tools <名前> で読む。
const summary = (text?: string) =>
  text ? (/^(?:[\s\S]*?(?:\.(?=\s)|。)){1,2}/.exec(text)?.[0] ?? text) : undefined;

const packagerStatus = () =>
  findPackager().then(
    (path) => ({ path, plugin_root: dirname(dirname(path)) }),
    (e: Error) => ({ error: e.message }),
  );

// Codex が認証・承認を求めて止まった場合は、そのことが分かるエラーにする。
function interactionError(relay: Relay, error?: ErrorBody): ErrorBody {
  return {
    ...error,
    code: 'interaction_required',
    message:
      `Codex requested ${relay.interaction}; complete sign-in or approval in Codex, then retry` +
      (error?.message ? ` (${error.message})` : ''),
  };
}

export async function remote(
  a: Command & { service: Service },
  relay = new Relay(a.service),
): Promise<Result> {
  try {
    const data = a.action === 'call' ? await input(a.args) : {};
    const helpers = a.service === 'sites' ? HELPERS : {};
    const names = [
      ...SERVICES[a.service].tools.filter((n) => n !== CREDENTIAL_TOOL),
      ...Object.keys(helpers),
    ];
    if (a.tool && !names.includes(a.tool))
      throw new CliError('invalid_arguments', 'Tool is outside this CLI scope; use tools');
    if (a.action === 'call' && !READS.has(a.tool!) && !a.write)
      throw new CliError(
        'write_required',
        'This operation requires --write and prior authorization',
      );
    if (data.publish_on_push != null)
      throw new CliError(
        'invalid_arguments',
        'Use explicit save/deploy; publish_on_push is not supported',
      );
    try {
      await relay.start();
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(
        relay.interaction ? 'interaction_required' : 'codex_unavailable',
        relay.interaction
          ? interactionError(relay, { code: 'codex_unavailable', message: (e as Error).message })
              .message
          : (e as Error).message,
      );
    }
    const definitions: Record<string, ToolDef | undefined> = { ...relay.catalog, ...helpers };
    if (a.action === 'tools') {
      if (!a.tool) {
        const unavailable = names.filter((n) => !definitions[n]);
        return {
          ok: true,
          data: {
            tools: names
              .filter((n) => definitions[n])
              .map((name) => ({
                name,
                write_required: !READS.has(name),
                description: summary(definitions[name]?.description),
              })),
            ...(unavailable.length ? { unavailable } : {}),
          },
        };
      }
      relay.ensureTools(helpers[a.tool] ? [] : [a.tool]);
      // source_prepare は実行時に使う Sites plugin の梱包スクリプトも示す。
      const detail = definitions[a.tool];
      return {
        ok: true,
        data:
          a.tool === 'source_prepare' ? { ...detail, packager: await packagerStatus() } : detail,
      };
    }
    const tool = a.tool!;
    relay.ensureTools(helpers[tool] ? [CREDENTIAL_TOOL] : [tool]);
    if (!a.write && !definitions[tool]?.annotations?.readOnlyHint)
      throw new CliError('write_required', 'The current tool definition requires --write');
    const validator = new Ajv({ strict: false });
    addFormats(validator);
    const validate = validator.compile(definitions[tool]!.inputSchema);
    if (!validate(data))
      throw new CliError(
        'invalid_arguments',
        'Arguments do not match the current tool schema: ' +
          (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; '),
      );
    const result = helpers[tool]
      ? await sourceOperation(tool, data, relay).catch((e: Error & { receipt?: unknown }) => {
          const error = relay.interaction
            ? new CliError(
                'interaction_required',
                interactionError(relay, { code: 'source_error', message: e.message }).message,
              )
            : e instanceof CliError
              ? e
              : new CliError('source_error', e.message);
          throw Object.assign(error, { receipt: e.receipt });
        })
      : await relay.call(tool, data);
    if (!result.ok && relay.interaction) result.error = interactionError(relay, result.error);
    // 環境変数の秘密値は、サービスが返しても出力しない。
    if (tool.endsWith('_environment_variables') && Array.isArray(result.data?.entries))
      for (const entry of result.data.entries) if (entry?.is_secret) entry.value = '[redacted]';
    return relay.clean(result);
  } catch (e) {
    const { message, receipt } = e as Error & { receipt?: unknown };
    return relay.clean({
      ok: false,
      error: {
        code: e instanceof CliError ? e.code : 'cli_error',
        message: message || String(e),
        ...(receipt ? { ...unknownWrite, source: receipt } : {}),
      },
    });
  } finally {
    await relay.close();
  }
}
