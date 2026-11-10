# codex-bridge

このMacのComputer Historyと、Codexに接続済みのChatGPT Pages・Sites、Codexの画像生成を、ほかのAgentからコマンドで使うためのBun CLI。

- 結果は1行のJSON。終了コードは成功0、取得・検証・実行の失敗1、構文エラー2。失敗の種類は`error.code`で返す（一覧は`skills/codex-bridge/SKILL.md`）。
- Pages・Sitesは既存のCodex app-serverと、そのログイン・workspaceの権限で呼び出す。新しいサーバー、待受ポート、認証は追加しない。
- モデルを使うのは`image generate`だけ。ChatGPTのプランの利用枠を消費する。
- 変更操作は`--write`がないと送信前に拒否する。

## 注意

- 非公式のツールで、OpenAIとの提携・承認関係はない。Codex・ChatGPTはOpenAIの商標。
- 自分のアカウントを、自分の端末から使うためのもの。他人やほかの人のAgentに使わせない。
- 各サービスの規約（OpenAIのTerms of Use・Service Terms・Usage Policies、ChatGPT Sites Terms等）がそのまま適用される。利用しているプランの規約で、プログラムからの利用に関する条項を確認してから使う。
- CLIは`codex-bridge-cli`という名前でCodex app-serverに接続する。workspaceの管理者が見られるログに記録されることがある。
- Pages・Sitesの変更操作は、Codexの承認画面を経由しない。`--write`の付与と、利用者自身の了承が確認になる。
- Computer Historyの生イベント（`--details`）には、キー入力や画面上のテキストが含まれる。ほかの人とのやり取りが含まれる時間帯のデータを、別のAIサービスへ渡さない。

## 前提

- macOS（Apple Silicon）
- ChatGPT.appに同梱されたCodex：`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`。Pages・Sitesのconnectorへログイン済みであること。
- PATH上のBun 1.4.4以降。binの`src/cli.ts`は`#!/usr/bin/env bun`で始まり、どの方法で入れてもBunがTypeScriptを直接実行する。buildは不要。
- Computer Historyの保存先：`~/.codex/memories/extensions/skysight/resources`とComputer Historyのローカルevent segments。
- `sites call source_prepare`のみ、CodexのSites pluginの梱包スクリプト（`~/.codex/plugins/cache/openai-curated-remote/sites/<版>/scripts/package-site.mjs`）。複数版あれば最新版を使う。

## インストール

npmから入れる。

```sh
npm install -g @yuki-yano/codex-bridge   # または bun add -g @yuki-yano/codex-bridge
command -v codex-bridge
codex-bridge --help
```

リポジトリのcheckoutから使う場合は、依存を入れて`bun link`で登録する。コマンドはcheckoutの`src/cli.ts`を直接指し、編集は保存した時点で反映される。

```sh
cd /path/to/codex-bridge
nix develop -c pnpm install --frozen-lockfile
bun link
```

同名の別コマンドがPATHの前にあると、そちらが起動する。`command -v codex-bridge`で起動先を確認する。

## 開発

```sh
direnv allow        # または nix develop
pnpm install
pnpm check          # format:check、lint、typecheck、test
pnpm format         # oxfmtで整形
```

dev shellはbun、node、pnpmを提供する（`flake.nix`）。`package.json`の`packageManager`と`engines.bun`は、`flake.lock`のnixpkgsが提供する版に合わせる。`nix flake update`で版が変わったら両方を揃える。

| スクリプト | 内容 |
| --- | --- |
| `pnpm lint` | oxlint |
| `pnpm format:check` | oxfmt --check |
| `pnpm typecheck` | tsc --noEmit |
| `pnpm test` | bun test |

`src/cli.ts`がbinの入口と引数解析、`src/codex.ts`がCodex app-serverとの接続、`src/history.ts`がComputer History、`src/remote.ts`がPages・Sitesの中継とスキーマ検証、`src/source.ts`がSitesのソース操作、`src/image.ts`が画像生成。

## 使い方

```sh
codex-bridge --help
codex-bridge history status
codex-bridge pages tools
codex-bridge sites tools
```

`tools`で対象サービスの操作一覧、`tools <名前>`で現行の説明とJSON Schemaを確認する。`call <名前> --args ...`でそのスキーマの引数を渡す。CLIが必須項目・未定義引数・型・範囲を検証してから送る。結果の`data`は元サービスの構造を保持する。`next_cursor`等があれば同じ条件で続きを取得し、最初の一覧や検索結果だけを全件としない。

