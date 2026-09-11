# CheerStick 現行仕様書（正本）

最終更新：2026-07-25（初版・handover v14 および監査結果より起こす）

> **このファイルの扱い**
> 本ファイルが仕様の正本。「推しフルシステムの仕様書20260630.pdf」は初期要件・史的経緯
> として `docs/archive/` に保管し、実装との差異が生じた場合は本ファイルを基準とする。
> **既存記述の削除は禁止。** 変更は末尾の「変更履歴」に理由を残すこと。

---

## 1. システム概要

BLE応援スティックの振動データを収集し、応援熱量をデータ化・可視化するIoTクラウドサーバー。

- 商用リリース：2026年8月第1週、V・ファーレン長崎を起点にJリーグ展開
- 想定規模：2,000〜20,000本の同時接続

### 1.1 名称について（2026-08-11追加）

- **「推しフル」＝ユーザー向けサービス名。** WebView（`public/index.html`・`public/reference.html`）のtitle・見出し等、ユーザーが直接目にする箇所ではこちらを使用する（2026-07-27、コミット`f97af59`で「CheerStick」表記から変更済み。変更理由・決定経緯は`docs/worklog.md`同日エントリの通り未記録）
- **「CheerStick」＝システム識別子。** GitHubリポジトリ名（`cats777jp/cheerstick-server`）、ドメイン（`*.cheerstick.com`）、DB名（`cheerstick_production`等）、コード内の変数・クラス名、ブリッジAPI識別子（`window.CheerStickBridge`・`window.onCheerStickData`等）として使用する。**ブリッジAPI識別子はVanstone様との合意事項のため、サービス名変更後も維持する。**
- 本ドキュメント（`docs/spec.md`）自体のタイトルなど、システム全体を指す文脈では「CheerStick」を用いる

## 2. 役割分担（2026-07-23 確定）

| 担当 | 範囲 |
|---|---|
| KMT（自社） | サーバーサイド、インフラ、ドメイン・SSL管理 |
| Claude / Claude Code | サーバーサイド実装・運用支援 |
| サーリューション（国内） | 仲介役（KMT ⇔ Vanstone の橋渡し） |
| Vanstone（中国） | BLEデバイス開発・製造、ネイティブアプリ開発 |

障害時連絡フロー：アプリ系は KMT → サーリューション → Vanstone、サーバー系は KMT 単独で収束。

## 3. 主要フロー

### 3.1 デバイス起動〜ペアリング

```
GET /geturl/?id=<MACアドレス>
  → HTML(meta refresh) で WebView URL へリダイレクト
  → 目的：ロット別・販売先別のWebView内容変更、およびサーバー負荷分散
```

### 3.2 チームID登録

> ⚠️ **この節の当初記述は現行実装と一致しません。必ず下記の
> 2026-07-27追記まで読んでください。**

**事前ホワイトリスト方式に確定済み**（初期案の「WebViewでチーム選択」「出荷検査時間帯の
自動登録」の2案は不採用。史的経緯としてPDF仕様書を参照）。※実装されていない（下記追記参照）

> **2026-07-27 追記：上記は当初の設計方針であり、現行実装とは一致しない。**
> 実装調査（コードリーディング＋本番での実地確認）の結果、MACアドレスの
> 事前ホワイトリストは`geturl`・WebSocket `connect`のいずれにも存在しないことを
> 確認した。`connect`時に呼ばれる`ensureDevice()`（`src/db/cheerstickQueries.js`）は
> 受け取ったMACアドレスを無条件に`INSERT ... ON CONFLICT DO NOTHING`するため、
> **任意の未登録MACアドレスを名乗るだけで`devices`テーブルへ自動的に行が作成される**
> （実質TOFU方式。当初想定していた「未登録は一切許可しない」ホワイトリストの
> 拒否分岐は`connect`/`geturl`のコード上どこにも存在しない）。
> 2026-07-27、本番環境に対し未使用のMACアドレスで`geturl`→WebSocket `connect`を
> 実地に叩いて確認済み（詳細は`docs/worklog.md`該当日エントリ参照）。
> セキュリティ上の影響は第11章「既知の課題」参照。

### 3.3 過去成績参照

```
GET /webviewrefer/?id=<MACアドレス>
```

署名付きトークン（reference機能）は実装済みだが**現在は無効化中**。
- `.env` の `ENABLE_REFERENCE_TOKEN=false`
- 現在はMACアドレス直指定方式（`?id=MAC`）で稼働
- 無効化理由：アプリ側（Vanstone・サーリューション）との調整未完了
- 再有効化手順：
  1. `openssl rand -hex 32` で新しい `REFERENCE_TOKEN_SECRET` を生成し、本番 `.env` の値を差し替える
     （理由：現在の値は一度チャットへ露出したため、有効化時に必ずローテーションする）
  2. `.env` の `ENABLE_REFERENCE_TOKEN` を `true` に変更
  3. `pm2 restart cheerstick-server --update-env`
- email はトークンの有無に関わらず除外（SQLで元々SELECTしない設計）

## 4. WebSocket 仕様

### 4.1 接続

```
接続時: { type: "connect", id: <MACアドレス> }
  → user / team / member を返却
  → category_id 未設定時は status:"error"（※実装の生存確認が必要／第6章参照）
```

> **2026-08-18追記：** 上記「実装の生存確認」を完了した。`category_id`未設定判定はWebSocket `connect`（本節）でのみ行われ、`GET /api/v1/webview/geturl`では行われない。詳細は6.2参照。

### 4.2 メッセージ種別

| type | 内容 |
|---|---|
| `connect` | 接続確立 |
| `set_name` | 名前設定（※現行コードでは未確認。`register` の誤記の可能性あり／次回要精査） |
| `register` | ニックネーム＋メールアドレス登録（実装済み・2026-07-25確認）。TOFU方式：未登録デバイス、または登録済みと同一ユーザーのみ更新を許可。別ユーザーによる上書きは `DEVICE_ALREADY_REGISTERED` エラーで拒否（`src/db/cheerstickQueries.js` registerDeviceOwner） |
| `set_oshi` | 推し選手設定 |
| `count` | 応援量送信（後述） |
| `broadcast` | 試合状態通知（stat: start / stop）（※現行コードでは未確認／次回要精査） |
| `select_team` | チーム選択（CATEGORY_MISMATCH検証あり／※生存確認要） |

**所有者の誤登録・譲渡対応**：TOFU方式のため、一度登録されたデバイスは別ユーザーが
`register` できない。出荷検査時の誤登録、中古譲渡、メールアドレス変更などで所有者を
リセットする必要がある場合は、`docs/runbook.md` の「デバイス所有者リセット手順」を参照
（本番DBを直接操作するため、必ずSELECTでの事前確認とセットで実行する）。

### 4.3 応援量カウント（2026-07-23 実装）

```
{ type: "count", id, value, duration_ms }

判定ロジック：
  デバイスの選択中チーム(organization)に status='live' の試合がある
    → cheer_logs へ記録（公式記録、通算応援量に反映）
  無い場合（scheduled / paused / 試合なし）
    → DB保存はスキップ（画面上のその場限り表示のみ。練習・動作確認用）
```

> **2026-08-11追記：** `docs/proposals/cheer-count-algorithm.md`は旧Node-RED版WebViewのクライアント側（振動データ→count算出）ロジックを参照用に抽出した資料であり、**本章（サーバー側の集計仕様）とは別物。** 同資料内のWebSocket送信ペイロード例（`count`+`num_min/max`等のバッチ統計形式）は現行実装（本章の`{type:"count", id, value, duration_ms}`）と形状が異なる。参照時に混同しないこと。

### 4.4 未実装（要対応）

- **ping/pong ハートビート**：2026-07-01時点で「25秒間隔で `ws.ping()`、pong無応答を
  `ws.terminate()`」の isAlive パターンが決定事項として合意されていたが、実装状況が不明。
  2,000〜20,000本規模での接続断・リソースリーク防止のため必要。
  なお nginx の `proxy_read_timeout`（既定60秒）との整合も要確認。
- クライアント側再接続（ジッター＋バックオフ）はv11で実装済み。

