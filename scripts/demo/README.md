# 応援合戦デモ Phase 1・Phase 2 スクリプト

`cheerstick-battle-demo-loadtest-setup-20260926.md`（元指示書）・
`cheerstick-battle-demo-phase1-2-impl-20260927.md`（本実装の指示書）に基づく、
2チーム対抗応援合戦デモ（各500台×2＝1,000接続想定）の準備・実行スクリプト。

**本番・WebARENA VPSでの実行はPhase 3・4（別途指示）で行う。ここに置かれているのは
実装とローカル確認（`local-verify.js`）まで。**

## ファイル構成

| ファイル | 実行場所 | 役割 |
|---|---|---|
| `battle-demo-prepare.js` | 本番EC2上 | カテゴリー・チームの確認、ダミーデバイス登録、試合・対抗戦ペアの作成、live化。後片付け（`--finish-run`）も兼ねる |
| `battle-demo.js` | WebARENA VPS等（負荷試験対象の外部環境） | 実際に1,000台相当のWebSocket接続を張り、拮抗演出ロジックに従ってcountを送信し続けるデモ本体 |
| `local-verify.js` | ローカル | pg-mem（インメモリ疑似DB）で実サーバーを起動し、上記2スクリプトを一気通貫で確認するハーネス |

`scripts/load-test/mac-range.js`（`macForIndex`）を流用している（`battle-demo.js`側）。

## 前提

- `src/`・`public/`・`migrations/`は一切変更していない。`battle.html`本体・スコア計算ロジックにも手を加えていない
- デバイスは事前登録が必須（未登録MACで`connect`すると`category_id`未設定の行が自動作成され、`NO_CATEGORY`で応援できない）。`battle-demo-prepare.js`が担当する
- 送信シーケンスは `connect → register → select_team → count`（`set_oshi`は送らない。`--set-oshi`指定時のみ`set_oshi`を追加）
  - **`register`（2026-10-07追加、既定で送る。`--no-register`で従来どおり省略）：** メールは`demo-<MAC小文字・コロン無し>@example.invalid`、ニックネームは`デモ応援団A-0001`形式。メールがMACから決まる固定値のため、再実行しても同じ`users`行を使い回す（サーバー側の`ON CONFLICT (email)`）。これを送らないと`cheer_logs.user_id`がNULLになり、順位確定のユーザー別集計（`INNER JOIN users`）から全件除外されて`ranking-battle.html`が空になる。登録に失敗してもデモは続行する（そのデバイスの応援は匿名で記録される）
  - **ランキング見せ用の拡張（2026-10-07追加。いずれも未指定なら従来どおりの動作）：** `--oshi-targets-a=<id,id,…>`／`--oshi-targets-b=<id,id,…>`（チームごとの選手ID。実行ごとにシャッフルして重み付きで、デバイスごとに別の選手を推しに割り当てる。`--set-oshi`より優先）、`--energy-spread`（ユーザーごとの熱量係数0.25〜1.0をintensityに掛ける。1.0を超えないのでDBの上限100を超えず、両チームに同じ分布が掛かるので比率は保たれる）、`--nickname-style=fun`（愛称をひらがな・カタカナの100種にする。既定は`plain`＝`デモ応援団A-0001`形式）。管理画面のデモモードは、デモ用チームに「デモ用ダミー選手」がいると、これらと`--mac-prefix=AA:00:00:03`（従来の`AA:00:00:02`と別の帯）を自動で付けて起動する（`src/controllers/adminDemoController.js`）。
  - **デモ用ダミー選手：** 定義は`showcase-players.js`、顔写真（自前のSVG）は`generate-demo-avatars.js`で`assets/images/demo/players/`に生成、登録は`ranking-showcase-prepare.js`（既定はdry run、`--yes`で実行、冪等）。手順は`docs/runbook.md`「デモ用ダミー選手・画像の投入とランキング見せ用デモ」、後片付けは`docs/proposals/demo-cleanup-2026-10-07.md`第7章・付録C・D。
- 遅延計測（本番DBとの突合）は今回未実装。`--sent-log-path`で送信時刻ログのみ出力可能（互換のため残してある）

## 管理API・公開APIのレート制限（500リクエスト/15分、2026-09-28追記）

`src/app.js`の`express-rate-limit`により、`/api/v1`配下（管理API・公開APIとも）は**同一クライアントIPから15分間に500リクエストまで**に制限されている（`trust proxy 1`設定、`RateLimit-Policy: 500;w=900`ヘッダーで確認可能）。