引数はJSON文字列のほか、`--args @/絶対パス/args.json`（ファイル）や`--args -`（標準入力）も使える。長い本文はファイルか標準入力にし、shellによる改行・引用符の変形を避ける。

### Computer Historyを読む

保存済み要約と生イベントを読み取り専用で使う。記録の開始・停止・設定変更はしない。

```sh
codex-bridge history status

codex-bridge history summaries \
  --start '2026-11-06T09:00:00+09:00' --end '2026-11-06T12:00:00+09:00' \
  --query '検索語' --max-chars 20000

codex-bridge history events \
  --start '2026-11-06T11:00:00+09:00' --end '2026-11-06T11:10:00+09:00' \
  --limit 3 --offset 0
```

開始時刻を含み、終了時刻は含まない。タイムゾーン必須。生イベントの`data`はJSONオブジェクトで、既定では時刻・アプリ・ウィンドウだけを返す。AX・キーボード・マウス・選択範囲は`--details`を付けたときだけ含め、長い文字列は約4000文字で切る。

### Pagesを読む

```sh
codex-bridge pages tools list_pages
codex-bridge pages call list_pages --args '{"limit":5}'
codex-bridge pages call find_pages --args '{"query":"検索したい内容"}'
codex-bridge pages call read_page --args '{"page_id":"実際に取得したPageのID","view":"full"}'
```

対象はページの検索・一覧・本文参照・作成・編集・移動・コメント・ゴミ箱への移動・共有・自動更新、ネイティブ文書の作成・編集など。使えるツールは`pages tools`で確認する。

### Sitesを読む

```sh
codex-bridge sites tools
codex-bridge sites call list_sites --args '{"limit":5}'
codex-bridge sites tools source_prepare
```

`sites tools source_prepare`の`packager.path`が、`source_prepare`で実際に使う梱包スクリプト。見つからない場合は`packager.error`に探索場所と対処（CodexでSites pluginを導入・更新）が出る。

### 画像を生成する

```sh
codex-bridge image generate --prompt '白い背景に青い正方形のアイコン' --out ./icon.png
codex-bridge image generate --prompt 'この写真を水彩画風に' --input ./photo.jpg --out ./watercolor.png
```

Codexのモデルに、画像生成ツールで1枚だけ生成させる。1回に30秒前後かかり、ChatGPTのプランの利用枠を消費する。結果の`data.path`が画像のパス（`--out`を指定した場合はそのパス、指定しない場合はCodexの保存先`~/.codex/generated_images/`）。`--out`に既存のファイルは指定できない。

## 変更する場合

Pages・Sitesの作成・編集・削除・共有・公開やSitesのソース操作（`source_checkout`・`source_prepare`）には`--write`が必須。付けない場合はCodexへ接続する前にエラーにする。これは操作ミスを防ぐための指定であり、ユーザーの依頼や承認に代わるものではない。

Sitesのリポジトリ認証情報を返すツール（`create_source_repository_write_credential`）はCLIの公開対象から外し、ソース操作の中で同じSiteの一時認証を取得する。tokenや`credential_handle`は出力しない。

## Agentから使う

Agent向けの手順と運用ルール（書き込みの条件、Pagesの編集手順、Sitesのソース操作と公開、Computer Historyの読み方、画像生成）は`skills/codex-bridge/`にある。使うハーネスのskillの置き場所へコピーする。Codexでpages・sitesのconnectorを直接使えるときは対象外。

```sh
cp -R skills/codex-bridge ~/.claude/skills/   # Claude Codeの例
```

## 別Agent・別端末から

同じMacならどのAgentもこのコマンドを呼べる。Pages・SitesはCodexの既存ログイン先・選択中workspaceの権限を使い、呼出し元AgentのGoogle/Notionや仕事・個人のアカウント指定とは連動しない。

自分の別端末のAgentからは、既存のSSH等でこのMac上のコマンドを実行する。非対話のSSHではPATHが異なることがあるため、このMacで`command -v codex-bridge`が返すパスを使う。SSH経由の実行は未検証。

```sh
printf '%s' '{"limit":5}' | ssh Macの接続名 \
  /codex-bridgeの絶対パス pages call list_pages --args -
```

既存配置やツール仕様が変わった場合はエラーとして止まり、旧版へ切り替えたり別認証を作ったりしない。

公式app-serverの仕様： https://learn.chatgpt.com/docs/app-server