## 5. BLE / LED 仕様

### 5.1 デバイス→アプリ→WebView（1秒間隔）

```
payload = { num, accel: { x:[10], y:[10], z:[10] }, volt, rssi }
```

### 5.2 ネイティブアプリ⇔WebView ブリッジ（★Vanstoneと未合意・仮称）

以下の名称はこちら側で仮に定めたもの。**Vanstoneの実装は未着手であり、名称・呼び出し
方法の合意が必要。** これが本プロジェクト唯一の社外依存であり、最大のリスク要因。

```
APP → WebView:
  window.onCheerStickData(payload)

WebView → APP（LED制御）:
  window.CheerStickBridge.sendLED({ LED: { r, g, b }, stat: "OK" })
  ※ブリッジ未実装環境でもエラーにならないよう存在チェック付きで呼び出す設計

WebView → APP（終了時）:
  window.CheerStickBridge.sendEnd({ stat: "end" })
```

### 5.3 LED制御

- チームカラーを WebSocket 接続時に取得、r/g/b 各 0-255
- `organizations.color` 列（HEX形式、migration 007）から供給
- V・ファーレン長崎の暫定値 `#005AAA`（正式カラー未確認のため既存CSS固定値を暫定採用）
- 「明るさ」調整は将来の管理画面実装時にまとめて対応する方針

## 6. カテゴリー機能／マルチスポーツ対応 実装済み（コード確認済み・2026-07-25）

**マルチスポーツ対応（MACアドレス起点でスポーツジャンルを分ける）は必須要件。**

v10（2026-07-22）でコミット `d75d8f1`（カテゴリー（ジャンル）機能の追加：devices/organizations
へのcategory_id追加、team_selectionのカテゴリー絞り込み、select_teamのカテゴリー不一致バリデーション）
として実装。v12以降の引継ぎ書から記述が消失していたため一時「生存未確認」扱いだったが、
2026-07-25のセッションでコード上の実在を確認した。`d75d8f1` 以降、該当コードは一度も
削除されていない（`git log --oneline -- migrations/004_add_category.sql src/db/cheerstickQueries.js
src/websocket/index.js` で確認）。

**確認済みの実装（2026-07-25、コードリーディングにより確認）：**
- `categories` テーブル、`organizations.category_id`、`devices.category_id` ―
  `migrations/004_add_category.sql`
- チーム一覧をデバイスのカテゴリーで絞り込む `listOrganizations(categoryId)` 関数 ―
  `src/db/cheerstickQueries.js`
- `connect` 時の category_id 必須チェック（未設定なら `status:"error"`）を行う
  `computeStatus()` 関数 ― `src/websocket/index.js`
- `select_team` 時にデバイスのカテゴリーと一致しないチームを拒否する
  `CATEGORY_MISMATCH` 検証（`setDeviceOrganization()` 内） ― `src/db/cheerstickQueries.js`

**残る未確認事項：**
- **本番DBへの `migrations/004_add_category.sql` の適用状況は未確認。**
  コード側は実装済みでも、本番の `schema_migrations` テーブルに未適用のまま残っている
  可能性がある。次回の確認手順：
```bash
# 1. psql でテーブル・カラムの実在確認
psql -U cheerstick -d cheerstick_production -c "\d categories"
psql -U cheerstick -d cheerstick_production -c "\d organizations"
psql -U cheerstick -d cheerstick_production -c "\d devices"

# 2. マイグレーション適用記録の確認
psql -U cheerstick -d cheerstick_production -c "SELECT filename FROM schema_migrations ORDER BY filename"
```

**マルチスポーツ対応（新ジャンル追加）について：**
マルチスポーツ対応は本機能（category_id方式）で実現済み。新ジャンルを追加する場合は
`categories` テーブルへのINSERTで対応可能な設計になっている。
ただし、INSERTのみで完結するか（既存デバイス・organizationsへの割当作業や
アプリ側の対応が別途必要にならないか）は未検証であり、実際に新ジャンルを追加する際に
改めて確認すること。

> 初回リリースはV・ファーレン長崎単独のため、新ジャンル追加の実地検証は8月リリース後でも間に合う。
> ただし本番DBへのmigration適用状況の確認（上記コマンド）は先に済ませておくこと。

### 6.1 `targets` テーブルの設計（選手専用テーブルではない）

**注意：`targets` は「選手テーブル」ではなく、`type` 列で選手・チーム・マスコット・
アーティスト等を汎用的に管理する1つのテーブル。**（過去の作業指示書で「選手テーブル」と
誤って前提を書いたことがあるため、ここに明記する。）

```sql
targets (
  id, organization_id, name, type,   -- type: player / team / mascot / artist / unit 等
  image_url, number, metadata JSONB, profile_text, is_active, created_at
)
```

- `organization_id` で所属する組織（チーム等）に紐づく
- `type = 'mascot'` のヴィヴィくん、`type = 'player'` のサンプル選手A/B/C は、いずれも
  同じ`targets`テーブルの行（種別が違うだけ）
- `metadata` はJSONBで種別固有の追加属性を柔軟に格納可能（例: `{"position":"FW"}`）。
  定型のプロフィール文表示には `profile_text` 列（8.1参照）を使う

### 6.2 カテゴリー判定の実装詳細（2026-08-18追記）

2026-08-18、Vanstone様検証機の接続エラー調査（読み取り専用、`docs/worklog.md`同日エントリ参照）でコードを再確認し、以下を確定させた。

- **判定が行われるのはWebSocket `connect`のみ。** `GET /api/v1/webview/geturl`（`src/controllers/webviewController.js`）は`category_id`を一切参照せず、常に200でWebView URLへリダイレクトする。カテゴリー未設定でも`geturl`自体はブロックされない
- 判定は`computeStatus()`（`src/websocket/index.js`）の`if (!row || !row.category_id) return 'error';`で行われ、応答は`{ type: "connect", status: "error", message: "カテゴリー未設定のデバイスです。サポートまでお問い合わせください。" }`（HTTPステータスコードやエラーコードではなく、WS応答内の`status`文字列で表現される）
- **`is_demo`列による判定の迂回は存在しない。** `computeStatus()`は`is_demo`を一切参照していない。検証機やデモ機を`is_demo = true`にしても、この判定は迂回されない。デモ機を例外扱いしたい場合は別途分岐の追加が必要
- 現時点で、WebSocket `connect`の接続試行（どのMACがいつ接続し、どの`status`が返ったか）を記録するアプリケーションログは存在しない

> **2026-08-18追記（同日中に対応）：** 上記「アプリケーションログは存在しない」状態は本日中に解消した。`src/websocket/index.js`の`connect`ハンドラに接続ログを追加し、本番反映済み（コミット`d7e965c`、詳細は`docs/worklog.md`同日エントリ「WebSocket `connect` の接続ログを追加」参照）。
> - 成功（`status`が`'error'`以外）：同一WebSocketコネクションで初回のみ`console.log`
> - 失敗：`console.error`で全件。理由コードは`NO_ROW`（`row`が取得できない）／`NO_CATEGORY`（`category_id`がNULL）／`EXCEPTION`（`ensureDevice`等の例外。失敗したMACアドレスを30文字に切り詰めて記録し、Postgresエラーコードがあれば付記）の3分類
> - 出力項目：ISO 8601日時・MACアドレス・status／理由コード・送信元IP（`X-Real-IP`ヘッダー優先、無ければ`socket.remoteAddress`にフォールバック）
> - メールアドレス・ニックネームは出力しない
> - `computeStatus()`の判定ロジック・クライアントへの応答内容・DBスキーマへの変更は無い（記録の追加のみ）
> - 本番nginx（`/etc/nginx/sites-enabled/cheerstick-ws`）は`X-Real-IP`のみ設定し`X-Forwarded-For`は設定していないため、`X-Real-IP`を採用した

## 7. データベース

PostgreSQL、EC2上に直接インストール（RDSではなく最小コスト構成）。
DB: `cheerstick_production` / ユーザー: `cheerstick`

### マイグレーション適用状況（2026-07-23時点）

