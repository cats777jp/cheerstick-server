# お客様向け「デモモード」機能：管理画面へのボタン追加 調査報告

作成日：2026-09-29
作成者：Claude Code
ステータス：**調査完了・実装未着手**（KMT様の承認待ち）

指示書：`cheerstick-demo-mode-investigation-20260929.md`（KMT様貼り付け）。
**本文書は読み取り専用調査の結果であり、コード・設定・本番は一切変更していない。**

関連文書：
- `docs/spec.md` 8.4章（対抗戦ペア管理・スコアAPI）・9.4章（対抗戦スクリーン表示）
- `docs/worklog.md` 2026-09-28エントリ（100 vs 100実測、429発生の経緯）
- `docs/proposals/large-event-scaling.md`（トラックA・レート制限再設計の背景）

---

## 0. 背景・確定事項（指示書より）

- 実行場所：応援の送出（現在WebARENAで動かしているデモ本体）も含めて、本番EC2内で完結させる
- 規模・時間：各100台（100 vs 100）・60秒固定
- 操作：KMT様が管理画面で操作。お客様には別タブの対抗戦画面（表示専用）を見せる
- 画面構成（確定）：①デモをセット ②デモを開始/停止 ③表示画面を開く（リンク）

---

## 1. 調査結果の要約

### A. 応援の送出方式

- `scripts/demo/battle-demo.js`は`--url`（既定`wss://ws.cheerstick.com/cheer`）・
  `--score-url`（既定`https://api.cheerstick.com/...`）の両方をCLI引数で変更可能な、
  完全に自己完結したスクリプト。**`ws://127.0.0.1:3000/cheer`・
  `http://127.0.0.1:3000/api/v1/...`を指定するだけで、EC2内ループバック接続として
  そのまま動く**（改修不要）。
- 拮抗演出ロジック（目標比率追従・猛攻・終盤演出）は`BattleRatio`クラスに集約されており、
  外部のグローバル状態に依存しない。
- `SIGINT`/`SIGTERM`ハンドラで、全WebSocketを`close(1000, ...)`してから
  `process.exit()`する`shutdown()`が既に実装済み。**子プロセスとして起動した場合、
  親から`SIGTERM`を送るだけで安全に停止できる設計に既になっている。**
- `scripts/demo/battle-demo-prepare.js`は**既に`module.exports = { main, parseArgs,
  macForIndex }`とし、`require.main === module`ガードを備えている。** 管理APIの
  コントローラーから`require(...).main(['--yes', '--pause-other-live', ...])`のように
  **直接requireして呼び出せる**（移植不要）。ただし内部は`http://127.0.0.1:3000/api/v1`への
  HTTP自己ループ（管理API経由）で処理する設計であり、DBへの直結ではない。
- `src/db/cheerstickQueries.js`に`insertCheerLog()`が存在し、`cheer_logs`への直接INSERT
  自体（方式2）は技術的に成立する。ただし`device_id`・`user_id`・`event_id`・`target_id`の
  事前確保や、`BattleRatio`が持つ「WebSocket送信 → DB反映」の駆動方法を書き換える必要がある。
- **WebSocket経由の`count`送信は、方式1・方式2いずれを選んでも、HTTP側のレート制限
  （トラックA）の対象外である**（`ws`パッケージがHTTPサーバーの`upgrade`イベントに直接
  フックしており、Expressのミドルウェアチェーンを一切通らないため）。影響がありうるのは
  `battle-demo.js`が3秒おきに叩くスコアAPI（Express経由）と、`battle-demo-prepare.js`の
  管理API自己ループ呼び出しのみ。

### B. 管理画面・管理APIへの追加

- `public/admin/events.html`はカード単位のMPA構成。既存の「対抗戦ペア一覧」カードには
  スクリーンURLのコピーUI（`battleScreenUrl()`・input+コピーボタン）が既にあり、
  ③「表示画面を開く」リンクはこのパターンをそのまま流用できる。