- **`battle-demo-prepare.js`への影響：** 本番EC2上からnginxを経由せず`127.0.0.1:3000`へ直接アクセスするため、`trust proxy`によるクライアントIP分離が効かず、実行中の全リクエストが`127.0.0.1`という同一キーに積み上がる。デバイス登録台数が多い実行（例：1,000台の新規作成）では、実際に2026-09-28にHTTP 429で停止する事象が発生した。現在は429を受けると`Retry-After`の秒数（+5秒）だけ待って自動的にリトライする（下記「デバイス登録の実装方式について」参照）。dry runを含め、実行前に今回のAPIリクエスト見込み数を表示する（`[prepare] request estimate for this run: ...`）。
- **`battle.html`（対抗戦画面）・公開APIへの影響：** ブラウザは実際のクライアントIPごとに制限が数えられるため、通常のインターネット経由アクセスでは問題にならない。ただし`battle.html`は3秒ごとにスコアAPIをポーリングするため、**1タブで15分あたり300リクエストを消費する。同一IP（同一拠点・同一NAT配下）から複数タブを開くと、2タブ目以降で429に達する可能性がある。** 会場等、多数の端末が同一回線（同一の公開IP）を共有する環境で対抗戦画面を表示する場合は、**同じIPからは1タブのみ開く**運用とすること（複数拠点・複数画面で表示したい場合は、別回線・別IPから開く）。429を受けた場合、画面は「サーバーに接続できません。再試行しています…」と表示したまま3秒間隔のポーリングを継続する（`public/battle.html`の`poll()`、致命エラーにはしない設計）。

## battle-demo-prepare.js（本番EC2上で実行）

本番EC2上から `http://127.0.0.1:3000/api/v1/admin/...` の管理APIを呼ぶ方式（nginxのIP制限を経由しない、DBへは直接接続しない）。**既定はdry run。`--yes`を付けたときだけ実際に書き込む。**

```bash
# dry run（何が起きるか確認するだけ）
node scripts/demo/battle-demo-prepare.js

# 実行（初回。他のlive試合には触れない）
node scripts/demo/battle-demo-prepare.js --yes

# 他のチームのlive試合をpausedにしてから実行する場合
node scripts/demo/battle-demo-prepare.js --yes --pause-other-live
```

### 主なオプション

| オプション | 既定値 | 内容 |
|---|---|---|
| `--api-base` | `http://127.0.0.1:3000/api/v1` | 管理APIのベースURL |
| `--category-name` | `デモ用` | 検索対象のカテゴリー名（新規作成はしない） |
| `--team-a-name` / `--team-b-name` | `EMUTTO` / `J SPORTS` | 検索対象のチーム名（新規作成はしない） |
| `--devices-per-team` | 500 | 1チームあたりのダミーデバイス台数 |
| `--mac-prefix` | `AA:00:00:02` | ダミーMACのprefix（負荷試験用`AA:00:00:00`・前回デモ用`AA:00:00:01`と重複しない） |
| `--team-b-start-index` | 32768（`0x8000`） | チームBの採番開始位置。チームAは0から |
| `--pause-other-live` | 無効 | 対象2チームの既存live試合をpausedに変更してから新しい試合をliveにする |
| `--theme-image-url` | 恒久デモから自動取得 | 対抗戦画面のテーマ画像URL。未指定時は`--theme-source-battle-id`のテーマ画像を引き継ぐ |
| `--label` | 自動生成 | 対抗戦ペアの表示ラベル |
| `--yes` | 無効（dry run） | 実際に書き込む |
| `--finish-run=<battle_id>` | — | 後片付けモード（下記） |
| `--restore=<event_id>:<status>,...` | — | `--finish-run`と併用。`--pause-other-live`で変更した試合を元のstatusへ戻す |

### デバイス登録の実装方式について

管理API（単体登録／CSV取込／一括更新）のうち、**単体登録API（`POST /admin/devices`）を採用した。**

- CSV取込（`POST /admin/devices/import`）は`category_id`/`is_demo`をその場で設定できない設計（取込後に`PATCH /admin/devices/bulk`で確定する2段階運用、`adminDeviceController.js`のコメント参照）
- 一括更新（`PATCH /admin/devices/bulk`）の`filter.mac`はILIKE部分一致で、下位2バイトが256の倍数を跨ぐ範囲（例：499台目は5バイト目が繰り上がる）を安全に絞り込みにくい
- 単体登録APIは`category_id`/`is_demo`を作成時に直接指定できる。リクエストサイズ上限（`express.json`の16kb）も単体登録なら関係しない
- 1,000台分の登録は20並列でHTTPリクエストを送る（`CREATE_CONCURRENCY`定数）