```
001_initial_schema.sql
002_device_target_and_seed.sql
003_team_selection_and_sample_players.sql
004_add_category.sql                ← 実装の生存確認が必要（第6章）
005_add_cheer_logs_device_event_index.sql
006_event_status.sql                （events.status へ CHECK制約）
007_organization_color.sql          （organizations.color 列）
008_target_profile_text.sql         （targets.profile_text 列、2026-07-25適用）
009_add_device_is_demo.sql          （devices.is_demo 列、本番未適用。docs/runbook.md参照）
010_add_events_hidden_at.sql        （events.hidden_at 列。11.3章参照）
011_add_event_battles.sql           （event_battles テーブル新設。8.4章参照。2026-09-11実装・ローカル確認のみ、本番未反映）
```

### events.status

CHECK制約により以下のみ許可：`scheduled` / `live` / `paused` / `finished` / `cancelled`

## 8. REST API

```
PATCH /api/v1/admin/events/:id/status
  body: { status }
  ⚠️ アプリケーションレベルの認証は引き続きなし。
  ✅ 2026-07-25、nginx側で `/api/v1/admin/` パスにIPアドレス制限を追加済み
     （KMT様オフィス固定IP: 49.156.217.121。VPN経由時も同一IPで到達する構成のみ許可）。
     運用者が現時点でKMT様お一人であるため、正式なログイン機構より単純なIP制限を
     暫定対応として採用。複数人運用・外部からの操作が必要になった時点でBasic認証等へ
     移行を検討する（設定箇所は docs/runbook.md 参照）。
     URLを外部に一切共有しないこと（IP制限のみでは共有時のリスクは残るため）。
```

### 8.0 管理画面の状態遷移ボタン（記載漏れの補記、2026-09-11追記）

> 本節は新規仕様ではなく、2026-07-30の管理画面新規実装（コミット`f24289b`）時点から
> 存在していた挙動の記載漏れを補うもの。2026-09-11、「2チーム対抗応援合戦」機能の
> 設計検討に伴う調査で、管理画面の「停止」ボタンについて本章・9章に説明が無いことが
> 判明したため追記する（`docs/worklog.md`2026-09-11エントリ参照）。

`PATCH /api/v1/admin/events/:id/status`は、管理画面（`public/admin/index.html`）の
以下のボタンからすべて共通で呼ばれる（エンドポイント自体は1本のみ）。

| 現在の状態 | 表示されるボタン | 遷移先 | 確認ダイアログ |
|---|---|---|---|
| `scheduled` | 開始 | `live` | 無 |
| `live` | 停止 | `paused` | 無 |
| `live` | 終了 | `finished` | 有 |
| `paused` | 再開 | `live` | 無 |
| `paused` | 終了 | `finished` | 有 |
| `finished` | 終了を取り消す（8.1参照） | `paused` | 有 |

- 「停止」は試合を一時中断する操作であり、4.3章の判定ロジックにより`paused`中は
  `count`受信自体は継続するが`cheer_logs`への書き込みはスキップされる（`scheduled`と同じ扱い）
- `paused`→`live`遷移時のみ、同一organizationの他イベントとの`LIVE_EVENT_CONFLICT`検証
  （11.2章）を経由する（`updateEventStatus`が`status==='live'`の場合のみチェックするため）
- CHECK制約（7章）上の`paused`は2026-07-23の応援量カウント機能実装時点から存在する値であり、
  8.1（2026-08-19実装）より前から使われている

### 8.1 `finished`からの復帰（B-1、2026-08-19実装・2026-09-06本番反映＋実機検証済み）

11.6章の事故を受けた対応。`PATCH /api/v1/admin/events/:id/status`自体に変更は無く、
管理画面（`public/admin/index.html`）側に`finished`用の操作ボタンを追加したもの。

- `finished`の試合一覧行に「終了を取り消す」ボタンを表示し、`status: "paused"`へ
  遷移させる（復帰先は`paused`固定。`live`への直接復帰は`updateEventStatus`の
  `LIVE_EVENT_CONFLICT`検査を経由する既存の同組織複数`live`防止ロジックに委ねるため、
  ボタンからは行わない）
- 確認ダイアログ文言：`「〈試合名〉」（現在：終了）の終了を取り消し、停止中に戻します。
  よろしいですか？`（試合名の手入力は求めない）
- DELETE機能（11.6章「対応が必要な点」1.）は本対応の範囲外で、未実装のまま

### 8.2 状態変更ログ（B-2、2026-08-19実装・2026-09-06本番反映＋実機検証済み）

`PATCH /api/v1/admin/events/:id/status`が実際に状態を変更した場合のみ、
サーバーログ（pm2ログ）へ以下の形式で出力する。

```
[ADMIN] status change time=<ISO8601> event_id=<uuid> title="<試合名>" from=<変更前status> to=<変更後status> ip=<接続元IP>
```

- `ip`はWebSocket接続ログと同じ方式で取得（`X-Real-IP`ヘッダー優先、
  無ければ`socket.remoteAddress`）
- `EVENT_NOT_FOUND`・`INVALID_STATUS`・`LIVE_EVENT_CONFLICT`など、実際に状態が
  変わらなかった場合は出力されない
- メールアドレス・ニックネームは出力しない

### 8.3 管理API：チーム（organizations）登録・編集（B-4、2026-08-19実装・2026-09-06本番反映＋実機検証済み）

```
GET /admin/organizations?category_id=<uuid>
  category_id未指定時は従来通り全件を返す（試合登録フォームのプルダウンとの互換維持）

POST /admin/organizations
  body: { name, category_id, logo_url? }
  name・category_idは必須（category_id未設定のチームはデバイス向け一覧に出せず
  実質使えないため、登録時点で必須とした）。category_idが存在しない場合は
  400 { error: "CATEGORY_NOT_FOUND" }

PATCH /admin/organizations/:id
  body: { name?, category_id?, logo_url? }（updateEventと同じ部分更新方式）
  対象が無ければ404 { error: "ORGANIZATION_NOT_FOUND" }

⚠️ DELETEは実装していない（premises C-1：削除＝非表示化の方針。B-4実装時点の判断）。
   テスト登録したチームは本番データとして残り続けるため、実機検証時も
   新規登録の実操作は行わずUI表示確認のみに留めた（2026-09-06）。
⚠️ 認証はPATCH /events/:id/statusと同じくnginx側のIP制限のみ（アプリケーションレベル認証なし）。
```

`organizations.type`列（`football_club`等の組織種別、`category_id`＝ジャンルとは
別軸）はB-4の実装対象外だが`NOT NULL`制約がある。指示書にAPI入力項目としての
記載が無いため、`POST`時に未指定なら既存データ（V・ファーレン長崎）と同じ
`'football_club'`をサーバー側デフォルト値として設定する（UI上の入力項目としては
非公開）。アプリコードからは`type`列を参照する箇所は無い。

### 8.4 対抗戦ペア管理・スコアAPI（2チーム対抗応援合戦機能、2026-09-11実装・ローカル確認のみ・本番未反映）

KMT様提案の新機能。既存の`events`テーブルには一切変更を加えず（home/away化は見送り）、
2つの既存イベントをペアリングする新規テーブル`event_battles`
（`migrations/011_add_event_battles.sql`）で実現した。

```sql
event_battles (
  id, label, event_a_id, event_b_id, created_at
)
-- event_a_id/event_b_id は events(id) を参照、ON DELETE CASCADE
-- CHECK (event_a_id <> event_b_id)
```

- `event_a_id`＝画面左側、`event_b_id`＝画面右側として扱う（アプリ側の慣例。DB上の区別は無い）
- ON DELETE CASCADEとした判断：event_battlesを参照する子テーブルは無い末端テーブルであり、
  11.7章の孤児レコード問題とは無関係。ただし現状`events`の物理削除経路自体が実装に
  存在しない（削除操作は`hideEvent()`によるhidden_at設定のみ）ため、通常運用でこの
  CASCADEが発火する場面は無い

**管理API（`PATCH /events/:id/status`等と同じくnginx側IP制限のみ、認証追加なし）**