- 新規セクションとしては、「試合一覧」カードの直後・「対抗戦ペア管理」カード群の手前に、
  独立した「デモ操作」カードを1枚追加するのが構造上自然（対抗戦ペアの汎用CRUDとは
  役割が異なるため）。
- `common.js`の`apiFetch()`（fetchラッパー、非2xxで`Error`を投げる統一パターン）を
  そのまま使える。ただし**admin側には既存の「ポーリングして状態表示」の実装例が無い**
  （`setTimeout`はコピー表示を1.5秒後に戻すためだけの単発物のみ）。唯一の参考実装は
  `public/battle.html`の`poll()`（`setTimeout`連鎖方式）で、これをadmin側に新規移植する
  形になる。
- 管理API（`src/routes/admin.js`）は`router.use(adminIpLimiter)`を筆頭に、
  `{error: "CODE"}`形式のエラー・201/200の使い分けという一貫した設計パターンを持つ。
  `POST /admin/demo/setup`等の命名は既存パターンと自然に一致する。
- サーバー側モジュールレベル変数で状態を持つ既存例は`rateLimit.js`の`hitCounts`のみで、
  **「pm2再起動で状態が消える」ことに対処した既存コードは無い。** 今回新規に向き合う
  必要がある論点。

### C. 安全策

- `battle-demo-prepare.js`の`findCategory()`は、名前一致するカテゴリーが無ければ
  **新規作成せず例外を投げる**。`--pause-other-live`は対象を`orgA`/`orgB`
  （デモ専用チーム）に限定してフィルタする。**この2点が「デモ専用カテゴリー・チーム以外に
  一切影響しない」ことの一次的な保証点であり、既に実装済み。**
- トラックA実装後の`adminIpLimiter`は既定20000req/15分（旧・単一500req/15分から
  40倍に緩和済み）。9/28に実際に起きた429は、トラックA実装**前**の単一500req/15分制限に
  よるもので、現在は再発しにくい状態（ただし127.0.0.1同一キーに集約される根本原因自体は
  変わっていない）。
- `app.set('trust proxy', 1)`により、EC2内部（127.0.0.1）からの直接アクセスは
  `X-Forwarded-For`が付かず、全リクエストが同一キー`127.0.0.1`に積み上がる。ただし
  現在の制限値（`adminIpMax=20000`・`scoreIpMax=6000`、いずれも15分単位）に対し、
  デモ1回あたりの想定リクエスト数（デバイス登録・作成系で数百件、スコアポーリングで
  60秒÷3秒=20件程度）は十分小さく、余裕がある。
- pm2の設定ファイル（`ecosystem.config.js`等）はリポジトリに存在せず、`cheerstick-server`
  本体に`SIGTERM`/`SIGINT`ハンドラは無い。**方式1（子プロセス`spawn`）を採る場合、
  `pm2 restart`時に子プロセスをkillする明示的な後始末コードを親側（`src/`のどこか）に
  追加しない限り、子プロセスがorphan化するリスクがある。** これは今回新規に実装が必要な点。

---

## 2. 推奨する送出方式（A-3）

**方式1（管理APIから、子プロセスとして`battle-demo.js`相当を起動する）を推奨する。**

理由：

1. `battle-demo.js`は既に`--url`/`--score-url`のCLI引数だけでEC2内ループバック接続に
   対応しており、**スクリプト自体の改修が実質不要**（9/28の100 vs 100テストで実際に
   動作実績のあるコードをそのまま使える）。
2. WebSocket `connect`/`count`という**実際の応援送出経路を通る**ため、デモが同時に
   「本番相当の経路が正しく動いているか」の簡易な動作確認としても機能する。方式2
   （DB直接操作）はこの経路を迂回するため、見た目のためだけの演出になり動作確認としての
   意味が薄れる（指示書A-2にも同じ懸念が明記されている）。
3. `battle-demo.js`は`SIGTERM`/`SIGINT`での確実な停止処理（`shutdown()`）と、
   `--duration-ms`による固定時間後の自動終了を既に備えており、②「デモを開始/停止」の
   要件（60秒で自動終了・途中で即時停止）を、**親プロセス側は「起動」「シグナル送信」
   「終了検知」だけを実装すれば満たせる**。
