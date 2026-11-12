// error.code として出力する失敗の種類。Agent が「引数を直す」「環境を直す」「結果を確認する」を区別できるようにする。
export type ErrorCode =
  | 'invalid_arguments'
  | 'write_required'
  | 'codex_unavailable'
  | 'tool_unavailable'
  | 'interaction_required'
  | 'plugin_unavailable'
  | 'source_error'
  | 'browser_unavailable'
  | 'browser_busy'
  | 'browser_delivery_unknown'
  | 'browser_turn_failed'
  | 'browser_wait_timeout';

export class CliError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