```
GET /api/v1/admin/event-battles
  一覧取得。両イベントのtitle・組織名をJOINして返す

POST /api/v1/admin/event-battles
  body: { label?, event_a_id, event_b_id }
  event_a_id・event_b_idは必須。実在しなければ400 { error: "EVENT_NOT_FOUND" }
  同一イベントの指定は400 { error: "SAME_EVENT" }（DBのCHECK制約でも二重に防止）

DELETE /api/v1/admin/event-battles/:id
  物理削除（非表示化ではない。event_battles自体は「ペアリングの台帳」であり、
  元のevents/cheer_logsを一切変更しないため11.7章のような孤児レコード問題が起きない）
  対象が無ければ404 { error: "BATTLE_NOT_FOUND" }
```

**公開スコアAPI（★注意：`/api/v1/admin/`配下ではないため、上記admin系エンドポイントに
かかっているnginx IPアドレス制限は適用されない）**

```
GET /api/v1/event-battles/:id/score
  認証：アプリケーションレベルの認証は追加しない（B-3の方針を踏襲）。
  ただし本エンドポイントはadmin配下ではないため、runbook.mdの管理API用IP制限の
  対象外であり、意図的にIP制限の外に置いている（対抗戦スクリーンを会場等の
  任意の端末で表示する必要があるため）。battle_id（UUID）を知っていれば誰でも
  閲覧できる状態であり、3章のreference機能（MACアドレス直指定方式）と同種の
  「推測困難なIDによる簡易的な保護」に留まる。本番反映前に運用上許容できるか
  KMT様の確認が必要

  レスポンス例：
  {
    "battle_id": "...", "label": "...",
    "team_a": {
      "event_id": "...", "event_title": "...",
      "organization": { "id", "name", "logo_url", "color" } | null,
      "total_intensity": 12345
    },
    "team_b": { ...同様... },
    "updated_at": "..."
  }

  集計方法：getAllTimeCheerTotal（3.3章・reference機能）と同じSUMパターンを
  event単位に絞ったもの（SELECT COALESCE(SUM(intensity),0) FROM cheer_logs
  WHERE event_id = $1）。durationやcheer_countは含めない（通算応援量の集計と同様、
  intensity合計のみを「応援量」として扱う既存方針に合わせた）

  status（live/paused/finished等）による分岐は行わない：停止中・終了後もその時点の
  cheer_logs集計をそのまま返し続ける。4.3章の判定ロジック側でstatus='live'以外は
  そもそもcheer_logsへ書き込まれないため、本APIで重ねて絞り込む必要が無いための設計
```

**動作確認（2026-09-11、ローカル・pg-mem疑似DBによる検証。実DBでの検証は別途必要）**

- migrations 001〜011を通しで適用できることを確認
- createEventBattle/listEventBattles/getEventBattleMeta/getEventIntensityTotal/
  deleteEventBattleの単体動作、SAME_EVENT・EVENT_NOT_FOUND・BATTLE_NOT_FOUND各エラー、
  ON DELETE CASCADEの発火を確認
- 実際のExpressアプリ（`src/app.js`）をHTTP経由で起動し、管理API（作成・一覧・削除）と
  公開スコアAPIを一気通貫で確認。既存の`/api/v1/admin/events`・`/organizations`が
  引き続き正常応答することも確認（回帰無し）
- 試合を`live`→`paused`にしてもスコアAPIの値が変わらず表示され続けることを確認
- 管理画面（`public/admin/index.html`）・対抗戦スクリーン（`public/battle.html`）を
  ブラウザで実際に操作し、対抗戦ペアの登録・一覧・URL・削除、一括開始/停止/終了の
  部分成功（同一組織の同時live禁止に抵触した行にエラー表示が残ることを含む）、
  スコア画面のポーリング表示更新まで確認（詳細は`docs/worklog.md`同日エントリ参照）
- 本番DBでの動作確認・本番デプロイは未実施（KMT様指示により今回は対象外）

## 9. フロントエンド（public/index.html）

```
画面フロー：
  完了画面(welcomeCard) → [START] → 応援中画面(cheeringCard) → [終了] → 完了画面

応援中画面の表示：
  ✅ 応援量カウント（試合中の累計）
  ✅ 電池残量表示（volt <= BATTERY_LOW_THRESHOLD(3.0V) の状態が
     BATTERY_LOW_DURATION_MS(60秒)間連続した場合のみ「電池残少」を表示。
     途中で1回でも閾値を超えたら判定用タイマーをリセットする。2026-09-06変更、
     詳細は9.2参照）
  ❌ LEDカラープレビュー（グッズ自体が光るため不要との方針）
  ❌ 試合状態(stat)表示（不要との方針）

チームカラーは team.color（APIレスポンス）を --team-color CSS変数と
LED色計算の両方に反映（以前は固定値ハードコードだった）
```

### 9.1 チーム・選手プロフィールの表示構造（空枠仕様、2026-07-25実装）

**前提：`organizations.logo_url`（チームロゴ）と `targets.image_url`（選手・マスコット
写真）は元々存在しており、`connect`応答の`team.logo_url` / `member.image_url`として
既にDBから動的に描画されていた（静的ファイル直書きではない）。2026-07-25に追加したのは
`targets.profile_text`列と、値が無い場合の表示崩れ対策のみ。**

| 項目 | DB列 | 値がある場合 | 値が無い場合（空枠） |
|---|---|---|---|
| チームロゴ | `organizations.logo_url` | `<img id="teamLogo">`（84px円形、`object-fit:cover`） | `#teamLogoAvatar`（同サイズ円形、チーム名頭文字＋色アバター） |
| 推し写真 | `targets.image_url` | `<img id="oshiPhoto">`（56px角丸、`object-fit:cover`） | `#oshiAvatar`（同サイズ、名前頭文字＋色アバター） |
| 推しプロフィール文 | `targets.profile_text`（2026-07-25追加） | `#oshiProfileText`に表示 | 行ごと非表示（空行を残さない） |

- `object-fit`は当初`contain`案もあったが、チームロゴは円形バッジのデザインのため
  `cover`のまま維持する方針に確定（`contain`だと余白が生まれ不自然なため）
- 頭文字＋色のアバターフォールバックは`colorFor(id)`関数（既存）を流用し、
  チームロゴ・推し写真で共通のパターンにしている
- サンプル選手A/B/C（`image_url = NULL`）は、この空枠の実例として既に本番DBに存在する

**今後、画像・氏名・プロフィールを追加する場合：**
アプリのデプロイ・コード変更は不要。対象行を本番DBで`UPDATE`するだけで、次回`connect`
応答から反映される。
```sql
UPDATE organizations SET logo_url = '<画像URL>' WHERE id = '<organization_id>';
UPDATE targets SET image_url = '<画像URL>', profile_text = '<プロフィール文>'
  WHERE id = '<target_id>';
```
画像ファイル自体は `/var/www/cheerstick-app/images/` 配下に配置し、
`https://app.cheerstick.com/images/...` のURLを上記UPDATEで指定する
（`migrations/002_device_target_and_seed.sql`のシードデータと同じ配置方式）。

### 9.2 電池残量警告の継続時間判定（2026-09-06変更、実装・ローカル確認まで完了・本番反映は別途）

**変更前：** `payload.volt`が閾値（3.0V）以下になった瞬間の1回の受信で即座に
「電池残少」を表示する、単発の瞬時値判定だった。

**変更理由：** Vanstone様より、LED点灯時の瞬間的な電圧降下により警告が誤発報する
との指摘があったため。

**変更後：** `public/index.html`内の`window.onCheerStickData`に、`volt <=
BATTERY_LOW_THRESHOLD`の状態を検知した時刻を`batteryLowSince`として保持し、
`Date.now() - batteryLowSince >= BATTERY_LOW_DURATION_MS`（60秒）で初めて表示する
タイムスタンプベースの継続時間判定へ変更した。1回でも閾値を上回ったら
`batteryLowSince`をnullにリセットする。応援開始（`startCheeringBtn`クリック）時にも
前回セッションからの継続時間・表示状態を持ち越さないようリセットする。

- 閾値（`BATTERY_LOW_THRESHOLD` = 3.0）・継続時間（`BATTERY_LOW_DURATION_MS` =
  60 * 1000ms）はいずれも定数化済み。将来調整の可能性があるための対応