4. 懸念点（子プロセスのpm2再起動時のorphan化リスク）は、`cheerstick-server`起動時に
   `process.on('exit'|'SIGINT'|'SIGTERM', ...)`で追跡中の子プロセスをkillする処理を
   追加するだけで対処できる、限定的な追加実装で済む。

方式2は、`BattleRatio`の駆動方法（WebSocket送信→DB反映）を丸ごと書き換える必要があり、
実装量が方式1より大きく、かつ実際の応援経路を通らないため「動作確認」としての価値が
下がる。今回は採用しない。

---

## 3. 管理APIのエンドポイント案・既存スクリプトの再利用方針

### 3.1 エンドポイント案

既存の管理API命名規則（`src/routes/admin.js`、`{error: "CODE"}`形式、
`adminIpLimiter`適用）にそのまま合わせる。

```
POST /admin/demo/setup
  body: 無し（安全のため、カテゴリー名・チーム名・規模等はサーバー側で固定値として
        ハードコードし、リクエストボディからの上書きを一切受け付けない設計とする）
  動作：
    - 実行中（running=true）なら 409 { error: "DEMO_RUNNING" }
    - 既存のセット済みバトルがあれば、先に battle-demo-prepare.js の
      --finish-run 相当で自動終了させてから、新規に作成し直す
      （指示書①「前回のデモ試合があれば自動で終了し」に対応）
    - battle-demo-prepare.js の main(['--yes', '--pause-other-live',
      '--category-name=デモ用', ...]) を in-process で呼び出す
    - 成功時 201 { battle_id, event_a_id, event_b_id, screen_url }

POST /admin/demo/start
  body: 無し
  動作：
    - setup未実行なら 400 { error: "DEMO_NOT_SETUP" }
    - 既に実行中なら 409 { error: "DEMO_RUNNING" }
    - battle-demo.js を子プロセスとして spawn
      （--url=ws://127.0.0.1:<port>/cheer、--score-url=.../event-battles/:id/score、
      --duration-ms=60000、9/28実測で使用した --burst --target-range 等を固定値で付与）
    - 成功時 200 { status: "running", remaining_ms: 60000 }

POST /admin/demo/stop
  body: 無し
  動作：
    - 実行中でなければ 409 { error: "DEMO_NOT_RUNNING" }
    - 追跡中の子プロセスへ SIGTERM を送り、running=false に更新
    - 成功時 200 { status: "stopped" }

GET /admin/demo/status
  動作：
    - { setup: boolean, running: boolean, battle_id, remaining_ms, screen_url }
      を返す（画面側はこれを1〜2秒間隔でポーリングし、ボタンの活性/非活性・
      残り秒数を表示する）
```

### 3.2 既存スクリプトの再利用方針

- `battle-demo-prepare.js`：**移植不要。** `require('../../scripts/demo/battle-demo-prepare').main(argv)`
  を`await`で呼ぶだけでよい（既に`module.exports`済み、CLIエントリポイントと
  ロジックが分離されている）。内部のHTTP自己ループ（`http://127.0.0.1:3000/api/v1`
  既定）はそのまま機能する。
- `battle-demo.js`：**改修不要。** `child_process.spawn('node', ['scripts/demo/battle-demo.js',
  '--url=ws://127.0.0.1:<port>/cheer', ...], { cwd: <repo root>, stdio: 'pipe' })`
  で起動し、標準出力は診断用にサーバー側でバッファ・ログ出力する。
- 状態管理：新規モジュール（例：`src/services/demoState.js`）にモジュールレベルの
  オブジェクトとして`{ setupBattleId, eventAId, eventBId, childProcess, startedAt,
  durationMs }`を持つ。既存に類例が無いため今回新規設計となるが、後述の安全策で
  リスクを許容範囲に抑える。

---

## 4. 安全策の設計案

