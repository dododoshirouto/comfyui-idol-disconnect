# ComfyUI フロントエンド拡張「idle_disconnect」実装仕様

## 1. 目的

RunPod Serverless（Load Balancer 型）上の ComfyUI を、ブラウザで開きっぱなしにしてもワーカーが止まるようにする。

ComfyUI の画面は、開いている間ずっと WebSocket と HTTP の通信を続けるため、RunPod から見るとアイドルにならず、ワーカーが起動しっぱなしになる（過去に 17 時間起動し続けた）。そこで、一定時間「操作も生成もない」状態が続いたら、ブラウザ側から通信を完全に止める。

## 2. 前提となる構成（変更しない）

- ブラウザ → Cloudflare Worker（認証・中継）→ RunPod Load Balancer エンドポイント → ComfyUI（ポート 8188）
- Worker は `/__idle` で「切断しました」画面を返す（別ドキュメント「Cloudflare Worker 変更仕様」で追加する）。この画面は RunPod に一切通信しない。
- RunPod のアイドルタイムアウトは 300 秒。通信が止まれば、その後ワーカーが停止する。
- ComfyUI のバージョン：0.42.0（コミット `19ae172` 時点のソースで確認）。フロントエンド：`comfyui-frontend-package` 1.57.1。
- Network Volume 上の `/runpod-volume/ComfyUI/custom_nodes_dev/` が、カスタムノードの探索パスに入っている（`extra_model_paths.yaml` の `custom_nodes` 指定）。

## 3. 機能要件

### 3.1 切断の条件

- 基準時刻 = 「最終操作入力の時刻」と「最終生成終了の時刻」と「ページ読み込み時刻」のうち、最も新しいもの。
- 基準時刻から **切断までの時間**（既定 5 分）が経過したら切断する。
- **キューに処理が残っている間（実行中または待ち）は、切断も警告表示もしない。** 経過時間の計測は、キューが空になった時点から始め直す。

### 3.2 最終操作入力として数えるもの

- `pointerdown`、`pointermove`、`keydown`、`wheel`、`touchstart`（いずれも `window` に、`capture: true`、`passive: true` で登録する）。
- `pointermove` は頻度が高いので、最終時刻の更新は 1 秒に 1 回までに間引く。

### 3.3 最終生成終了として数えるもの

- ComfyUI の通知 `execution_success`、`execution_error`、`execution_interrupted` を受け取った時刻。
- `status` の通知で、キュー残数（`queue_remaining`）が 1 以上から 0 に変わった時刻。

### 3.4 警告表示

- 切断までの残り時間が **警告開始時間**（既定 3 分）以下になったら、画面にカウントダウンを表示する。
- 文言：`操作がないため、あと N分NN秒 で切断します（GPU の課金を止めるため）`。秒は 2 桁で表示し、1 秒ごとに更新する。
- 表示位置：画面右下に固定。ComfyUI の操作を妨げないこと。クリックで閉じる仕組みは不要。表示中に操作すれば、基準時刻が更新されて表示は消える。
- キューに処理が残っている間は表示しない。

### 3.5 切断の動作

- `location.replace("/__idle")` で、Worker の切断画面に移動する。
- これにより、WebSocket・定期通信・タイマーがすべて止まる（ページごと移動するため、ComfyUI 側の再接続処理も動かない）。
- `replace` を使うのは、ブラウザの「戻る」で ComfyUI に戻って通信が再開されることを防ぐため。

### 3.6 設定（ComfyUI の設定画面に追加）

| id | 表示名 | 型 | 既定値 | 範囲 |
|---|---|---|---|---|
| `IdleDisconnect.Enabled` | 無操作時に自動切断する | boolean | true | — |
| `IdleDisconnect.TimeoutMinutes` | 切断までの時間（分） | number | 5 | 1〜120、刻み 1 |
| `IdleDisconnect.WarnMinutes` | 警告表示を始める残り時間（分） | number | 3 | 0〜60、刻み 1（0 なら表示しない） |

- `WarnMinutes` が `TimeoutMinutes` 以上の値になっている場合は、`TimeoutMinutes` と同じ値として扱う（読み込み時点から表示する）。
- 設定値は判定のたびに読み直し、変更が即座に反映されるようにする。
- 設定の保存先は ComfyUI の `user/` 配下（Network Volume）なので、ワーカーが再起動しても残る。

### 3.7 対象外

- 複数タブの連携はしない。タブごとに独立して判定する（全タブが無操作になるまでワーカーは止まらない。これは仕様どおりの動作とする）。
- Worker を経由しないアクセス（ComfyUI に直接つないだ場合）は考慮しない。

## 4. 実装方法（確認済みの事実）

以下は、ComfyUI 本体とフロントエンド 1.57.1 のソースで確認済み。推測で書き換えないこと。