- `window.onCheerStickData`の呼び出し間隔は5.1章の通り1秒間隔を想定しているが、
  実機（Vanstone側実装）の呼び出し間隔がその通りとは限らないため、呼び出し回数
  ではなくタイムスタンプ（`Date.now()`の差分）で60秒を判定する設計とした
- サーバー側（`src/`・マイグレーション）に`volt`を参照する箇所は無く、
  本変更によるサーバー側への影響は無いことを確認済み
- ローカルでの構文チェック・状態遷移の単体検証（瞬間的な単発降下では発報しない／
  60秒継続で発報する／途中で閾値を超えるとリセットされる、の3ケース）は完了。
  **実機での検証はまだ行っていない。本番反映はKMT様側で実施する。**

### 未対応

- BLE切断時のサーバー通知（`type: "ble_disconnect"`）は見送り。クライアント側表示のみ
- 実機（ネイティブアプリ）での動作テストはVanstone側ブリッジ実装完了後でないと不可

### 9.3 管理画面：対抗戦ペア管理・一括操作（2チーム対抗応援合戦機能、2026-09-11実装・ローカル確認のみ）

`public/admin/index.html`「試合一覧」カードに以下を追加した（バックエンドAPIの新規追加は
無く、既存の`PATCH /events/:id/status`をループで呼ぶのみ）。

- 各行にチェックボックスを1個追加、一覧上部に「開始」「停止」「終了」の一括ボタンを設置
- チェック済みの試合IDへ、押されたボタンに対応する`status`変更APIを1件ずつ順番に呼び出す。
  **現在のstatusに応じた遷移可否のチェックは行わない**（呼び出し先APIの検証にそのまま委ねる。
  例えば`finished`の試合を選んで一括「開始」を押すと`live`へ直接遷移する。8.0章の単発ボタンが
  状態ごとに出す遷移とは異なる経路になり得るため、運用上の注意点として明記する）
- 部分成功を許容：成功した行はチェックを外し一覧を更新、失敗した行はチェックを残し
  その行にエラー内容（例：「同じチームでlive中の試合があります」）を表示する。
  失敗した行は個別の単発ボタンで手動対応できる
- 確認ダイアログは8.0章の単発ボタンの使い分け（開始/停止/再開は無・終了は有）を踏襲し、
  一括「終了」時のみ選択件数を含む確認ダイアログを1回表示する

> **2026-09-14追記：状態遷移ルールの適用。** 上記「現在のstatusに応じた遷移可否のチェックは
> 行わない」を修正した。実装後の確認で、一括操作から`finished`→`live`のような単発ボタンでは
> 表示されない遷移が実行できてしまう点が問題として指摘され、`bulkChangeStatus()`に
> 事前チェックを追加した。
>
> - 判定は個別ボタンの`actionButtonsFor(event)`の戻り値をそのまま使う（遷移ルールを
>   二重管理せず、常に単発ボタンの表示内容と一致させるため）。押されたボタンの`nextStatus`が
>   `actionButtonsFor(event)`の返す遷移先一覧に含まれない場合はAPIを呼ばずスキップする
> - スキップした行はチェックを残したまま「対象外（現在の状態「〈status〉」ではこの操作は
>   実行できません）」を表示する（失敗行と同じ「チェックを残す」挙動だが、原因を区別できるよう
>   メッセージ文言を分けた）
> - 例：`finished`の試合に対する一括「開始」（`live`）は`actionButtonsFor()`が`live`を
>   返さないためスキップされる。一方、`finished`の試合に対する一括「停止」（`paused`）は
>   `actionButtonsFor()`が「終了を取り消す」ボタンとして`paused`を返すため、実行される
>   （ボタンの文言は異なるが、8.0章の遷移表における`finished`→`paused`の唯一の遷移先と
>   同一の値であるため、意図した挙動）
> - スコアAPI（8.4章）の認証・IP制限方針については、KMT様確認の上「現状のままで問題ない」
>   との回答を得たため変更していない
> - 動作確認：`live`中の試合が存在する組織の`scheduled`試合・`live`の試合2件・`finished`の
>   試合を含む4件を全選択し一括「開始」を実行 → `scheduled`の1件のみAPIが呼ばれ既存の
>   `LIVE_EVENT_CONFLICT`（409）で失敗、`live`の2件と`finished`の1件は「対象外」としてAPIを
>   呼ばずスキップされることを確認。続けて`scheduled`と`finished`の2件を選び一括「停止」を
>   実行 → `scheduled`は「対象外」でスキップ、`finished`は`paused`へ正常に遷移することを確認
>   （詳細は`docs/worklog.md`同日エントリ参照）

新設カード「対抗戦ペア登録」「対抗戦ペア一覧」を試合一覧の直後に追加：

- 登録フォーム：既存の試合一覧から試合A・試合Bをプルダウンで選択し、任意のラベルを付けて
  `POST /admin/event-battles`を呼ぶ
- 一覧：登録済みペアを表示し、各行にスクリーン表示用URL
  （`<APP_BASE>/battle.html?battle_id=<id>`）をテキスト入力＋「コピー」ボタンで提供。
  `APP_BASE`はadmin.cheerstick.comとは別オリジンのapp.cheerstick.comを本番用に想定
  （`public/index.html`が配信される先と同じ想定。9.1章参照）
- 削除ボタンあり（`DELETE /admin/event-battles/:id`、物理削除。元の試合自体は削除されない）。
  開始/終了ボタンとの連動は無い（ペアの登録・削除と試合の進行管理は独立）

### 9.4 対抗戦スクリーン表示ページ `public/battle.html`（2チーム対抗応援合戦機能、2026-09-11新設・ローカル確認のみ）

URLパラメータ`battle_id`を受け取り、`GET /api/v1/event-battles/:id/score`を3秒間隔で
ポーリングして表示を更新する単独ページ（WebSocket接続は行わない）。

- 表示内容：左に`team_a`、右に`team_b`のチーム名・ロゴ（`organizations.logo_url`。
  無ければ`organizations.color`または`colorFor(id)`フォールバックによる頭文字アバター、
  9.1章の空枠仕様と同じ考え方）・チームカラー・応援量ゲージ
- ゲージは上限値を固定せず、両者のうち大きい方を100%とする相対表示（まず動くものを優先する
  方針のためのシンプルな実装。演出の調整は別途）
- `battle_id`未指定・`BATTLE_NOT_FOUND`（404）は致命エラーとして専用メッセージを表示。
  一時的な通信断（fetch失敗）は直前の表示を保持したまま次回ポーリングへ継続し、
  画面上部に再試行中である旨のバナーのみ表示する
- 配置予定：`public/index.html`と同じ`/var/www/cheerstick-app/`配下
  （runbook.md「デプロイ手順」の2箇所デプロイ対象に本ページも追加が必要。本番反映時に注意）

## 10. 未実施の検証

**2,000〜20,000本規模の負荷試験は一度も実施していない。**
現構成は1台のEC2上でREST API・WebSocketを単一プロセスが処理し、PostgreSQLも同居。
リリース前に以下の確認が必要：

- 同時接続数を段階的に上げた際のメモリ / FD / CPU 挙動
- `count` メッセージが毎秒×接続数ぶんDBへ向かう際の詰まり（バッチINSERTの要否）
- nginx `proxy_read_timeout` の妥当性
- pm2 インスタンス数とEC2インスタンスタイプの妥当性
- 最悪時のスケールアップ手順（インスタンスタイプ変更＋再起動）の事前準備

## 11. 既知の課題（2026-07-27追記）

### 11.1 デバイス認証機構が無い（MACアドレスのなりすまし）

第3.2章の追記の通り、`devices`テーブルへのMACアドレス事前登録（ホワイトリスト）は
実装されておらず、任意のMACアドレスを名乗るだけでWebSocket経由の操作が可能な状態。

- 認証機構が無く、任意のMACアドレスを名乗って`cheer_logs`へ書き込み可能
  （正規のBLEデバイスを介さず、`connect`→`select_team`→`set_oshi`→`count`の
  WebSocketメッセージを直接送るだけで到達できる）
