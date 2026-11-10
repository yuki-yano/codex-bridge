import { existsSync } from 'node:fs';
import { constants, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from './cli.ts';
import { CodexSession } from './codex.ts';
import { CliError } from './errors.ts';
import type { Result } from './remote.ts';

type ImageItem = {
  type: string;
  status?: string;
  savedPath?: string | null;
  revisedPrompt?: string | null;
  failure?: { type: string; limitId?: string; resetsAt?: number | null } | null;
};
type TurnDone = { turn?: { status?: string; error?: { message?: string } | null } };

// 画像生成は app-server に直接のメソッドがなく、ターンの中でモデルが画像生成ツールを使ったときだけ結果が返る。
const INSTRUCTION =
  '画像生成ツールで、次の内容の画像を1枚だけ生成してください。質問や確認はせず、ほかの作業もしないでください。\n\n';

export async function generateImage(
  a: Command,
  session = new CodexSession(),
  timeout = 600000,
): Promise<Result> {
  const prompt = a.prompt?.trim();
  if (!prompt) throw new CliError('invalid_arguments', '--prompt is required');
  const inputs = (a.input ?? []).map((path) => resolve(path));
  const missing = inputs.find((path) => !existsSync(path));
  if (missing) throw new CliError('invalid_arguments', `Input image not found: ${missing}`);
  const out = a.out ? resolve(a.out) : undefined;
  if (out && existsSync(out))
    throw new CliError('invalid_arguments', `Output file already exists: ${out}`);

  const images: Array<ImageItem> = [];
  let finish: (done: TurnDone) => void = () => {};
  const completed = new Promise<TurnDone>((r) => (finish = r));
  session.onNotification = (method, params) => {
    if (method === 'item/completed' && params?.item?.type === 'imageGeneration')
      images.push(params.item);
    if (method === 'turn/completed') finish(params ?? {});
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      await session.launch(['apps._default.enabled=false', 'features.image_generation=true']);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(
        session.interaction ? 'interaction_required' : 'codex_unavailable',
        session.interaction
          ? `Codex requested ${session.interaction}; complete sign-in or approval in Codex, then retry`
          : (e as Error).message,
      );
    }
    let done: TurnDone;
    try {
      await session.rpc('turn/start', {
        threadId: session.thread,
        input: [
          { type: 'text', text: INSTRUCTION + prompt },
          ...inputs.map((path) => ({ type: 'localImage', path })),
        ],
      });
      done = await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Image generation timed out')), timeout);
        }),
      ]);
    } catch (e) {
      return { ok: false, error: { code: 'transport_error', message: (e as Error).message } };
    }
    const image = images.find((item) => item.savedPath);
    if (!image) {
      const failure = images.find((item) => item.failure)?.failure;
      const message = failure
        ? `Image generation failed: ${failure.type}${failure.limitId ? ` (${failure.limitId})` : ''}`
        : (done.turn?.error?.message ?? 'Codex finished without generating an image');
      return {
        ok: false,
        ...(failure ? { data: { failure } } : {}),
        error: session.interaction
          ? {
              code: 'interaction_required',
              message: `Codex requested ${session.interaction} (${message})`,
            }
          : { code: 'tool_error', message },
      };
    }
    if (out) await copyFile(image.savedPath!, out, constants.COPYFILE_EXCL);
    return {
      ok: true,
      data: {
        path: out ?? image.savedPath,
        saved_path: image.savedPath,
        revised_prompt: image.revisedPrompt ?? null,
      },
    };
  } finally {
    clearTimeout(timer);
    await session.close();
  }
}