**既存デバイスの確認方式（2026-09-28変更）：** 当初は1台ずつ`GET`（またはPOST 409時に`GET`）で確認していたが、台数分だけAPIリクエストを消費し上記のレート制限に達しやすいため、`mac`部分一致（ILIKE、`GET /admin/devices?mac=<prefix>&page_size=200`）で対象prefix配下をページングしてまとめて取得する方式（`fetchExistingDevicesByPrefix`）に変更した。個別`GET`は、まとめて取得した後に他プロセスが同じMACを作成した場合（`POST`が409を返す稀なレース）のフォールバックとしてのみ残している。

**429対応：** `apiCall`がHTTP 429を受けると、レスポンスの`Retry-After`秒数に5秒（`RETRY_AFTER_BUFFER_SEC`）を足した時間だけ待ち、同じリクエストを自動的にやり直す。待機中は30秒（`RETRY_LOG_INTERVAL_SEC`）ごとに残り秒数をログへ出す。

**見込みリクエスト数の表示：** dry run・`--yes`のいずれでも、デバイスの作成/更新/スキップ件数が確定した時点（まとめて取得の直後）で、今回の実行が消費するAPIリクエスト数の見込みを`[prepare] request estimate for this run: ...`として表示する。500を超える場合は、429で待機しながら実行を継続する前提である旨も表示する。

### 後片付け（デモ終了後）

```bash
node scripts/demo/battle-demo-prepare.js --finish-run=<battle_id> --yes
# --pause-other-liveで他の試合を変更していた場合、実行時に出力される --restore= 付きのコマンド例をそのまま使う
```

- 対象2試合を`finished`にする
- `cheer_logs`（応援ログ）の削除は行わない（扱いはPhase 4後にKMT様と決める）
- `--restore`で指定したイベントは`--finish-run`の2試合を`finished`にした**後**に復元する（先に`live`へ戻すと新しい試合とのLIVE_EVENT_CONFLICTを避けるため）

### 冪等性

- カテゴリー・チームは検索のみ（新規作成しない）
- デバイスは既存MACをスキップし、`category_id`/`is_demo`が異なれば更新する
- **試合・対抗戦ペアは実行するたびに新規作成する。** 何度でも安全に再実行できるが、毎回新しいデモ枠（新しい`battle_id`）ができる設計。前回分は`--finish-run`で個別に終了させること

## battle-demo.js（WebARENA VPS等で実行）

```bash
node scripts/demo/battle-demo.js --battle-id=<uuid> --org-a=<uuid> --org-b=<uuid>
```

`--org-a`/`--org-b`・`--battle-id`は`battle-demo-prepare.js --yes`の出力（summary欄・コマンド例）をそのまま使う。

起動時にスコアAPI（`--score-url`、既定は`--battle-id`から自動生成）を1回取得し、`--org-a`/`--org-b`が対抗戦ペアの組織と一致するか検証する。**一致しない場合は接続を一切開始せずエラー終了する。**

### 主なオプション（詳細はスクリプト冒頭のコメント参照）

`--devices-per-team`（既定500）、`--duration-ms`（既定180000）、`--count-interval-ms`（既定5000）、
`--ramp-up-ms`（既定自動）、`--finish`（`close`/`A`/`B`/`none`、既定`close`）、`--url`
（既定`wss://ws.cheerstick.com/cheer`）、`--mac-prefix`（既定`AA:00:00:02`）、
`--team-b-start-index`（既定32768）、`--set-oshi=<target_id>`（既定送らない）、`--no-register`（既定は`register`を送る）、`--oshi-targets-a/-b`・`--energy-spread`・`--nickname-style`（ランキング見せ用、上記「前提」参照）、
`--report-interval-ms`（既定10000）、`--metrics-log-path`（既定自動）、`--sent-log-path`、
`--stop-threshold`（既定0.05）、`--target-range=<low>-<high>`（既定`0.45-0.55`、
下記「拮抗演出ロジック」参照）、`--burst`（既定無効、下記「猛攻演出」参照）、
`--burst-interval-sec=<low>-<high>`（既定`20-40`）、`--burst-duration-sec=<low>-<high>`（既定`10-20`）、
`--no-finish-swing`（既定は付けない＝`--burst`指定時は終盤の勢い変化が有効。下記参照）。

### 拮抗演出ロジック（目標比率追従方式）

チームAの目標比率（既定0.45〜0.55、`--target-range`で変更可）を20〜40秒ごとにランダムに
再設定し（前回と反対側に偏りやすくする）、3秒ごとに取得する実際の比率（スコアAPI、失敗時は
送信済みvalueの累計で代用）との差から、各countの送信範囲を動的に調整する（詳細な計算式は
スクリプト先頭の定数コメント参照）。残り30秒は`--finish`に応じて目標を固定する
（`close`=接戦、`A`/`B`=指定チーム優勢）。係数はすべてファイル先頭の定数にまとめてあり、
調整しやすくしてある。

### 猛攻演出（`--burst`、2026-09-28追加）