- 応援量の捏造が理論上可能で、MVP・ランキングの信頼性に影響する
- 対応時期は未定（リリース後の検討事項）

### 11.2 同一組織で複数の試合が同時に`live`になり得る（TOCTOU、2026-07-30 実証）

**症状：** `PATCH /api/v1/admin/events/:id/status` で同一organizationの
異なる2イベントを、ほぼ同時刻（同一ミリ秒レベル）に`live`へ変更しようとすると、
**両方が`live`になる。**

**原因：** `updateEventStatus`の実装が「衝突チェック（SELECT）」→「更新（UPDATE）」の
2クエリに分かれており、両者が同一トランザクション内でなく、行ロックも取得していない。
そのため、片方がUPDATEを完了する前にもう片方のSELECTが通過してしまう
（Time Of Check to Time Of Use）。
DB側にも「同一organizationで同時にliveは1件まで」を保証する制約が存在しない。

**実証結果（2026-07-30）：**
- ローカルPCからSSHトンネル経由でcurlを並行実行（10回）→ 競合0回。
  ただし10回とも同じイベント側が勝つ完全に一貫した結果であり、
  トンネル経由のリクエストが実質的に直列化されていたと判断。
- EC2内から直接、Node.jsの`http`モジュール＋`Promise.all`で同一イベントループ内から
  同時発行（20回）→ **20回中19回、両方が`live`になった。** 勝敗の偏りは消失。
- 検証環境：`cheerstick_staging`。検証後、データは復元済み。

**影響：** 同一organizationで複数の試合が`live`になると、
`findLiveEventForOrganization`が`LIMIT 1`で1件のみを取得する実装のため、
**応援ログ（`cheer_logs`）が意図しない試合へ記録される**恐れがある。
応援量でMVP・ランキングを決める設計であるため、データの信頼性に関わる。

**実運用でのリスク評価（2026-07-30 時点）：**
- 管理APIはnginxでIP制限済み（`allow 49.156.217.121; deny all;`）であり、
  操作者はKMT様のみ。ブラウザからの手動操作である。
- 人間のクリック操作で、数ミリ秒以内に異なる2試合を`live`にすることは
  事実上不可能。同じ試合を連打しても同一IDのため無害。
- したがって**実害が発生する確率は極めて低い**と評価。

**対応方針：** **リリース後の改良として対応する**（2026-08-第1週のリリースを優先。
KMT様判断、2026-07-30）。未対応のまま放置するのではなく、
リリース後の改善項目として確定している。

**対策候補（優先度順）：**

1. **部分UNIQUEインデックス（推奨）**
   ```sql
   CREATE UNIQUE INDEX idx_events_one_live_per_org
     ON events (organization_id) WHERE status = 'live';
   ```
   - DBレベルで保証するため、アプリ側のタイミング問題に関係なく破れない
   - マイグレーション1本の追加で済む
   - **適用前の必須確認事項：**
     - **本番DB（`cheerstick_production`）に、同一organizationで複数`live`の
       レコードが既に存在しないか。** 存在するとインデックス作成が失敗する
     - `CONCURRENTLY`はトランザクション内で実行できないため、マイグレーション
       ランナーの実装と衝突しないか（`events`は小規模なため`CONCURRENTLY`なしでも
       瞬時に完了する見込み）
   - **副作用：** インデックスのみを追加した場合、競合時に負けた側はDB制約違反となり、
     現在の409ではなく**500エラー**が返る。データは保護される（fail closed）が、
     エラー表示は不親切になる。下記2と併せて実装するのが望ましい

2. **アプリ側で制約違反を捕捉し409へ変換**
   - 上記1の副作用への対応。UNIQUE制約違反（PostgreSQLエラーコード`23505`）を
     捕捉し、既存の`LIVE_EVENT_CONFLICT`と同じ409レスポンスへ変換する

3. **トランザクション＋行ロック**
   - `SELECT ... FOR UPDATE`でチェックと更新を同一トランザクションに包む
   - スキーマ変更は不要だが、DBレベルの保証にはならない（アプリを経由しない
     直接のDB操作は防げない）

### 11.3 管理画面にDELETEエンドポイントが存在しない（2026-07-31追記）

管理画面には試合（`events`）の削除手段が存在せず、動作確認用のテストデータや
誤登録した試合を画面から消せない。

**2026-07-31、KMT様の判断により実装が決定した。** 設計方針は
`docs/proposals/admin-delete-endpoint.md` に格納済み（実装前に`cheer_logs`の
外部キー削除時挙動＝`confdeltype`の確認が必須、CASCADEだった場合は設計の
見直しが必要と明記されている）。

> **2026-07-31追記：物理DELETE方式から非表示化方式へ設計変更。**
> staging環境（`cheerstick_staging`）で`confdeltype`を確認した結果、`r`/`a`/`c`の
> いずれでもなく`n`（**SET NULL**）だった。物理削除すると`cheer_logs.event_id`が
> 無言でNULLへ書き換わり、応援ログがどの試合のものか分からなくなる
> （CASCADEより発見しづらい形の破損）。この事実を踏まえKMT様が判断し、
> **物理削除ではなく非表示化（`events.hidden_at`列によるフラグ立て）方式に変更した。**
> 新しい設計方針は`docs/proposals/admin-hide-endpoint.md`（旧`admin-delete-endpoint.md`を
> 置き換え）に格納。エンドポイントは`DELETE /api/v1/admin/events/:id`のまま維持するが、
> 実装は物理削除ではなく`hidden_at`へのタイムスタンプ設定となる。

**実装時期：** 案B（`admin.cheerstick.com`新設）の本番反映が完了した後、
staging環境（`cheerstick_staging`、ポート3001）で実装・検証してから、
単独のデプロイとして本番反映する方針（同日の複数変更を避けるため）。
`docs/proposals/production-deploy-plan.md` 4章にも同様の記録あり。

**2026-07-31追記：本機能は「余裕があれば対応する」改善項目ではなく、8/9の試合に
向けた前提条件であることが判明した。** 案B本番反映のPHASE 6-5（管理画面の書き込み
動作確認）を実施しようとした際、`status`を`finished`にすると当該試合の操作ボタンが
消えて元に戻せず、かつ現時点でDELETEエンドポイントが存在しないため、**一度登録・
進行させた試合データは本番から除去する手段が無い**ことが判明した。誤って本番用の
初回試合データを操作すると、8/9当日まで復旧不能な状態で一覧に残り続けるリスクがある。
そのため、**8/9に向けた本番用試合データの登録は、DELETE機能の実装・本番反映が
完了するまで行わない**方針とした（KMT様判断、2026-07-31）。PHASE 6-5は未実施のまま
保留し、代替としてCORSプリフライト（`OPTIONS`、POST/PATCH）による書き込み系通信経路の
疎通確認のみ実施した（詳細は`docs/worklog.md`2026-07-31エントリ、
`docs/tasks/2026-07-31-planB-deploy.md`末尾の実施結果を参照）。

### 11.4 `updateEventStatus`/`updateEvent`が非表示化済み(`hidden_at`)イベントをチェックしない（2026-07-31追記）

非表示化機能（11.3、`docs/proposals/admin-hide-endpoint.md`）のstaging実装時に判明。
管理API`PATCH /api/v1/admin/events/:id`（`updateEvent`）・
`PATCH /api/v1/admin/events/:id/status`（`updateEventStatus`）は、対象イベントが
`hidden_at`により非表示化済みかどうかを一切確認していない。そのため、非表示にした
（＝一覧からは消えた）試合に対しても、IDさえ分かれば編集・状態変更（`live`化を含む）が
そのまま通ってしまう。

非表示化の意図（誤登録・テストデータを一覧・記録対象から外す）と矛盾する可能性がある
挙動だが、非表示化機能の実装時点ではこの制限を追加する指示が無かったため未対応とした。
対応要否（非表示化済みイベントへの操作を404扱いにする等）はKMT様の判断が必要。

### 11.5 `routes/events.js`/`src/controllers/eventsController.js`が実スキーマと異なる`events`を参照している（2026-07-31追記）