1. **デモ専用対象の固定：** `/admin/demo/*`のいずれのエンドポイントも、カテゴリー名・
   チーム名・規模・時間をリクエストボディから受け付けない（固定値のみ）。
   `battle-demo-prepare.js`の`findCategory()`が「デモ用」カテゴリー不在時に例外を
   投げる既存の安全弁と合わせ、二重の保護とする。
2. **他のlive試合への不干渉：** `--pause-other-live`は`orgA`/`orgB`（デモ専用チーム）に
   限定されている既存実装をそのまま使う（改修不要）。
3. **レート制限：** 現行の`adminIpLimiter`（20000/15分）・`scoreIpLimiter`（6000/15分）は
   デモ1回あたりの想定リクエスト数に対し十分な余裕があることを確認済み。追加の緩和・
   除外設定は不要と考えるが、実装後のローカル確認で実際のリクエスト数を計測し、
   閾値に対する余裕を再確認する。
4. **停止の確実性：** ②「停止」ボタンは、追跡中の子プロセスへ`SIGTERM`を送るのみ
   （`battle-demo.js`側の既存`shutdown()`が処理する）。一定時間（例：5秒）応答が無い
   場合は`SIGKILL`で強制終了するタイムアウト処理を追加する。
5. **pm2再起動時の孤立防止（新規実装が必要な点）：** `cheerstick-server`起動時に
   `process.on('exit')`・`process.on('SIGINT')`・`process.on('SIGTERM')`のいずれかで、
   追跡中の子プロセスが存在すれば`kill()`する処理を追加する。デモ実行中にpm2 restartが
   起きた場合、デモ試合が`live`のまま残る可能性があるが、これは指示書0章で
   「実機のイベント運用中に、同時にデモを動かすことは想定しない」とされている運用上の
   前提と同様、通常運用では稀なケースと考える。万一残った場合も、既存の管理画面の
   「終了を取り消す」等の操作（spec.md 8.1章）で手動回復可能。

---

## 5. 見積もりと優先度の提案

### 見積もり

- 管理API（状態モジュール・4エンドポイント・prepare.jsのin-process呼び出し配線）：
  実装+ローカル確認で概ね半日程度
- 子プロセス起動・停止・pm2終了時のkill処理：概ね半日程度
  （`battle-demo.js`・`battle-demo-prepare.js`自体の改修は不要なため、比較的小さい）
- 管理画面UI（新規カード・状態ポーリングJS）：概ね半日程度
- 結合確認（pg-mem疑似DB＋実際の子プロセスspawnによるend-to-end確認、
  27項目・26チェックの回帰確認含む）：概ね半日程度

合計、実装からローカル確認までで**1〜2セッション程度**（既存の類似機能実装
（対抗戦ペア管理等）の実績ベース）。本番デプロイ・実機確認は別途。

### 優先度の提案

「A（送出方式）→B（管理API・状態モジュール）→子プロセス起動配線→UI→結合確認」の順を
提案する。理由：Aで方式1を確定させたことで状態モジュールの形（子プロセスの有無を含む）が
決まるため、まずB（エンドポイントの骨格・状態モジュール・prepare.jsの配線）から着手し、
次に子プロセスのspawn/kill（Aの実装）を組み込み、最後にUIを載せる方が手戻りが少ないと
考える。安全策（C）は独立フェーズではなく、各ステップに組み込みながら実装する
（固定値ハードコード・pm2終了時kill処理など）。

---

## 6. あわせての懸念点

- `battle-demo.js`・`battle-demo-prepare.js`のどちらも実装済みロジックをほぼそのまま
  再利用できるため、コードの重複はほぼ発生しない見込み（新規実装は主に管理API・
  状態モジュール・UI側に閉じる）。
- `battle-demo-prepare.js`のHTTP自己ループ（管理APIから管理API自身を呼ぶ構造）は
  一見特殊に見えるが、既にEC2外部から実運用されているのと同じ経路（HTTP経由）を
  in-processで呼ぶだけであり、機能的には等価と考えられる。念のため結合確認で
  実際に動作することを確認する。

---

## 実装の指示書は、KMT様の承認を受けてから出す。