| 事実 | 出典 |
|---|---|
| カスタムノードのモジュールに `WEB_DIRECTORY` があれば、そのフォルダが Web 用として登録される。登録はノード定義の有無より前に行われる | ComfyUI `nodes.py`（2299〜2302 行目付近） |
| `NODE_CLASS_MAPPINGS` が `None` でなければ、空の辞書でも読み込み成功として扱われる | 同 `nodes.py`（2305 行目付近） |
| 拡張の JS からは `import { app } from "../../scripts/app.js"` と `import { api } from "../../scripts/api.js"` で読み込める（`/scripts/app.js`・`/scripts/api.js` は `window.comfyAPI` を再公開する互換用ファイル） | フロントエンド 1.57.1 の `static/scripts/app.js`・`api.js` |
| `app.registerExtension({ name, settings, setup })` の `settings` 配列は、各要素が設定として登録される | フロントエンド 1.57.1（`registerExtension` 内の `o.settings?.forEach(addSetting)`） |
| 設定定義の形：`{ id, category, name, type: "number", attrs: { min, max, step }, defaultValue }` | フロントエンド 1.57.1 の組み込み設定（例：`Comfy.TooltipDelay`） |
| 設定値の取得：`app.extensionManager.setting.get(id)` | フロントエンド 1.57.1 の組み込み拡張の使用例 |
| `api.addEventListener("status", e => …)` の `e.detail` は `{ exec_info: { queue_remaining } }`（`null` の場合あり） | フロントエンド 1.57.1 `api` の `case "status"` と、ComfyUI `server.py`（1396 行目付近） |
| `execution_success`・`execution_error`・`execution_interrupted`・`execution_start` は `api.addEventListener(<名前>, …)` で受け取れる | フロントエンド 1.57.1 `api` の分岐、ComfyUI `execution.py`（539・702・715・828 行目付近） |

### 4.1 ファイル構成

リポジトリ `torilab-ai/subski-runpod-comfyui-backend` に、次を追加する。

```
custom_nodes/idle_disconnect/
├── __init__.py
└── js/
    └── idle_disconnect.js
```

`__init__.py`：

```python
# フロントエンド拡張のみ（ノードは登録しない）
WEB_DIRECTORY = "./js"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
```

### 4.2 `idle_disconnect.js` の構造

- `app.registerExtension({ name: "torilab.IdleDisconnect", settings: [...], setup() {...} })` で登録する。
- `setup()` の中で、操作イベント・ComfyUI 通知のリスナーを登録し、1 秒ごとの判定タイマーを開始する。
- 状態：`lastActivity`（ms）、`lastGenerationEnd`（ms）、`pageLoadedAt`（ms）、`queueRemaining`（初期値 0）、`isRunning`（`execution_start` で true、終了系の通知で false）。
- 「キューに処理が残っている」の判定は `queueRemaining > 0 || isRunning`。
- 判定タイマーは、経過時間を `Date.now()` の差で計算する。非表示タブでタイマーが間引かれても、判定が正しくなるようにするため。
- 警告表示の要素は、初回表示時に `document.body` に 1 つだけ追加し、以後は表示・非表示を切り替える。スタイルは要素のインラインスタイルで完結させる（外部 CSS ファイルを作らない）。
- 例外が起きても ComfyUI 本体の動作を止めないよう、判定処理全体を `try/catch` で囲み、失敗時は `console.warn` だけ出す。

## 5. 反映手順（1 回に 1 つの変更）

### フェーズ 1：Network Volume で試す（イメージの再ビルドなし）

1. S3 互換 API で、`custom_nodes/idle_disconnect/` 一式を `s3://<VOLUME_ID>/ComfyUI/custom_nodes_dev/idle_disconnect/` に置く。
2. RunPod のワーカーを Terminate して、Worker の URL を開き直す。
3. 起動ログに `custom_nodes_dev/idle_disconnect` の読み込みが出て、`IMPORT FAILED` がないことを確認する。

### フェーズ 2：イメージに焼き込む（動作確認が済んでから）

1. `custom_nodes/idle_disconnect/` を Dockerfile で `/ComfyUI/custom_nodes/idle_disconnect/` に `COPY` する。
2. Network Volume 上の `custom_nodes_dev/idle_disconnect/` を削除する（二重読み込みを避けるため）。
3. main にマージする（Actions がビルドし、RunPod のテンプレートを自動更新する）。

## 6. 受け入れ確認

確認の前提：Worker 側の `/__idle` が追加済みであること。確認しやすいよう、設定画面で `TimeoutMinutes` を 2、`WarnMinutes` を 1 にして行う。

| # | 操作 | 期待する結果 |
|---|---|---|
| 1 | ComfyUI の設定画面を開く | 3 つの設定項目が表示され、既定値が 5・3・有効になっている（確認前に変更した場合は除く） |
| 2 | 何も操作せずに待つ | 1 分後に右下に「あと 0分59秒 で切断します…」が表示され、1 秒ごとに減る |
| 3 | 警告表示中にマウスを動かす | 警告が消え、そこから計測し直す |
| 4 | 2 分間何もしない | `/__idle` に移動する。ブラウザの開発者ツールの Network タブで、それ以降 RunPod 経由の通信（WebSocket を含む）がないこと |
| 5 | 生成に 2 分以上かかるワークフローを実行し、操作せずに待つ | 実行中は警告も切断もしない。生成終了から 1 分後に警告、2 分後に切断する |
| 6 | `/__idle` で「戻る」を押す | ComfyUI に戻らない（`replace` のため） |
| 7 | `Enabled` を無効にして 2 分待つ | 警告も切断もしない |
| 8 | 切断から 5 分以上後に RunPod のワーカー一覧を見る | ワーカーが停止している（アイドルタイムアウト 300 秒の後） |
| 9 | ワーカーを再起動して設定画面を開く | 変更した設定値が残っている |

確認が終わったら、設定値を 5・3 に戻す。