非表示化機能のSTEP4（一般公開系エンドポイントの洗い出し）で発見。`POST /api/v1/events`・
`GET /api/v1/events`（`eventsController.js`）は`events`テーブルに対し
`id, device_id, event_type, payload`という列構成でSELECT/INSERTしているが、
実際の`events`テーブル（`migrations/001_initial_schema.sql`）にはこれらの列は存在しない
（実際は`organization_id, venue_id, title, sport_type, starts_at, ends_at, status`等の
「試合・イベント管理」用テーブル）。

呼び出すと存在しない列を参照して失敗する可能性が高く、事実上動作しない死んだコードと
判断される。出所・意図は未確認（旧`cheerstick-api`プロトタイプ由来の可能性があるが未追跡）。
今回の非表示化機能の対象（試合管理用の`events`）とは無関係のため、修正・削除は本機能の
範囲外として対応していない。対応要否は別途判断が必要。

> 以下2件（11.6・11.7）は2026-08-10、管理画面の動作確認中に付随して判明したものである。
> 計画的な設計レビューの結果ではなく、テスト作業からの副次的な発見である。
> いずれも実データが入る前に判明したため、現時点での実害は無い。

### 11.6 `finished`からの復帰手段が存在しない（2026-08-10追記）

**事象**

管理画面で試合を`finished`にすると、以下のいずれもできなくなる。

- 状態を戻すこと（編集フォームの項目は試合名・チーム・開始日時・終了日時の4項目のみで、
  `status`を変更する手段が無い）
- 削除すること（DELETE機能が未実装。`finished`の行には「編集」ボタンのみ表示される）

結果として、**誤って`finished`にした試合データは画面から一切操作できなくなる。**
2026-08-10に実際にこの状態が発生し、本番DBへの手動SQLで削除して対処した
（詳細は`docs/worklog.md`該当日エントリ参照）。

**影響**

- 試合当日の操作ミス（誤って[終了]を押す）が、復旧不能な状態を生む
- 復旧のたびに本番DBへの直接SQLが必要になり、運用として持続しない

**対応が必要な点**

1. **DELETE機能の実装**（`docs/proposals/admin-delete-endpoint.md`）
   - 7/31時点では「8/9試合の前提条件」という位置づけだったが、実際には
     **仮データの片付けという日常的な場面で必要**になることが判明した。
     優先度の再評価が必要
2. **状態遷移そのものの見直し**
   - `finished`を終端状態のままとするか、条件付きで復帰可能にするか
   - 復帰を許す場合、どの状態へ戻すか（`paused`/`draft`）
   - 誤操作防止（確認ダイアログ、試合名の手入力等）との組み合わせで検討すること

> **2026-08-11追記：** 2026-08-10の事故（本節記載の通り、誤って`finished`にした試合を本番DBへの手動SQLで削除して対処した件）を受け、**DELETE機能の実装優先度を引き上げる。** 従来「対応が必要な点」の1項目として記載していたが、リリース前の必須対応候補として扱う（最終判断はKMT様）。

> **2026-09-06追記：** 「対応が必要な点」2.（状態遷移の見直し）を実装（B-1、コミット`5734e54`、2026-09-06本番反映・実機検証済み）。復帰先は`paused`固定とし、誤操作防止として確認ダイアログ（試合名・現在の状態を表示、手入力は無し）を実装した。詳細は8章「管理API」を参照。**「対応が必要な点」1.（DELETE機能）は本追記の対象外で、引き続き未実装。**

### 11.7 `cheer_logs`/`awards`の外部キー制約がSET NULL（2026-08-10追記）

**事象**

`events`を参照する外部キー制約の削除時挙動は以下の通り（2026-08-10確認）。

| 子テーブル | confdeltype | 挙動 |
|---|---|---|
| `awards` | `n` | SET NULL |
| `cheer_logs` | `n` | SET NULL |
| `cheer_summaries` | `c` | CASCADE |
| `device_event_sessions` | `c` | CASCADE |
| `event_targets` | `c` | CASCADE |

**影響**

実データが入った試合を削除した場合、`cheer_logs`と`awards`の行は
**削除されずに残り、`event_id`だけがNULLになる。**

- どの試合の応援記録か特定できない孤児レコードが大量に発生する
- 月間MVP・年間MVPなどの集計に影響する可能性がある
- 件数が多い場合、後からの復旧は事実上困難

**現時点で実害が無い理由**

`cheer_logs`は現在0件であり、実際の応援データはまだ蓄積されていない。

**対応が必要な点**

1. **この制約設計が意図通りかの確認**
   - SET NULLが意図的な選択（試合が消えても応援実績は残す）なのか、
     既定値のまま実装されたものなのかを確認すること
2. **RESTRICTへの変更検討**
   - `docs/proposals/admin-delete-endpoint.md`では「`cheer_logs`が0件のときのみ
     削除可」とアプリ側で判定する設計になっている
   - この判定をすり抜けた場合の受け皿がDB側に無い状態である
   - RESTRICTにすればDB側でも二重に守れる
   - **ただしスキーマ変更を伴うため、本追記自体では実施していない**
3. **実施するなら実データが入る前が望ましい**
   - 応援データが蓄積された後の制約変更は、既存行の整合性確認が必要になる

> **2026-08-11追記（範囲の訂正）：** 本節は`cheer_logs.event_id`のSET NULLのみを記載していたが、2026-08-11の調査で、SET NULLの対象は`event_id`だけでなく**`target_id`・`user_id`にも及ぶ**ことを確認した（`cheer_logs`の3列（`event_id`/`target_id`/`user_id`）すべてが`ON DELETE SET NULL`。`device_id`のみ`RESTRICT`）。あわせて、`awards`テーブルは`event_id`/`target_id`が`SET NULL`である一方、**`user_id`のみ`CASCADE`**という設計になっており、4テーブル（`cheer_logs`/`awards`/`cheer_summaries`/`event_targets`）横断で削除時挙動が不統一であることが判明した（`cheer_summaries`/`event_targets`は全列`CASCADE`）。統一方針の要否についてはKMT様の判断が必要。

---

## 変更履歴