累計に頼らず勢いに変化をつけるための任意オプション。**既定は無効で、指定しない限り
挙動は変わらない。**

- 指定時のみ、`--burst-interval-sec`（既定20〜40秒、ランダム）の間隔で猛攻が発生し、
  `--burst-duration-sec`（既定10〜20秒、ランダム）続く
- 猛攻中のチーム（A・Bを交互に選ぶ。初回のみランダム）は`count`のvalueを80〜100、
  相手チームは1〜20に固定して送信する。**猛攻中は目標比率への追従（拮抗演出ロジック）を
  止める**（`BattleRatio#getRange()`が猛攻用の固定レンジを返す）
- **残り30秒（`--finish`の終盤演出ウィンドウ）に入ると、進行中・予約中の猛攻を止め、
  以降は再開しない。** 終盤演出を優先するため
- メトリクスJSONL（`--report-interval-ms`ごとのレコード）に`burst: {active, team}`を追記する
- `--target-range`の値は起動時のログ（`target_range=...`）と終了時のサマリーに出力される

### 終盤の勢い変化（`--no-finish-swing`、2026-09-28追加）

`--finish=close`の終盤30秒は、両チームの強さがそろい目標比率も0.49〜0.51に固定されるため、
ゲージがほぼ動かなくなる問題（KMT様フィードバック）への対応。**`--burst`指定時のみ有効**
（`--burst`無しでは従来どおり変化なし）。`--finish=A`/`B`/`none`の挙動は変えない
（`--finish=close`のときのみ動作する）。

- 5〜8秒ごとに3秒だけ、どちらかのチームを強く（value 60〜100）、もう一方を弱く
  （value 20〜60）する小さな揺さぶりを入れる。揺さぶり中は目標比率への追従を止める
  （`--burst`の猛攻と同じ仕組みで、`BattleRatio#getRange()`が固定レンジを返す）
- チームは交互に選ぶ（初回のみランダム）。揺さぶりが無い時間帯は通常どおり
  目標比率（0.49〜0.51）への追従が働くため、累計比率は大きくは崩れない想定
- `--no-finish-swing`を付けると、`--burst`指定時でもこの終盤の揺さぶりだけを無効にできる
  （猛攻演出自体〔終盤前〕には影響しない）
- メトリクスJSONLに`finish_swing: {active, team}`を追記する
- `finish_swing_events`（2026-09-28調整で追加）：揺さぶりが開始した時刻の一覧
  `[{startedAt, team}, ...]`を各レコードに追記する（`report-interval-ms`のスナップショット
  だけでは、5〜8秒間隔・3秒間という短い揺さぶりを取りこぼしうるため、開始時刻を別途記録する）

### 緊急停止

ramp-up完了後、区間（`--report-interval-ms`）ごとに以下のいずれかで発動する。発動すると
count送信を止めて全接続をcloseし、理由を標準出力とメトリクスJSONLに記録して終了する
（exit code 1）。Ctrl+C（SIGINT）・SIGTERMでも同じ停止処理を行う（この場合はexit code 0）。

- 確立中接続数が目標台数の95%を下回る状態が2区間連続した（ramp-up中は判定しない）
- 区間内の（送信失敗＋サーバーエラー応答）が、区間内の送信試行数の5%（`--stop-threshold`）を超えた

### 注意事項

- 1プロセスで1,000接続を扱う前提。Node.jsの既定設定で問題ない見込みだが、WebARENA VPS側の
  ファイルディスクリプタ上限（`ulimit -n`）が低い場合は事前に引き上げること
- **同じMAC範囲で複数プロセスを同時に起動しないこと。** 同一MACの二重接続はサーバー側が旧接続を
  code 4000でcloseする仕様のため、2プロセス目の接続がもう一方を随時切断してしまう

## local-verify.js（ローカル確認用）

```bash
node scripts/demo/local-verify.js
```

pg-mem上に実サーバー（`src/app.js` + `src/websocket`）を起動し、以下を一気通貫で確認する。
**本番・staging環境には一切接続しない。**

1. `battle-demo-prepare.js`のdry run・`--yes`実行・2回目実行（デバイスが重複作成されないこと）
2. `--pause-other-live`（既存live試合がpausedになり、新しい試合がliveになること）
3. 各5台（計10台）で`battle-demo.js`を短時間実行し、スコアが増えること・目標比率が切り替わること
4. `--finish=close`/`A`/`B`それぞれで終盤の比率が想定側に寄ること
5. サーバーのWebSocket接続を強制切断し、緊急停止が発動すること（exit code 1）
6. `--finish-run`で試合が`finished`になること

実行結果は`[verify] PASS: ...` / `[verify] FAIL: ...`として出力され、最後に集計を表示する
（1件でもFAILがあればexit code 1）。