| 日付 | 変更内容 | 理由 |
|---|---|---|
| 2026-07-25 | 初版作成 | handover v14 および監査結果を統合。以後はこのファイルを正本とする |
| 2026-07-25 | 第6章（カテゴリー機能）を「生存確認が必要」から「実装済み」へ更新 | コードリーディングにより、categoriesテーブル・listOrganizations(categoryId)・computeStatus()のcategory_id必須チェック・setDeviceOrganizationのCATEGORY_MISMATCH検証の4点が現行コードに存在し、実装コミットd75d8f1以降削除されていないことを確認。本番DBへのmigration 004適用状況のみ未確認として残す |
| 2026-07-25 | 3.3の再有効化手順に「REFERENCE_TOKEN_SECRETの再生成」ステップを追加 | コードレビューで`reference_url`（WebSocket connect応答・REST /webview/reference）が既に実装済みであることを確認。有効化時に本番の秘密鍵をローテーションする運用が未文書化だったため、実行はせず手順のみ記録。現在の`REFERENCE_TOKEN_SECRET`の値は一度チャットへ露出したため、必ずローテーションする旨を理由として明記 |
| 2026-07-25 | 8章の管理API記述にnginx IPアドレス制限（本番反映済み）を追記、4.2に`register`のTOFU仕様と所有者リセット手順への参照を追加 | 商用リリース前の必須セキュリティ対応2件（管理APIのIP制限、デバイス所有者の上書き防止）を実施。管理APIのアプリケーションレベル認証は引き続き未実装のため、その旨は既存記述を残したまま維持し追記のみとした。`register`の実装調査で`set_name`/`broadcast`という現行コードに存在しないtypeがテーブルに残っていることに気づいたため、削除はせず「次回要精査」の注記を追加した |
| 2026-07-25 | 6.1「targetsテーブルの設計」を新設、9.1「プロフィール表示の空枠仕様」を新設、マイグレーション一覧に008を追加 | 「チーム・推し選手プロフィールの枠」実装の作業指示書を調査したところ、`organizations.logo_url`・`targets.image_url`・WebSocket応答への画像URLはいずれも既に実装済みであり、指示書の前提（静的ファイル直書き、選手専用テーブル、画像URL未実装）と大きく異なることが判明。指示書自身の分岐基準に従い一度報告し、縮小版のスコープ（`targets.profile_text`列の追加とnull安全性の穴埋めのみ）で実施した。あわせて`targets`が選手専用ではなくtype列による汎用管理テーブルである設計を明記し、今後同じ誤認が起きないようにした |
| 2026-07-27 | 3.2「チームID登録」に実装との乖離を追記、第11章「既知の課題」を新設 | デモモード実装の前段調査として`geturl`・WebSocket `connect`のコードリーディングと本番実地確認（未使用MACアドレスでの実行）を行った結果、当初「事前ホワイトリスト方式に確定済み」としていた3.2の記述と異なり、`ensureDevice()`が任意のMACアドレスを条件なく`devices`へ自動登録することが判明。3.2の既存記述は削除せず追記で乖離を明記し、これに伴うセキュリティ上の影響（認証機構が無く任意のMACで`cheer_logs`へ書き込み可能、応援量捏造のリスク）を新設の第11章に記録した。対応時期は未定としリリース後の検討事項とする |
| 2026-07-31 | 11.3「管理画面にDELETEエンドポイントが存在しない」を新設 | KMT様の判断によりDELETE機能の実装が決定（設計方針は`docs/proposals/admin-delete-endpoint.md`）。従来`docs/proposals/production-deploy-plan.md`4章のみに記載されていた既知課題を、spec.mdを既知の課題の正本とする方針に合わせて11.3として正式に記録した |
| 2026-07-31 | 11.3に追記：DELETE機能が8/9試合の前提条件である旨を明記 | 案B本番反映PHASE 6-5の実施時、`finished`後は操作不能かつDELETE未実装のため本番データが復旧不能になるリスクが判明。8/9向け本番データ登録をDELETE機能完了まで見送る方針（KMT様判断）を記録 |
| 2026-07-31 | 11.3に追記：物理DELETE方式から非表示化方式への設計変更を記録 | staging環境での`confdeltype`確認により`n`（SET NULL）と判明。物理削除では`cheer_logs.event_id`が無言でNULL化される問題があるため、KMT様判断により`events.hidden_at`列による非表示化方式へ変更。設計方針書を`docs/proposals/admin-hide-endpoint.md`へ差し替え |
| 2026-07-31 | 11.4「updateEventStatus/updateEventがhidden_atをチェックしない」、11.5「routes/events.js等が実スキーマと異なるeventsを参照している」を新設 | 非表示化機能のstaging実装・検証（STEP4の一般公開系エンドポイント洗い出し）で判明した2件を、KMT様の指示により既知の課題として正式に記録した |
| 2026-08-10 | 11.6「finishedからの復帰手段が存在しない」、11.7「cheer_logs/awardsの外部キー制約がSET NULL」を新設 | 管理画面の動作確認中に登録した仮の試合データが`finished`となり削除・復帰いずれもできなくなったため、本番DBへの手動SQLで削除して対処（詳細は`docs/worklog.md`該当日エントリ参照）。その過程で判明した設計課題2件を、計画外の副次的発見である旨を明記した上でKMT様の指示により正式に記録した |
| 2026-08-11 | 1.1「名称について」を新設、11.6に優先度引き上げの追記、11.7に範囲訂正（target_id/user_idも対象、awardsのuser_idのみCASCADEで不統一）の追記、4.3末尾にcheer-count-algorithm.mdの位置づけ注記を追加 | 全体棚卸し調査（Google Drive経由の指示書に基づく読み取り専用調査）の結果を反映。サービス名（推しフル/CheerStick）の定義が未記載だった点、11.7がcheer_logsのSET NULL対象を`event_id`のみと誤解を招く記載だった点（実際は`target_id`/`user_id`も対象、`awards.user_id`のみCASCADEで4テーブル横断の不統一あり）、`cheer-count-algorithm.md`が現行サーバー仕様と誤認されうる点をいずれも既存記述を削除せず追記で是正した |
| 2026-08-18 | 4.1に「category_id判定の生存確認完了」の追記、6.2「カテゴリー判定の実装詳細」を新設 | Vanstone様検証機2台の接続エラー調査（読み取り専用）により、category_id未設定判定がWebSocket `connect`でのみ行われ`geturl`では行われないこと、`is_demo`による迂回が存在しないこと、`connect`の接続試行を記録するアプリケーションログが存在しないことを確認したため。詳細は`docs/worklog.md`同日エントリ参照 |
| 2026-08-18 | 6.2に追記：接続ログを本日中に実装・本番反映した旨を記録 | 同日の調査で判明した「connectの接続試行を記録するログが存在しない」状態を解消するため実装（`src/websocket/index.js`、コミット`d7e965c`）。既存記述（ログが存在しないという6.2の記載）は削除せず、対応済みである旨を追記で更新した。詳細は`docs/worklog.md`同日エントリ「WebSocket `connect` の接続ログを追加」参照 |
| 2026-09-06 | 8.1「finishedからの復帰」、8.2「状態変更ログ」、8.3「管理API：チーム登録・編集」を新設、11.6に対応完了の追記 | B-1〜B-4（コミット`5734e54`、2026-08-19実装・2026-09-06本番反映＋実機検証完了）の仕様化。反映完了を待って追記する方針としていたため（2026-08-19付worklog参照）、本番反映・実機検証が完了した本日まとめて記載した。11.6「対応が必要な点」2.（状態遷移の見直し）は本対応で解消したが、1.（DELETE機能）は対象外で未実装のまま残ることを明記した |
| 2026-09-06 | 9章の電池残量表示の記述を更新、9.2「電池残量警告の継続時間判定」を新設 | Vanstone様よりLED点灯時の瞬間的な電圧降下で電池残量警告が誤発報するとの指摘を受け、単発の瞬時値判定（volt <= 3.0Vの1回受信で即時表示）から、60秒間連続して閾値以下の場合のみ表示するタイムスタンプベースの継続時間判定へ変更（`public/index.html`）。実装・ローカルでの構文チェック／状態遷移の単体検証までは完了。実機検証・本番反映はKMT様側で実施するため未実施のまま |
| 2026-09-11 | 7章のマイグレーション一覧に009・010・011を追加、8.0「管理画面の状態遷移ボタン」を新設、8.4「対抗戦ペア管理・スコアAPI」を新設、9.3「管理画面：対抗戦ペア管理・一括操作」・9.4「対抗戦スクリーン表示ページ」を新設 | KMT様提案の新機能「2チーム対抗応援合戦」の実装（`event_battles`テーブル新設、`migrations/011_add_event_battles.sql`）に伴う仕様化。既存の`events`テーブルには変更を加えず、events同士をペアリングする別テーブルとして実現した（先行の設計調査で home_organization_id/away_organization_id 追加は影響範囲が大きいと判断し見送り）。あわせて、同調査中に判明した「管理画面の停止/再開ボタン（2026-07-30実装）が8章・9章に一度も記載されていなかった」という既存の記載漏れも、新規仕様ではなく過去の記載漏れの補記として8.0に追加した。実装はローカル（pg-mem疑似DBによるmigration適用・DB関数・HTTP・ブラウザ確認）まで完了。本番DBでの確認・本番デプロイは未実施（KMT様指示により今回の対象外） |
| 2026-09-14 | 9.3に追記：一括開始/停止/終了への状態遷移ルール適用を記録 | 実装後の確認で、一括操作が`finished`→`live`のような単発ボタンでは表示されない遷移まで実行できてしまう点が指摘され、`public/admin/index.html`の`bulkChangeStatus()`に`actionButtonsFor()`の戻り値を用いた事前チェックを追加した。対象外の遷移はAPIを呼ばずスキップし、チェックを残したまま「対象外」である旨を表示するよう修正。既存記述（「現在のstatusに応じた遷移可否のチェックは行わない」）は削除せず追記で更新した。スコアAPI（8.4章）の認証・IP制限方針はKMT様確認済みのため変更なし |
