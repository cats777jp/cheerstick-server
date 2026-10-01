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

> **2026-09-17追記：** ping/pong未実装によるリスクを実機接続テストで確認した。
> 詳細は第11.10章「WebSocketの接続が正しくクローズされず残る場合がある（幽霊接続）」参照。

> **2026-09-20追記：ping/pongハートビート実装（ローカル・pg-mem疑似DB確認まで）。**
> 11.10章の対応案(a)(b)を実装した。`feature/reference-data`ブランチのまま、
> 本番デプロイは対象外。詳細は11.10章末尾の追記を参照。

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

> **2026-09-17追記：** 実機検証（4回目、11.7章参照）で、`sendLED`が引き続き
> Vanstone様側で未実装のままであることを再確認した。検証中「LED色が変わって
> 見えた」という観察があったが、時間帯（夕方〜夜間）による環境光の変化が
> 原因である可能性が高く、ブリッジが実際に動作したと断定はしていない。
> Vanstone様への確認事項として、ブリッジの実装状況・BLEプロトコル正式仕様書の
> 共有を依頼する予定（詳細は`docs/worklog.md`2026-09-17エントリ参照）。

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

> **2026-09-16追記：** 新ジャンルの登録手段として管理API（`POST /admin/categories`）・
> 管理画面UI（8.7・9.8章）を新設した。ただし上記「INSERTのみで完結するか未検証」の
> 論点自体は解消していない（既存デバイス・organizationsへの割当作業やアプリ側対応の
> 要否は、実際に新ジャンルを追加する運用が発生した際に改めて確認が必要なまま）。

> **2026-09-17追記（デバイス量産・ジャンル運用方針の決定）：** 上記の
> 「実際に新ジャンルを追加する運用が発生した際」が今回発生したため、方針を
> 決定した。手元にある2,000本のMACアドレス一覧（「チアスティックのMACアドレス
> 一覧表-20260717発送分」）は、当初Jリーグ単独契約を前提に1ジャンルへまとめて
> 登録する想定だったが、**その契約自体が白紙となり、現在複数の販路を並行して
> 模索中**であるため、2,000本まとめての一括登録は見送りとした。
>
> **新方針：** 契約・案件が決まった分から順次、専用のジャンルを
> `masters.html`のジャンル管理機能（8.7・9.8章）で作成し、該当するMAC
> アドレス分だけCSV一括取込→絞り込み一括適用（9.5章のデバイス管理機能）で
> ジャンルを設定する運用とする。ジャンルの親子階層化（例：J1リーグ・J2リーグを
> 「Jリーグ」の子ジャンルとする案）は不要と判断した（J1・J2等は最初から
> 別々のジャンルとして登録する方針）。
>
> あわせて、デバイスの`category_id`によるチーム絞り込みが、クライアント側
> フィルタではなくサーバー側SQL（`listOrganizations`のWHERE句、
> `setDeviceOrganization`/`setDeviceTarget`のJOIN照合）で堅牢に実装済みで
> あり、ジャンルをまたいだチーム選択が`CATEGORY_MISMATCH`・
> `TARGET_TEAM_MISMATCH`でサーバー側から確実に拒否されることを、本方針決定に
> 先立つ調査で確認済みである（6.2章・8.5章参照）。この点が、複数ジャンルを
> 段階的に増やしていく運用方針を採用する後押しとなった。

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
011_add_event_battles.sql           （event_battles テーブル新設。8.4章参照。2026-09-11実装・
                                     ローカル確認後、同日中に本番DBへ適用済み。ただし
                                     アプリDB接続ロールへの権限付与が未完了のため対抗戦機能は
                                     まだ使用不可。11.8章参照）
012_add_ranking_snapshots.sql       （ranking_snapshots・ranking_snapshot_entries テーブル新設。
                                     試合終了時の順位確定機能（ユーザー別・選手別、上位20名）用。
                                     2026-09-23作成、ファイル作成のみ。staging・本番とも未適用）
```

> **2026-09-24訂正：** 上記「staging・本番とも未適用」は誤り。2026-09-24セッション冒頭の
> 確認で、stagingには既に012が適用済み（`ranking_snapshots`・`ranking_snapshot_entries`
> テーブルが実在、`schema_migrations`にも記録あり）であることを確認した。前回
> （2026-09-23）セッション終了時に`/handover`が未実行だったため、この適用作業自体が
> worklog・spec.mdのいずれにも記録されないまま残っていたと考えられる（詳細は
> `docs/worklog.md` 2026-09-23エントリ〔2026-09-24追記分〕参照）。**本番は引き続き未適用。**
> 既存記述は削除せず、本訂正を追記する。

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

**追記（チームカラー設定機能、2026-09-17実装・ローカル確認まで）：**
`POST`/`PATCH`の両方に`color`（HEX形式、例: `#1E3A8A`）を追加した。
`organizations.color`列自体はmigration 007（2026-07-31）で既に追加済みで
未使用のまま残っていたものを、今回初めて管理APIから設定可能にした
（5.3章のLED制御・フロントの`--team-color`カスタムプロパティが参照する列）。

```
POST /admin/organizations
  body: { name, category_id, logo_url?, color? }
  colorは`/^#[0-9A-Fa-f]{6}$/`形式チェックのみ（重複チェック等は無し）。
  不正な形式は400 { error: "INVALID_COLOR_FORMAT" }。未指定・空文字ならNULLのまま
  （既存データが無い新規チームはこの状態から始まる想定）

PATCH /admin/organizations/:id
  body: { name?, category_id?, logo_url?, color? }
  colorが空文字の場合は「変更しない」として扱う（他フィールドの空欄運用とは異なり、
  誤操作でチームカラーがNULL化されることを避けるため）。不正な形式は同じく400
```

### 8.4 対抗戦ペア管理・スコアAPI（2チーム対抗応援合戦機能、2026-09-11実装・同日本番反映）

> **2026-09-11追記：本番デプロイ完了、ただし現時点では機能未使用可。**
> migration 011・バックエンドコード・静的ファイル（後述9.3・9.4含む）一式を本番反映した。
> ただし`event_battles`テーブルのDB権限が未整備のため、対抗戦関連APIは全て
> `permission denied`エラーとなる状態が本デプロイ直後に判明している。詳細・対応要否は
> 11.8章参照。以下の章の「本番未反映」等の記述は反映前（2026-09-11午前まで）の状態の
> 記録として残す。

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

> **2026-09-11追記：本番デプロイ実施。** 上記のローカル確認を経て、同日中に本番へ
> migration 011・コード・静的ファイル一式をデプロイした。デプロイ手順・結果・発覚した
> DB権限問題は`docs/worklog.md`2026-09-11エントリ（「2チーム対抗応援合戦」機能の本番デプロイ）
> 参照。DB権限問題の詳細は11.8章参照。

> **2026-09-17追記（実データでの動作確認）：** 実機検証（4回目、11.7章参照）で、
> 対抗戦スコア表示を実データで確認した。live化した試合Aでは実機での応援動作に
> 応じて応援量が878→1910まで反映され、scheduledのままとした試合Bは0のまま
> 変化しないことを確認した（4.3章の判定どおりの挙動）。
> `docs/verification-checklist-hardware.md`項目2完了。詳細は`docs/worklog.md`
> 2026-09-17エントリ参照。

> **2026-09-25追記（対抗戦テーマ画像機能）：** イベントごとにヘッダー画像（テーマ画像）を
> 差し替え可能にする機能を追加した。`events.metadata`（JSONBカラム、001初期スキーマの
> 時点から存在するが、Phase 0調査でアプリコードから一切未使用だったことを確認済み）に
> `{"themeImageUrl": "<URL>"}`の形で保存する。
>
> - `PATCH /admin/events/:id`に`theme_image_url`を追加（既存のtitle/organization_id/
>   starts_at/ends_atと同じ部分更新方式）。値がfalsy（null・空文字）の場合は
>   `themeImageUrl`キー自体を削除する「解除」操作として扱う。他のキーとの衝突を避けるため
>   metadata列全体の上書きではなくJSONBの`||`演算子でマージする（`updateEvent()`、
>   `src/db/cheerstickQueries.js`）
> - 画像の保存自体は8.8章の既存アップロード機能（`POST /admin/uploads/image`）をそのまま
>   流用し、新規のアップロード機構は作っていない
> - `GET /event-battles/:id/score`（本章）のレスポンスに`theme_image_url`を追加。
>   `events.metadata`は個々のイベント単位の列だが、対抗戦画面は1画面に2イベント
>   （`event_a`・`event_b`）を表示するため、どちらの値を採用するかは指示書に明記が
>   無かった。試合A（画面左側）優先、試合Aが未設定なら試合Bにフォールバックする方式とした
>   （`eventBattleController.getScore`）。この判断はKMT様に報告済みで、問題があれば
>   別方式（例：event_battles側に持たせる）への変更を検討する
> - `getEventBattleMeta()`のSQLが従来`events.metadata`列を一切SELECTしていなかったため
>   （Phase 0調査で発見）、`event_a_metadata`/`event_b_metadata`として追加した
> - 表示側（`battle.html`の変更内容）・管理画面の入力欄は9.4章参照

### 8.5 管理API：選手・推し対象（targets）登録・編集・削除（2026-09-13実装・ローカル確認まで）

`targets`テーブル（6.1章参照）自体は`connect`応答（推し選択肢の提供）・`count`（応援ログの
`target_id`記録）で既に実運用中だったが、管理画面からの登録・編集手段が存在せず、本番DBへの
直接`UPDATE`（9.1章参照）に頼っていた。これを解消するため、既存の`organizations`管理API
（8.3章）と同じパターンで新設した。マイグレーション（DBスキーマ変更）は無し（既存の列を
そのまま使う）。

```
GET /admin/targets?organization_id=<uuid>
  organization_id未指定時は全件を返す。指定時はそのチーム配下のみに絞り込む

POST /admin/targets
  body: { name, organization_id, type, image_url?, number?, profile_text?, is_active? }
  name・organization_id・typeは必須。
  organization_id：DB上のtargets.organization_idはNULL許容だが、所属チームの無いtargetは
    WebViewの推し選択（listTargetsByOrganization、既存実装）に一切現れず実質使えなくなるため、
    organizations.category_id（8.3章）と同じ考え方でアプリ層で必須とした
  type：DB列がNOT NULLのため必須。CHECK制約は無く自由入力（既存データはplayer/mascot。
    画面側はdatalistで候補提示するのみで値の制限はしない）
  organization_idが存在しない場合は400 { error: "ORGANIZATION_NOT_FOUND" }

PATCH /admin/targets/:id
  body: { name?, organization_id?, type?, image_url?, number?, profile_text?, is_active? }
  （updateOrganizationAdminと同じ部分更新方式）
  対象が無ければ404 { error: "TARGET_NOT_FOUND" }

DELETE /admin/targets/:id
  物理削除。devices.current_target_id または cheer_logs.target_id で参照されている場合は
  409 { error: "TARGET_IN_USE" } を返し、削除をブロックする（後述）
  対象が無ければ404 { error: "TARGET_NOT_FOUND" }

⚠️ 認証は他の管理APIと同じくnginx側のIP制限のみ（アプリケーションレベル認証なし）。
```

`metadata`列（JSONB）は本APIの対象外（管理画面の入力項目に含まれない）。既存の空枠仕様・
`profile_text`追加時と同じ判断で、種別固有の追加属性は引き続き直接SQLでの編集対象のまま
とした。

**DELETE時のTARGET_IN_USEガードについて（実装前調査で判明した事実に基づく設計）**：
`devices.current_target_id`・`cheer_logs.target_id`の外部キー制約はいずれも
`ON DELETE SET NULL`であることを実装前に確認済み（本番DBの`pg_constraint`で実測）。
そのためDB制約だけに頼ると、参照中のtargetを物理削除した場合に`cheer_logs.target_id`が
無言でNULL化され、「どの選手への応援だったか分からない」孤児レコードが発生する
（11.7章の`events`削除時と同種の問題）。これを避けるため、削除前にアプリ層で
`devices.current_target_id`・`cheer_logs.target_id`の参照有無を確認し、参照がある場合は
削除をブロックする方式とした。`event_targets`・`cheer_summaries`・`awards`・
`user_target_follows`の4テーブルもtargetsを参照する外部キーを持つが（`ON DELETE CASCADE`）、
コード上一度も参照されていない未使用機能（6.1章の参照元整理と同じ調査結果）のため、
参照チェックの対象には含めていない。

**実装前調査で判明したその他の事実**：
- `targets.type`の値を決め打ちで分岐しているコードは、`ORDER BY (type = 'mascot') DESC`
  （`listTargetsByOrganization`、推し選択肢の並び順）と、`public/index.html`の表示ラベル
  分岐2箇所（`t.type === 'mascot' ? 'マスコット' : ...`）のみ。いずれも表示上の特別扱いに
  留まり、本APIの実装を妨げるものではないと判断した（`listTargetsAdmin`の一覧も同じ
  `ORDER BY`を踏襲し、既存の並び順と一貫させている）
- **`public/index.html`（エンドユーザー向けWebView）には、「チーム選択→推し選手選択」の
  UIが既に完全に実装済みであることを確認した。** `renderTeamList()`（`select_team`送信）・
  `renderPlayerList()`（`set_oshi`送信）・`renderConnect()`内の`team_selection`/
  `player_selection`状態分岐が揃っており、本APIで登録・編集したデータは追加のWebView側
  実装を要さずそのまま反映される

**動作確認（2026-09-13、staging DBに接続したローカルサーバーで実施）**：
- 新規登録・一覧取得・チーム絞り込み・部分更新・不正なUUID/存在しないIDでの400/404を確認
- `ORGANIZATION_NOT_FOUND`（存在しないチーム指定時）を確認
- 削除ガードを2経路とも確認：新規作成したテスト用デバイス1件の`current_target_id`を
  対象targetに設定した状態でのDELETE、および新規作成したテスト用`cheer_logs`行が
  対象targetを参照している状態でのDELETE、いずれも409 `TARGET_IN_USE`になることを確認。
  参照解除後は正常に削除できることも確認
- 確認に使った試合・応援ログはすべて削除・非表示化して原状回復した。確認用に作成した
  デバイス1件（MAC `AA:AA:AA:11:22:33`）はデバイス管理APIに削除機能が無いため残存している
  （既存デバイス2件を含む前回セッションの検証用データと合わせ、後日整理予定）

### 8.6 チーム別・選手別の応援集計API（2026-09-13新設・ローカル確認まで）

`event_battles`のスコアAPI（8.4章）と同じ「認証を追加せず、参照専用のシンプルなSUM集計」
という設計方針を踏襲し、target単位（選手・マスコット単位）の集計を追加した。

```
GET /api/v1/events/:id/target-scores
  指定イベントのcheer_logsをtarget_id単位でSUM(intensity)集計し、targets・organizationsを
  JOINして名前・チーム情報も返す。statusによる分岐は行わない（4.3章の判定ロジック側で
  status='live'以外はそもそもcheer_logsへ書き込まれないため、ここで重ねて絞り込む必要が
  無いという、event_battlesスコアAPIと同じ考え方）
  イベントが存在しない場合は404 { error: "EVENT_NOT_FOUND" }

  レスポンス例：
  {
    "event_id": "...", "event_title": "...",
    "targets": [
      { "target_id", "target_name", "target_type", "target_image_url", "target_number",
        "organization": { "id", "name", "color" } | null, "total_intensity" },
      ...
    ],
    "updated_at": "..."
  }

GET /api/v1/target-scores
  event_idの絞り込みが無いだけで、上記と同じ集計方式（全期間・全試合通算）。
  レスポンス形式は event_id/event_title を含まない以外は同じ

認証：/api/v1/admin/ 配下ではないため、本番nginxのIPアドレス制限は適用されない
（event_battlesスコアAPIと同じ理由。target-report.htmlを会場等の任意の端末で表示する
必要があるため、意図的にIP制限の外に置く）。
```

集計対象は`cheer_logs`を起点とし`targets`へINNER JOINするため、応援量0件のtargetは
一覧に現れない（`cheer_logs.target_id`がNULL＝推し未選択のままカウントされた行も、
INNER JOINにより自然に除外される）。

**動作確認（2026-09-13、staging DBに接続したローカルサーバーで実施）**：新規作成した
テスト用イベント・target・cheer_logsで、試合ごと（`total_intensity`が該当イベント分のみ
集計されること）・全期間通算（複数イベント分が合算されること）の両方を確認した。
存在しないイベントIDでの404も確認した。確認後、テストデータはすべて削除・非表示化した。

### 8.7 管理API：ジャンル（categories）登録・編集（改善3件フェーズ1、2026-09-16実装・ローカル確認まで）

6章の通りcategoriesテーブル自体は`migrations/004_add_category.sql`で実装済みだったが、
新規ジャンルの投入経路がマイグレーションファイルへの直書きSQL（またはDBへの直接INSERT）
しか無かったため、管理画面からの登録・編集手段を新設した。既存の`organizations`管理API
（8.3章）と同じパターンで実装した。

```
GET /admin/categories
  一覧をname順で取得（既存実装、B-5当時から存在）

POST /admin/categories
  body: { name }
  nameのみが入力項目。categories.slug列（NOT NULL UNIQUE）はアプリコードのどこからも
  参照されない内部用の値であることを実装前に確認済み（organizations.typeと同種の扱い）
  のため、UI入力項目としては公開せず、nameから生成した値にランダムなサフィックスを
  付与してサーバー側で自動生成する（nameが日本語のみの場合スラグ化すると空文字になるため、
  常にサフィックスを付与して一意性を保証する設計。衝突検知・リトライは行わない）

PATCH /admin/categories/:id
  body: { name }
  nameのみ更新可能（updateOrganizationAdminと同じ部分更新方式）。
  対象が無ければ404 { error: "CATEGORY_NOT_FOUND" }

⚠️ 削除（DELETE）は実装していない（B-4のorganizations管理APIと同じ方針。
   organizations.category_id・devices.category_idから参照されるテーブルのため、
   削除を実装する場合は8.5章のTARGET_IN_USEと同種の参照ガードが別途必要になる）
⚠️ 認証は他の管理APIと同じくnginx側のIP制限のみ（アプリケーションレベル認証なし）
```

**動作確認（2026-09-16、pg-mem疑似DBによるローカルHTTP検証）**：新規登録・一覧取得・
部分更新・存在しないIDでの404・不正なUUID形式での400を確認。既存の`GET /organizations`
が引き続き正常応答することも確認した（回帰無し）。実DB（staging/本番）での確認は未実施。

### 8.8 画像アップロードAPI（改善3件フェーズ2、2026-09-16実装・ローカル確認まで）

9.1章の通り、チームロゴ（`organizations.logo_url`）・選手/推し対象写真
（`targets.image_url`）はいずれも「URLをテキストで直接指定し、画像ファイル自体は
`/var/www/cheerstick-app/images/`配下へ手動配置する」方式のみだった。ドラッグ＆ドロップ
／ファイル選択によるアップロードに対応するため新設した。DBスキーマ変更は無し
（既存のlogo_url/image_url列へアップロード後のURLを保存するだけで、8.3・8.5章の
既存API・入力項目自体は変更していない）。

```
POST /admin/uploads/image
  multipart/form-data、フィールド名 file。jpg/pngのみ受け付ける
  - 拡張子（.jpg/.jpeg/.png）とファイル内容の先頭バイト（マジックバイト、
    JPEG: FF D8 FF / PNG: 89 50 4E 47 0D 0A 1A 0A）の両方を確認する
    （拡張子の詐称対策。いずれか一方でも一致しなければ400 UNSUPPORTED_FILE_TYPE）
  - ファイル名はUUID＋判定された拡張子で採番し、既存ファイルとの衝突を回避する
  - 保存先はUPLOAD_DIR環境変数（本番は/var/www/cheerstick-app/images/uploads/、
    未設定時はpublic/uploads/）。公開URLのベースはUPLOAD_URL_BASE環境変数
    （本番はhttps://app.cheerstick.com/images/uploads、未設定時はhttp://localhost:3000/uploads）
  - サイズ上限5MB。超過時は413 { error: "FILE_TOO_LARGE" }
  - 成功時は201 { "url": "<UPLOAD_URL_BASE>/<uuid>.<ext>" } を返す

⚠️ 認証は他の管理APIと同じくnginx側のIP制限のみ（アプリケーションレベル認証なし）
```

ディスクへの書き込みはmulter本体では行わず、`multer.memoryStorage()`でメモリ上に
受け取ってからマジックバイト検証→書き込みの順で行う（検証前のファイルを一切
ディスクに残さないための設計）。

**画像配信の仕組み（実装前調査で確認した事実）**：本番の`/var/www/cheerstick-app/`は
nginx（`cheerstick-app`サイト）が`root`として静的配信している構成で、`/images/`専用の
location設定は無い。アップロード先`/var/www/cheerstick-app/images/uploads/`もこの
延長で配信される（追加のnginx設定は不要）。`client_max_body_size`は本番nginx設定の
どこにも設定されておらずデフォルト値（1MB）だったため、本APIが受け付ける5MBの
アップロードに対応するには変更が必要と判明し、`/etc/nginx/sites-available/cheerstick-api`
の`location /api/v1/admin/`ブロックへ`client_max_body_size 5m;`を追加した
（詳細・実施記録は`docs/runbook.md`参照）。**なお本APIのリクエストは
api.cheerstick.com（cheerstick-apiがNode appへproxy）経由であり、app.cheerstick.com
（cheerstick-app、静的ファイル配信のみでNode appへのproxyなし）は一切経由しない**
（8.3章までの他の管理APIと同じ経路）。

**動作確認（2026-09-16、pg-mem疑似DBによるローカルHTTP検証）**：有効なPNG／JPEG（拡張子・
マジックバイト一致）のアップロード成功、拡張子偽装（内容はテキストだが`.png`拡張子）・
拡張子不一致（内容はPNGだが`.txt`拡張子）・6MBファイル（413）・fileフィールド欠如（400）の
いずれも想定通りのエラーになることを確認。アップロードされたファイルが実際にディスクへ
書き込まれること、拒否されたケースではファイルが書き込まれないことも確認した。

### 8.9 管理API・閲覧API：順位確定機能（Phase 1〜3、2026-09-23実装・2026-09-24 staging確認）

試合終了時に、ユーザー別・選手別それぞれの応援量上位20件を「確定」させ、履歴として
保存する機能。会場スクリーン（9.11章）から閲覧できるようにするためのバックエンド。
migration 012（7章参照）で`ranking_snapshots`（確定操作1回＝1行の履歴ヘッダ）・
`ranking_snapshot_entries`（明細、1確定あたり最大40行＝ユーザー別20＋選手別20）を新設。

```
POST /api/v1/admin/events/:eventId/ranking-snapshot
  「順位確定」ボタン。押すたびに実行可能（上書きではなく履歴として複数回分を保存する）。
  対象イベントのstatusがlive/paused/finishedのいずれかの場合のみ実行できる
  （scheduled/cancelledは400 INVALID_EVENT_STATUS）。存在しないイベントは404 EVENT_NOT_FOUND。
  認証は他の管理APIと同じくnginx側のIP制限のみ（アプリケーションレベル認証なし）。

  集計方法：cheer_logsをuser_id／target_idでSUM(intensity)集計し、RANK() OVER
  (ORDER BY SUM(intensity) DESC)で順位を採番（同点は同順位、以降の順位番号はスキップされる。
  例：1位2件→次は3位）。上位20件のみ。user_id／target_idがNULLのcheer_logs行は
  INNER JOINにより自動的に除外される。

  成功時 201:
  {
    "snapshotId": "...", "eventId": "...", "triggeredAt": "...",
    "userEntries": [{ "rank", "entity_id", "display_name", "cheer_value" }, ...],
    "targetEntries": [{ "rank", "entity_id", "display_name", "cheer_value" }, ...]
  }

GET /api/v1/events/:eventId/ranking-snapshots/latest?rankingType=user|target
  会場スクリーン向け閲覧用。指定イベントの最新1件の確定結果
  （ranking_snapshots.triggered_at降順）とその明細（rankingTypeで絞り込み）を返す。
  一度も確定操作が行われていない場合は snapshotId: null, triggeredAt: null, entries: [] を
  返す（画面側で「まだ順位が確定していません」等の待機表示に使う）。
  rankingTypeが user/target 以外は400 INVALID_RANKING_TYPE。存在しないイベントは
  404 EVENT_NOT_FOUND。

  成功時 200:
  { "snapshotId": "...", "triggeredAt": "...",
    "entries": [{ "rank", "displayName", "cheerValue" }, ...] }

⚠️ POST（確定操作）とGET（閲覧）でレスポンスのキー命名規則が異なる
   （POSTはsnake_case: entity_id/display_name/cheer_value、GETはcamelCase:
   displayName/cheerValue）。実装時の別々の判断によるもので意図した統一設計ではないが、
   Phase 4（9.11章）実装時点でフロントエンド側はこの違いをそのまま前提に実装している。

認証：POST（`/api/v1/admin/`配下）はnginx側IP制限の対象、GET（`/api/v1/events/`直下）は
対象外（event-battlesスコアAPI・target-scores APIと同じ理由。会場スクリーンを任意の端末で
表示する必要があるため意図的にIP制限の外に置く）。
```

**動作確認（2026-09-24、staging DBに接続したローカルサーバーで実施）**：POSTの正常系
（finished/paused双方での確定成功、同率1位→3位へ順位が飛ぶ同順位判定）、400
INVALID_EVENT_STATUS（scheduledのイベントに対するPOST）、GETの正常系（確定済み結果の取得、
未確定時のsnapshotId: null）を確認した。確認用に作成したテストイベント・ユーザー・
cheer_logs・ranking_snapshotsはすべて削除・非表示化して原状回復した（詳細は
`docs/worklog.md` 2026-09-24エントリ参照）。**staging・本番とも、Phase 1〜3実装当時
（2026-09-23）にどのような検証が行われたかは、`/handover`未実行のため記録が残っておらず
不明。** 本番デプロイは未実施。

> **2026-09-24追記：上記「本番デプロイは未実施」を解消し、本番デプロイ完了。**
> migration 012を本番DBへ適用（`ranking_snapshots`・
> `ranking_snapshot_entries`実在・`schema_migrations`記録を確認）、`pm2 restart`で
> Phase 1〜3のバックエンドコードを反映した。読み取り専用の疎通確認として、既存
> `GET /admin/events`が引き続き200で応答すること（回帰無し）、新設
> `GET /events/:id/ranking-snapshots/latest`を実在の本番イベントに対して呼び、
> `https://api.cheerstick.com`経由でも`snapshotId: null`の未確定応答が200で
> 返ることを確認した。**POST（順位確定）は実際の本番イベントに対しては未実行**
> （実データへの書き込みを伴うため、9.11章のPhase 4本番デプロイ後、KMT様確認のうえ
> 実施する想定）。本番デプロイ手順の詳細（`git reset --hard`を用いた理由を含む）は
> `docs/worklog.md` 2026-09-24エントリ参照。

> **2026-09-24再追記：上記「POSTは未実行」も解消。** 同日11:56 JST、KMT様が
> `admin.cheerstick.com/ranking-control.html`から実際に「順位確定」を実行した
> （イベント「実機検証 20260917」、`triggered_by`＝KMT様オフィスIP）。結果は
> ユーザー別1位YOKA(13338)・2位あきら(3163)・3位あきら2(59)、選手別1位
> ヴィヴィくん(16560)。本番での実データ確定操作が正常に動作することを確認した
> （詳細は`docs/worklog.md` 2026-09-24「YOKA」調査エントリ・引継ぎ記録エントリ参照）。
>
> **設計判断の記録（Phase 1〜3実装時点の根拠、2026-09-24にコード・本番DBで裏取り）：**
> - 新規テーブル`ranking_snapshots`・`ranking_snapshot_entries`を新設し、既存の
>   `awards`・`cheer_summaries`（6.1章、いずれもtargetsからON DELETE CASCADEで
>   参照される未使用テーブル）は不採用とした。`awards`はアプリケーションコードから
>   一切参照されていないため機能拡張の土台として不適格、`cheer_summaries`は
>   `event_id`・`target_id`・`user_id`列がいずれも`NOT NULL`（本番DBで確認済み）で
>   あり、TOFU方式ゆえ`user_id`/`target_id`がNULLの`cheer_logs`行が存在しうる
>   現行データ構造と構造的に不整合であるため
> - 配信方式をHTTPポーリングに決定した理由：既存WebSocketサーバーは応援スティック
>   専用のセッション管理のみで「閲覧専用クライアント」という概念が存在しないため。
>   `broadcast()`・`sendToDevice()`（`src/websocket/index.js`）は削除せず、将来の
>   ユーザー向け配信機能（10章・11章参照）着手時に再利用できるよう温存した

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

### 9.3 管理画面：対抗戦ペア管理・一括操作（2チーム対抗応援合戦機能、2026-09-11実装・同日本番反映）

> 2026-09-11、本番反映済み。ただし対抗戦ペア管理部分は8.4章の権限問題（11.8章）が
> 解消するまで動作しない（一括開始/停止/終了は既存の`PATCH .../status`のみを使うため
> この権限問題の影響を受けない）。

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

> **2026-09-14追記（同日中の再修正）：一括「停止」を`live`の行のみに限定。**
> 上記の「`finished`の試合に対する一括「停止」は`actionButtonsFor()`が返す`paused`遷移として
> 実行される（意図した挙動）」という記述を、**事故防止のため撤回する。**「停止」という
> ラベルの意図（`live`中の試合を一時中断する操作）と、`actionButtonsFor()`ベースの判定による
> 実際の挙動（`finished`の試合を`paused`へ復活させてしまう）がずれていることが指摘されたため。
>
> - 一括「停止」（`nextStatus === 'paused'`）のみ`bulkChangeStatus()`内で特別扱いし、
>   `actionButtonsFor()`の戻り値には頼らず**現在の状態が`live`の行にのみ**適用するよう変更した
> - `live`以外（`scheduled`／`paused`／`finished`／`cancelled`）の行は、遷移先が偶然一致するか
>   どうかに関わらずすべて対象外とし、「対象外（現在の状態「〈status〉」ではこの操作は
>   実行できません）」を表示してAPIを呼ばない
> - 一括「開始」（`live`）・一括「終了」（`finished`）は、直前の追記で導入した
>   `actionButtonsFor()`ベースの判定のまま変更していない
> - 個別ボタンの「終了を取り消す」（`finished`→`paused`）は単発ボタンでのみ実行可能なまま
>   変わらない。一括操作からは今回の修正で除外された
> - 動作確認：`scheduled`・`live`×2・`finished`の4件を全選択し一括「停止」を実行 →
>   `live`の2件のみ`paused`へ正常遷移、`scheduled`・`finished`の2件は「対象外」として
>   スキップされ選択が残ることを確認（`finished`が復活しないことを確認できた）。
>   詳細は`docs/worklog.md`同日エントリ参照

新設カード「対抗戦ペア登録」「対抗戦ペア一覧」を試合一覧の直後に追加：

- 登録フォーム：既存の試合一覧から試合A・試合Bをプルダウンで選択し、任意のラベルを付けて
  `POST /admin/event-battles`を呼ぶ
- 一覧：登録済みペアを表示し、各行にスクリーン表示用URL
  （`<APP_BASE>/battle.html?battle_id=<id>`）をテキスト入力＋「コピー」ボタンで提供。
  `APP_BASE`はadmin.cheerstick.comとは別オリジンのapp.cheerstick.comを本番用に想定
  （`public/index.html`が配信される先と同じ想定。9.1章参照）
- 削除ボタンあり（`DELETE /admin/event-battles/:id`、物理削除。元の試合自体は削除されない）。
  開始/終了ボタンとの連動は無い（ペアの登録・削除と試合の進行管理は独立）

### 9.4 対抗戦スクリーン表示ページ `public/battle.html`（2チーム対抗応援合戦機能、2026-09-11新設・同日本番反映）

> 2026-09-11、`/var/www/cheerstick-app/battle.html`として本番配置済み
> （`https://app.cheerstick.com/battle.html`で200応答を確認済み）。ただし表示内容の
> スコアAPI自体は8.4章の権限問題（11.8章）が解消するまで正常応答しない。

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

> **2026-09-25追記（対抗戦テーマ画像・綱引きゲージ機能）：** 2点変更した（8.4章参照）。
>
> 1. **テーマ画像表示**：スコアAPIの`theme_image_url`が設定されている場合、ヘッダーに
>    その画像をそのまま表示し（`<img id="themeImage">`、`max-height: 26vh`で高さ上限を
>    設けている。1x1のテスト画像で確認した際、上限が無いと画像が画面の大半を占めて
>    レイアウトが崩れる不具合を検証中に発見し、修正した）、個別のチームロゴ・チーム名
>    （`nameA`/`nameB`・`logoWrapA`/`logoWrapB`）を非表示にする。`event_title`（試合名）は
>    従来通り表示する（チーム名・ロゴとは別要素と判断したため、指示書に明記の無い判断）。
>    未設定時は従来通り個別ロゴ・チーム名を表示する（後方互換）
> 2. **ゲージの綱引き化**：従来の「両者のうち大きい方を100%とする独立2本バー」から、
>    「自チーム比率 = 自チームの応援量 / (両チームの応援量合計)」による1本の連結バーへ
>    変更した。両チームとも0の場合は50:50固定（ゼロ除算回避）。バー内に数値は表示せず、
>    各チームの下の数値ラベルを「応援強度」から「pt」表記に変更した（数値自体の
>    計算ロジックは変更なし）
>
> **管理画面側（`public/admin/events.html`）**：試合編集モーダルに「対抗戦テーマ画像」欄を
> 追加した。masters.htmlのチームロゴアップロードと同じ共通ウィジェット
> （`common.js`の`setupImageUploadWidget()`、9.9章参照）を流用し、新規UIは作っていない。
> 保存時は`theme_image_url`として8.4章のPATCH APIへ送る。
>
> staging DB（SSHトンネル経由のローカルサーバー）+ claude-in-chromeでのブラウザ確認で、
> テーマ画像の表示/非表示切り替え・フォールバック・綱引きゲージの比率表示（0:0および
> 750:250）・pt表記を確認した。確認用データ（試合2件・対抗戦ペア1件）はすべて削除・
> 非表示化して原状回復済み。

> **2026-09-26追記（レイアウト調整）：** KMT様指示書に基づき、表示レイアウトを
> 変更した（コミット`cb03903`、`docs/worklog.md`同日エントリ参照。8.4章のAPI・
> 綱引き比率計算ロジック自体は無変更）。
>
> - テーマ画像・個別ロゴをより大きく表示（画像`max-height: 26vh→46vh`、
>   ロゴ`clamp(48px,8vw,96px)→clamp(56px,11vw,128px)`）
> - 表示順を「画像→ゲージ→数値カウンター」に変更（従来は画像→カウンター→ゲージ）
> - ゲージを太く・全幅化（`height 20px→40px`、`max-width: 560px`制約を撤廃）
> - ゲージ配色を、カウンター背景（チームカラー28%ミックス）と旧ゲージ色
>   （チームカラー100%）の中間である**75%ミックス**へ変更
>   （`color-mix(in srgb, var(--team-a/b-color) 75%, #0b0f14)`。45%/60%/75%の
>   3候補をKMT様に提示し、75%案の承認を得た上で実装）
> - カウンターパネルの`padding`・`border-radius`を縮小し、背景の占有面積を削減
>   （数値表示自体の文字サイズは維持）
>
> **確認状況（重要・未完了）：** このセッションではstaging DBへのSSHトンネルを
> 確立する手段が無かったため、リポジトリ非追跡の一時モックページによる見た目確認に
> 留まっている。**staging実データ（EMUTTO vs J SPORTSデモデータ・通常の個別ロゴ表示
> ケース双方）での確認、およびスマートフォン・タブレット幅での崩れ確認は未実施のまま
> 次回に持ち越し。** 本番デプロイは、上記確認とKMT様への全体スクリーンショット提示・
> 最終承認を経てから行うこと（`docs/worklog.md`2026-09-26エントリの「次回への申し送り」
> 参照）。

> **2026-09-26追記（続き・staging実データ確認〜本番デプロイ完了）：** 上記「確認状況」は
> 解消した。KMT様がSSHトンネルを確立し、staging実データでの確認（EMUTTO vs J SPORTSは
> 実際には本番の恒久デモデータであり、staging側には無いことが判明したため、本番の公開
> スコアAPIへの読み取り専用GETと、staging上の一時テストデータの2方式に分けて実施）を
> 完了した。あわせてKMT様の追加要望により、ゲージの太さを**`height: 40px→56px`、
> `border-radius: 14px→18px`**へさらに拡大（コミット`55eff67`）。デスクトップ幅の
> スクリーンショットでKMT様の最終承認を得たうえで、`git push`・本番EC2への
> `git pull`・`public/battle.html`の`/var/www/cheerstick-app/`への配置・`diff`確認を実施し、
> 本番URLでの反映を確認した（`pm2 restart`は今回の変更が静的ファイルのみのため意図的に
> 省略。詳細は`docs/worklog.md`2026-09-26「続き」エントリ参照）。
>
> **スマートフォン幅でのゲージ位置崩れの指摘（KMT様からの別指示書）は、この時点では
> 未対応・別タスクとして先送りとした。** コード調査時点で`@media`・`order`・`flex-wrap`等
> 画面幅に応じてDOM順序を変える仕組みは見当たらず、本番デプロイ未実施の状態での実機確認
> だった可能性がある。デプロイ完了後、改めて実機確認を行うことが必要（次回への申し送り）。

> **2026-09-26追記（解消確認）：** 上記のスマートフォン幅懸念は、本番デプロイ完了後に
> KMT様が改めてスマートフォンで確認した結果、デスクトップと同じ「画像→ゲージ→
> カウンター」の順序で正しく表示されることを確認し、**問題は実在しなかったことが
> 確定した。** 原因は、確認時点でコード変更がまだpush・本番デプロイされておらず、
> 本番`battle.html`が旧コード（画面幅に関わらず「画像→カウンター→ゲージ」の
> 単一順序）のままだったことによる、デプロイ前後の状態の混同だった。コード自体に
> 画面幅依存の順序切り替え機構は存在せず、追加の修正は不要（詳細は`docs/worklog.md`
> 2026-09-26「セッション終了記録」エントリ参照）。

> **2026-09-28追記（ゲージ「直近の勢い」表示・ポーリング間隔指定、ローカル確認まで）：**
> KMT様要望に基づき、`battle_id`以外に4つのURLパラメータを追加した。**パラメータを
> 一切付けない場合の表示・挙動は変更していない**（既存の対抗戦画面・恒久デモURLに影響なし）。
>
> | パラメータ | 既定 | 内容 |
> |---|---|---|
> | `gauge` | 無し（従来の累計比率方式） | `recent`のときだけ、直近の勢いでゲージを描く（下記） |
> | `window` | 15 | `gauge=recent`時の直近の長さ（秒）。5〜120にclamp |
> | `amp` | 3 | `gauge=recent`時の勢いの増幅係数。1〜10にclamp |
> | `poll` | 3000 | ポーリング間隔（ミリ秒）。1000〜10000にclamp。`gauge`と独立して効く |
>
> 数値でない値は既定値に戻り、数値だが範囲外の値は範囲内にclampされる（例：
> `window=500`→120）。
>
> **`gauge=recent`の計算：** ポーリングのたびに`{時刻, team_a, team_b}`の累計値を履歴へ
> 追加し、`window`秒より古い履歴を破棄する（窓の開始点をまたぐ直前の1件のみ補間用に残す）。
> 直近`window`秒間の増分比率（`shareA = dA/(dA+dB)`）に`amp`を掛けてリーダー側の
> ゲージ位置（50〜100%にclamp）を求める。**設計上の判断：** 指示書の手順どおりだと
> 「増分が小さすぎる場合はゲージ位置を保持する」処理と「リーダー判定」が同時に更新される
> ため、ごく僅かな差でリーダーが入れ替わった直後にゲージが古いリーダー側を示す
> （不変条件「ゲージの優劣とptの多寡が食い違わない」に反しうる）瞬間が理論上あり得た。
> これを避けるため、**リーダー自体は常にその時点の生の累計値（`team_a`/`team_b`）から
> 判定**し、「保持」の対象はリーダー側への押し込み幅（0〜0.5）のみとする設計に変更した
> （同点が続く間のみ直前のリーダーを保持。詳細は`public/battle.html`スクリプト内の
> `updateGaugeRecent()`のコメント参照）。ローカル確認（模擬スコアAPI、20サンプルの
> 自動チェック）で、リーダー側のゲージが常に50%以上・pt優勢側と一致することを確認済み。
>
> **429時の表示：** スコアAPIが429を返した場合、`Retry-After`ヘッダーがあればその秒数
> （上限60秒）だけ待ってから次のポーリングを再開し、画面隅に「更新待機中（アクセス制限）」
> と表示する（最後に表示した値は保持する）。それ以外の非200応答・通信失敗は、従来どおり
> 「サーバーに接続できません。再試行しています…」を表示し、通常間隔でポーリングを続ける
> （いずれも既存の`showConnError`の仕組みをそのまま使用）。
>
> **ポーリングの重なり：** 実装は元々`setTimeout`連鎖方式（前回の応答/失敗が完了してから
> 次回を`setTimeout`で予約）であり、`poll=1000`等の短い間隔でも、応答が遅い場合に
> リクエストが重なることはない（応答時間＋poll間隔が実際の周期になる）。

> **2026-09-28追記（`gauge=recent`の調整・「常に動く仕組み」・更新停止の検知、ローカル確認
> まで）：** 2026-09-28 18:25〜18:28実施の100 vs 100テストでのKMT様の感想（「数秒間、
> カウンター・バーグラフとも動かないと感じた」「リード交代時のゲージの動きが速すぎる」
> 「勢いが付くと反対側まで振り切ってしまう」「常に動く仕組みが欲しい」）を受けた追加調整。
> **`gauge=recent`のときだけ有効で、パラメータ無し・`gauge=recent`無しの表示は変更していない。**
>
> | パラメータ | 既定 | 内容 |
> |---|---|---|
> | `range` | 20（%、0〜45にclamp） | 押し込まれない範囲。各チームのゲージ幅を最低`range`%確保する（負けている側も`range`%は必ず残る）。既存の不変条件「リーダー側は常に50%以上」と両立させ、結果としてリーダー側は`[50%, 100-range%]`に収まる。`range=0`なら従来の動き（50〜100%）に近い |
>
> **常に動く仕組み（`gauge=recent`のときだけ）：**
> - **カウンターの連続表示：** ポーリングの応答を待たず、`requestAnimationFrame`で
>   数字を常に増やし続ける（表示値は**DBの値そのものではなく推定値**であることに注意）。
>   直近15秒（固定、`window`パラメータとは独立）の差分からpt/秒の速度を求め、最後の実測値から
>   その速度で外挿する。外挿は最後の実測から最大4秒までとし、それを超えたら頭打ちにする。
>   新しい実測が届くと、そこへ基準点を更新するが、**表示している数字は減らさない**
>   （外挿が実測を上回っていた場合は、実測が追いつくまで表示を保持する）
> - **ゲージのなめらかな追従：** 目標位置へ時定数0.5秒（`GAUGE_SMOOTHING_TAU_SEC`、
>   フレームレートに依存しない指数減衰方式）で追従させ、リード交代時の急な動きを和らげる
> - **呼吸の揺れ：** ゲージに常に振幅±1.5ポイント・周期約3秒の小さな揺れを加える。
>   揺れを加えた後、リーダー側が50%未満にならず`range`%の範囲を超えないよう最後にclampする
>
> **設計上の判断（重要）：** 上記の「常に動く仕組み」導入により、画面に表示する pt の数字が
> DBの生の値ではなく**推定値**になったため、既存の不変条件「ゲージが優勢な側と、ptの多い側が
> 食い違うことは無い」の基準も、生の累計値ではなく**その瞬間に画面へ表示している推定pt**に
> 揃える必要があることが、ローカルでの決定的シミュレーション確認（後述）で判明した。カウンターの
> 推定（pt/秒の線形外挿）とゲージの「直近の勢い」計算（ポーリング時点でのwindow秒間シェア）は
> 別々の推定方式であるため、ポーリングの間（次のポーリングが届くまでの間）に、推定表示上の
> リーダーが入れ替わる瞬間がありうる。ゲージの「どちらのチーム側に表示するか（符号）」を
> ポーリング時点のリーダーに固定したままだと、その瞬間だけ不変条件に反しうるため、**符号は
> 毎フレーム、その時点で画面に表示している推定pt（カウンターの表示値）を比較して決める**
> 設計に変更した。押し込み幅（リーダー側への0〜0.5-range%の量）自体は、従来どおりポーリング
> 時点の計算結果へなめらかに追従させる。この結果、**大きな押し込みの最中に僅差でリードが
> 入れ替わった場合、その瞬間にゲージの見た目が大きく切り替わる（跳ぶ）ことがある**（常に
> 不変条件を満たすことを優先した結果によるトレードオフ。詳細は`public/battle.html`スクリプト内
> `gaugeAnimState`のコメント参照）。
>
> **更新停止の検知・診断：**
> - スコアAPIの`fetch`に8秒のタイムアウト（`AbortController`）を追加した。**追加前は、
>   応答が返らないまま止まった場合に`setTimeout`連鎖自体が止まる可能性があった**
>   （`await fetch()`が解決しないと、次回ポーリングを予約する`finally`ブロックに到達しない
>   ため）。KMT様が体験した「数秒間動かなかった」の直接の原因とは断定できていないが
>   （本番ログの調査では、取得の停止・データの欠落は確認できなかった。下記参照）、
>   潜在的なリスクとして修正した
> - `gauge=recent`のときだけ、最後の成功取得から4秒以上経ったら「最終更新」欄の下に
>   控えめに「接続確認中…」を表示し、回復したら消す
> - fetchに`cache: 'no-store'`を指定した。Express側は`etag`を無効化していないため、
>   ブラウザが条件付きGET（`If-None-Match`）で304を受け取り、実際には更新されていない
>   古いレスポンス本体をそのまま描画に使ってしまう可能性があった（調査のみで再現はしていない。
>   クライアント側の対処のみ実施。サーバー側で`Cache-Control: no-store`を付ける対応は
>   **提案のみ**で、`src/`は変更していない）
> - 診断用に`window.__battleDebug`を追加した（画面には出さない）。
>   `{lastOkAt, maxGapMs, gapsOver3s, requestCount, failureCount, timeoutCount,
>   renderErrorCount, lastRenderError, lastChangedAt, unchangedSpans}`を保持し、
>   `gauge=recent`に限らず常時収集する
> - `render()`の先頭で、`total_intensity`が有限の数値であることを検証し、不正な場合は
>   DOM更新を一切行う前に例外を投げるようにした（NaN等が表示に混入することを防ぐ）。
>   `poll()`側でこの例外を捕捉し、直前の表示を保持したまま次のポーリングへ続ける
>   （`renderErrorCount`・`lastRenderError`に記録）。`tickRecent()`（毎フレームの描画）側も
>   同様にtry/catchで囲み、1フレームの例外でアニメーション全体が止まらないようにした
>
> **本番ログ調査（KMT様の「数秒間動かなかった」体験の原因調査）：** 該当時間帯（UTC
> 9:25〜9:28）の本番ログでは、KMT様のブラウザからのスコア取得229件に3秒以上の空きは
> 無く、`cheer_logs`にも9:27:00〜9:28:11（UTC）の全ての秒で応援が記録されていた。
> 取得の停止・データの欠落は原因ではないと考えられる。体験時刻はデモ終盤30秒
> （接戦演出で両チームの強さがそろい、直近の勢いが五分五分でゲージが中央から動かなく
> なる設計）と重なっており、ゲージが動かなく見えた理由はこれで説明できるが、
> **カウンター（数字）まで止まって見えた理由は本調査では確定できていない**（KMT様の
> 記憶では「最終更新」時刻は進んでいたとのことで、描画側の停止の可能性を含め、上記の
> 診断機能（`window.__battleDebug`）で次回のテストで確認する）。
>
> **ローカル確認（決定的シミュレーション・claude-in-chrome・pg-mem、いずれもリポジトリ
> 非コミット）：**
> - `range`のclamp・呼吸の揺れを加えた後の不変条件（リーダー側が常に50%以上、負けている側は
>   常に`range`%以上を確保、ゲージと「表示中の推定pt」の優勢側が食い違わない）を、
>   `range=20/0/45`それぞれについて、実際の`tickRecent()`・`updateGaugeRecent()`・
>   `updateCounterRate()`と同一のロジックをNode.jsで抽出し、200秒分・4,000フレームの
>   決定的シミュレーションで確認した（乱数を使う場面もシードは固定していないが、複数回実行して
>   違反0件を確認）。**claude-in-chromeの自動化タブは`document.hidden=true`のまま
>   固定され`requestAnimationFrame`が発火しない制約があったため**、実ブラウザでの
>   連続アニメーションの目視確認はスクリーンショット越しの限定的な確認にとどめ、
>   数式部分の正しさはこの決定的シミュレーションで担保した
> - ブラウザでの確認（回帰・429・タイムアウト・不正データ・接続確認中の表示・
>   `window.__battleDebug`の値）は、スクラッチ領域の模擬スコアAPIサーバーと
>   claude-in-chromeで実施し、いずれも想定どおりの挙動を確認した
> - 既存の`scripts/demo/local-verify.js`（27項目）・`scripts/rate-limit/local-verify.js`
>   （26チェック）とも引き続き全PASS（回帰無し）

> **2026-09-29追記（`gauge=recent`の調整・揺れの停止・累計差によるrangeの中央寄せ、
> ローカル確認まで）：** 100 vs 100の再テストでゲージの動きが大きく改善したことを受け、
> KMT様から追加で2点の調整依頼があった。**本番EC2・WebARENAへの反映は今回行っていない。**
> 詳細な経緯・KMT様の感想は`docs/worklog.md`本日エントリ参照。
>
> **1. 揺れの停止：** 従来、2-(c)の「呼吸の揺れ」は、直近の応援の有無に関わらず常に
> 加わっていた（試合終了後、応援が完全に止まった後も揺れ続ける不具合）。
> `updateGaugeRecent()`内の既存の「保持」判定（直近`window`秒間の`dA+dB`が1未満で
> `lastMagnitude`を更新せず保持する条件）に`holding`フラグを追加し、`tickRecent()`側で
> `holding`中は揺れ（`wobblePoints`）を0にする（＝加えない）よう変更した。開始前
> （まだ応援が無い状態）でゲージが多少動くこと自体は問題ないとKMT様に確認済みのため、
> 初回ポーリング前の`holding=true`初期値はそのままにしている（区別する実装はしていない）。
>
> **2. 累計差によるrangeの中央寄せ：** 新パラメータ`narrowThresholdPct`（既定3、0〜100に
> clamp）・`narrowRangePct`（既定10、0〜50にclamp）を追加した。累計の差
> （`|a-b|/(a+b)`、window秒内の増分ではなく試合全体の累計値で判定）が
> `narrowThresholdPct`%未満のとき、実際に使うrange（%）を、既定の`range`の代わりに
> `(50-narrowRangePct)`から`range`へ向けて線形に補間した値にする（差0%のとき
> 最も狭く、差`narrowThresholdPct`%で既定の`range`に達する）。差が
> `narrowThresholdPct`%以上になれば、常に通常どおり`range`をそのまま使う。
>
> **設計上の判断（指示書の記述との不一致・要確認）：** 指示書には「累計差3%未満の
> ときは40%〜60%の範囲に制限する（range=20の代わりに、実質range=10相当にする）」との
> 記述があった。しかし既存の`range`パラメータの定義（負けている側の下限を`range`%
> 確保する＝`range`が大きいほど中央寄りになる）にそのまま当てはめると、
> `range=10相当`は`range=20`（既定）より下限が浅く、**むしろ範囲が広がる**
> （中央寄りに制限するという目的と矛盾する）。指示書中の具体的な数値例
> （40%〜60%）を正として採用し、`narrowRangePct`は「中央（50%）からの半width」
> （`narrowRangePct=10` → 40%〜60%の意味）と解釈して実装した。この解釈の
> 妥当性はKMT様への報告・確認が必要（`docs/worklog.md`本日エントリ参照）。
>
> **ローカル確認（決定的シミュレーション、Node.js、リポジトリ非コミット）：**
> - 累計差0%/3%/5%/10%における実際のrange：0%→40%（窓40%〜60%）、3%→20%
>   （窓20%〜80%、既定rangeに到達）、5%・10%→20%（既定rangeのまま、閾値以上は
>   常に既定を使う設計どおり）。0%〜3%の間（例:1.5%）は30%（40%と20%の中間）と
>   なり、なめらかに補間されることを確認した
> - 応援が完全に停止した状態を模擬し、`holding=true`になること、揺れ
>   （`wobblePoints`）が常に0になること、収束後のゲージ位置がフレームを跨いで
>   ほぼ一定（変動`<0.0001`）に固定されることを確認した
> - 既存の不変条件（リーダー側は常に50%以上、負けている側も
>   `effectiveRangeFraction`%以上を確保、ゲージの優劣と表示中の推定ptの優劣が
>   食い違わない）が、`range=20/0/45`いずれでも200ポーリング分の疑似応援パターンで
>   崩れていないことを確認した
> - `range=0`を明示指定し、累計差が十分大きい（従来どおりの）シナリオでは、
>   `effectiveRangeFraction=0`のまま（narrow機能が介入しない）ことを確認した
>   （回帰確認）
> - 既存の`scripts/demo/local-verify.js`（27項目）・`scripts/rate-limit/local-verify.js`
>   （26チェック）とも引き続き全PASS（回帰無し）
> - パラメータ無し（`gauge=recent`自体を指定しない累計比率ゲージ）の経路は今回
>   コード変更していないため、動作は従来通り

> **2026-09-29追記（揺れ・位置の固定タイミングをカウンターの増減にそろえる、ローカル確認まで）：**
> 本番相当の管理画面（デモモード機能）から実際に100 vs 100のデモを実行したKMT様の
> 実機確認で、「応援が止まった直後、カウンター（表示中の推定pt）はそのまま増加を
> 止めて表示され続けたが、ゲージは5秒ほどの間、片方の色へ振れて、その後中央へ戻って
> 止まった」という現象が確認された。原因は、9-28調整時点の「揺れを止める・保持する
> （holding）」判定が、直近`window`秒（既定15秒）の応援量差分（`total`）のみを見ており、
> 応援停止直後もこの履歴に停止直前の偏りがしばらく残るため、`total>=1`の間は
> `holding=false`のままとなり、`lastMagnitude`（ゲージの押し込み幅）が、履歴が
> window秒かけて徐々に抜けていく間、ゲージだけ遅れて動き続けていたため。
>
> **対応：** holding判定に、カウンター（表示中の推定pt合計）の短期停滞検知を
> 追加した（`counterStallState`、新規）。直近`COUNTER_STALL_WINDOW_MS`（500ms）間の
> 表示合計の増分が`COUNTER_STALL_EPSILON_POINTS`（1pt）未満なら「増えていない」
> （`stalled`）とみなし、この判定を**毎フレーム**（`tickRecent()`側）更新する。
> 既存の`window`秒ベースの判定はそのまま残し（不変条件・回帰リスクの観点から
> 既存ロジックへの影響を最小にするため）、**どちらか一方でも成立すれば`holding`とする**
> （OR条件）方式を採用した。理由：`window`秒ベースの判定を置き換える案も検討したが、
> 置き換えるとフレーム単位（16ms）の丸め誤差で応援中にも揺れが明滅しかねないため、
> 応答性の高い新判定を「追加条件」として重ねる方式の方が、既存の応援中の挙動
> （常に動く仕組み・不変条件）への影響が少なく安全と判断した。
> `wobblePoints`のゲート（`tickRecent()`）は`gaugeRecentState.holding`
> （ポーリングごとにのみ更新）と`counterStallState.stalled`（毎フレーム更新）の
> ORとし、揺れは停滞検知と同じフレームで即座に止まる。`lastMagnitude`自体の更新
> （`updateGaugeRecent()`）も同じ`stalled`フラグを参照するため、次のポーリング
> （`poll`パラメータ次第、KMT様の実演では1秒）以内に、ドリフト（位置のさらなる変化）
> も止まる。
>
> **ローカル確認（決定的シミュレーション、Node.js、リポジトリ非コミット）：**
> - 応援が継続中（一定レートで20秒間）→完全停止、を模擬し、停止後に`stalled`が
>   `true`になったのと**同一フレーム**で`wobblePoints`が0になること（ズレ0ms）を確認した
> - `stalled`化した時点の`lastMagnitude`と、そこからさらにwindow秒（15秒）が
>   完全に経過した後の`lastMagnitude`を比較し、**変化していない**こと（＝
>   「数秒間振れて中央へ戻る」ドリフトが発生しないこと）を確認した
> - 検知までの時間は、模擬した応援レート（20pt/秒〜実演相当の2000pt/秒）に依らず
>   おおむね3.6秒程度だった（従来のwindow秒＝最大15秒からは大幅に短縮。**厳密な
>   1秒以内ではない**点は要留意。カウンター自体の推定表示が、直前のレートに応じて
>   数秒かけて減衰する既存設計＝2-(a)の仕組み自体は今回変更していないため。
>   詳細は`docs/worklog.md`本日エントリ参照）
> - 応援が緩やかにでも継続していれば`stalled`にならないこと（揺れが従来どおり
>   続くこと）を確認し、応援中の挙動に回帰が無いことを確認した
> - 既存の不変条件（リーダー側は常に50%以上、負けている側もrange%以上を確保、
>   ゲージの優劣と表示中の推定ptの優劣が食い違わない）が、`range=20/0/45`いずれでも
>   崩れていないことを確認した
> - 既存の`scripts/demo/local-verify.js`（27項目）・`scripts/rate-limit/local-verify.js`
>   （26チェック）・`scripts/demo/local-verify-demo-mode.js`（29項目）とも
>   引き続き全PASS（回帰無し）

> **2026-10-01追記（`gauge=recent`のゲージ縦幅2倍・グラデーション適用、ローカル確認まで）：**
> `gauge=recent`のとき、ゲージの縦幅を2倍（56px→112px）にし、バー色のグラデーション
> （外側が濃く、拮抗点側が薄い赤／青）を`fx=spark`の有無によらず適用する。**`gauge=recent`が付かない
> 従来の画面は変更していない**（旧版と画素一致を確認済み）。**これは実機の本番イベントで使われる
> 画面（`gauge=recent`付きの対抗戦ペアURL）にも影響する**（KMT様確認済み）。詳細は9.13章末尾の追記を参照。

### 9.5 管理画面のランチャー方式への再構成（3ページ分割、2026-09-13実装・ローカル確認のみ・本番未反映）

> **2026-09-13追記：ローカル・開発環境での動作確認まで完了。本番デプロイは未実施
> （KMT様指示により今回は対象外）。** `public/admin/index.html`1ファイル（旧構成）に
> 同居していた試合管理・対抗戦・チーム管理・デバイス管理の全機能を、以下の理由で
> ランチャー＋機能別ページの構成へ再編した。
>
> - 背景：8.0・8.1・8.2・8.3・8.4・9.3節に記載の機能が積み上がり、`public/admin/index.html`が
>   1,468行の単一ファイルになっていた（新規機能追加のたびにこのファイルへの追記が続いていた）。
> - 上記8.0・8.1・8.2・8.3・8.4・9.3節で「管理画面（`public/admin/index.html`）」として
>   説明している機能自体（試合の状態遷移、一括操作、チーム管理API、対抗戦ペア管理API等）は
>   **本再構成による変更は無い**（バックエンドAPI・DBスキーマは一切変更していない）。
>   これらの節の記述は削除しない（そのまま機能説明として有効）。以下は「その機能を
>   今どのファイルで参照できるか」の対応表としてのみ利用すること。

**新しいファイル構成（`public/admin/`配下）：**

```
index.html      … ランチャー（新設）。記録状態バナー（旧(A)相当、独自にGET /eventsを取得）と、
                   events.html・masters.htmlへのリンクカードのみ
events.html     … 旧(A)記録状態バナー＋(C)試合登録＋(B)試合一覧・一括操作＋(D)編集モーダル
                   ＋(G)対抗戦ペア登録・一覧（8.0・8.1・8.2・8.4・9.3節の機能はここに存在する）
masters.html    … 旧(F)チーム管理＋(E)デバイス管理（8.3節の機能はここに存在する）
common.css      … 全ページ共通スタイル（変数・card/table/button/badge/modal/error-bar・
                   記録状態バナー・チェックボックス列等）を新規切り出し
common.js       … 全ページ共通JS（API_BASE/APP_BASE、apiFetch、escapeHtml、
                   showError/clearError、日時変換ヘルパー）を新規切り出し
```

- events.html・masters.htmlは、旧`index.html`の該当セクションをほぼそのまま移設したのみで、
  依存関係の組み替えは無い。対抗戦ペア登録フォーム（G）は試合一覧（B）と同じevents.html内に
  留めており、`populateBattleEventSelects(events)`の呼び出し方も変更していない（この2機能は
  同一ページ内で試合一覧データを共有しているため、分割コストが最小になる構成として選定した）
- チーム管理（F、masters.html）の新規登録・編集フォームが、旧構成では同一ページ内の
  試合登録フォーム（C、events.html側へ移動）のチームプルダウンを更新する処理
  （`await loadOrganizations();`）を呼んでいたが、ページが分かれたことで意味が無くなったため
  削除した。events.html側は自身のページ読み込み時に毎回`/organizations`を取得するため、
  次にevents.htmlを開いた時点で新規チームが反映される（機能的な後退ではなく、ページ遷移
  前提のMPA構成にした結果、明示的な相互更新が不要になったもの）
- ランチャー（index.html）の記録状態バナーは、events.htmlの一覧取得（`refreshAll()`）とは
  別に、ランチャー自身が独自に`GET /events`を取得して描画する（ページを跨いだ状態共有の
  仕組みは導入していない。素朴なMPA構成のため、各ページが必要なデータをその都度取得する
  方針で統一した）

**nginx側の確認結果（2026-09-13、本番の実ファイルを読み取り専用で確認済み）：**

`admin.cheerstick.com`のnginx設定（`/etc/nginx/sites-available/cheerstick-admin`）は
`location /`が1本のみで、その内側に`allow 49.156.217.121; deny all;`と
`try_files $uri $uri/ =404;`が書かれている（runbook.md「管理画面 admin.cheerstick.com」節
参照）。他に優先される`location`は存在しないため、`/var/www/cheerstick-admin/`配下に
新規ファイル（events.html・masters.html・common.css・common.js）を追加するだけで、
追加のnginx設定なしに同じIP制限が適用される。ただし今回はローカル確認のみで本番デプロイ
前のため、実際の反映後に改めて許可IP外からの404/403応答を確認することが望ましい。

**ローカル動作確認（2026-09-13、静的ファイルサーバーによる確認。バックエンドAPI・DB接続は
無し）：**

- 3ページ（index.html・events.html・masters.html）とも表示崩れ無く描画され、
  `common.css`・`common.js`の読み込み（200応答）を確認
- ブラウザコンソールにJSエラー・例外なし（3ページとも）
- ランチャーの2リンクカードからそれぞれevents.html・masters.htmlへ、各ページの
  「← 管理画面トップ」リンクからindex.htmlへの遷移を確認
- 実際のAPIレスポンス（試合一覧・チーム一覧・デバイス一覧の実データ表示、フォーム送信、
  一括操作等）を用いた確認は今回実施していない（ローカルの開発用DB接続
  （staging DBへのSSHトンネル）を今回のセッションで新規に確立することが権限上の制約で
  できなかったため）。**本番反映前に、staging DBに接続した状態での実データ確認
  （試合一覧・チーム一覧・デバイス一覧の表示、各フォームの送信、一括操作、対抗戦ペア登録）を
  別途実施する必要がある**

**追記（2026-09-13、同日中の小修正）：events.htmlでのチーム一覧の自動再取得。**
masters.htmlで新しいチームを登録した後、ブラウザの「戻る」でevents.htmlに戻っても
試合登録フォームのチームプルダウンが更新されない問題が判明した（ブラウザのbfcache
（ページキャッシュ）からevents.htmlが復元される際、スクリプトが再実行されず初回の
`loadOrganizations()`呼び出しが再度走らないため）。events.htmlに以下を追加して対処した。

```js
window.addEventListener('pageshow', () => {
  loadOrganizations();
});
```

`pageshow`イベントは通常の読み込み時に加えbfcache復元時にも発火するため、どちらの
経路でもチーム一覧（試合登録フォーム・編集モーダル双方のチームプルダウン）が最新化される。
新規API・設計変更は無く、既存の`loadOrganizations()`を再利用するのみ。

動作確認（ローカル、擬似APIサーバーによる確認）：events.html読み込み後にバックエンドへ
新規チームを追加し、（1）何もしなければプルダウンが2件のまま更新されないこと、
（2）`window.dispatchEvent(new Event('pageshow'))`（bfcache復元時にブラウザが実際に
発火させるものと同一のイベント）を発火させると、試合登録フォーム・編集モーダル
両方のチームプルダウンに新規チームが反映されることを確認した。バックエンドが無い状態
（静的配信のみ）で`pageshow`を発火させてもJSエラーが発生しないことも確認済み。

**追記（2026-09-13、staging DBでの実データ動作確認）：** KMT様がTeraTermでSSHトンネル
（`localhost:5433`→staging DB）を確立した状態で、`node src/index.js`をstaging DB接続で
起動し、3ページ（index.html・events.html・masters.html）を実データで確認した。

- **ランチャー（index.html）**：記録状態バナーが実データ（live試合の有無）で正しく表示されることを確認
- **events.html**：
  - 試合一覧（staging既存の「テスト試合1/2/4」3件）の表示、新規試合登録、編集
    （タイトル変更）、個別の状態変更（開始・停止・再開・終了・終了を取り消す）を
    実データで確認
  - 一括操作（開始・停止・終了）：対象外スキップ（例：一括「停止」でlive以外の行が
    「対象外（現在の状態「〜」ではこの操作は実行できません）」として選択を残したまま
    スキップされる）、部分成功（同一組織の`LIVE_EVENT_CONFLICT`によりエラー行表示が残る）
    とも仕様どおりに動作することを確認
  - 動作確認のために作成した試合は確認後に削除し、既存3件（テスト試合1/2/4）は
    確認前と同じ状態（それぞれpaused/finished/finished）に復元した
  - **対抗戦ペア登録・一覧・スコア表示は、11.9章の staging DB migration 011未適用により
    確認できなかった**（`event_battles`テーブルが存在しないため）
- **masters.html**：
  - チーム一覧（staging既存の「V・ファーレン長崎」1件）の表示、編集モーダルの
    値プリフィル、新規登録を実データで確認
  - デバイス一覧（staging既存の2件）の表示、単体登録、CSV取込（新規/重複/不正形式の
    判定を含む）、一括適用（選択した件への適用）を実データで確認
  - **チーム・デバイスともUI上に削除手段が無いため、動作確認のために新規登録した
    データ（チーム2件「【動作確認用】pageshow検証チーム」「〜チーム2」、デバイス2件
    「DE:AD:BE:EF:AD:01」「:02」）はstaging DBに残存している。** 既存フィクスチャとの
    混同を避けるため「【動作確認用】」プレフィックス・`DE:AD:BE:EF:`帯（runbook.md記載の
    デモ機と同じローカル管理アドレス帯）で判別可能にしてある。削除が必要な場合は
    KMT様判断のうえDB直接操作が必要（アプリ側に削除APIが無いため）
  - デバイス一括適用の操作を誤って選択範囲を広げすぎ、既存デバイス2件
    （`AA:BB:CC:DD:EE:98`/`99`）のデモ機フラグを一時的に変更してしまった。
    直後に同じ画面から個別に選択し直して元の状態（デモ機フラグ無し）に復元済み
- **pageshow修正の実データ確認**：本セッションでも、実際のブラウザ「戻る」操作は
  自動化環境の制約（後述）により実行できなかったため、events.html読み込み後に
  staging DBへ新規チームを追加→`pageshow`イベント発火、という前回と同じ方式で
  再検証した。実際のstaging DB・実サーバーの組み合わせでも、試合登録フォーム・
  編集モーダル双方のチームプルダウンが正しく最新化されることを確認した
- **自動化環境の制約**：この検証で使用したブラウザ自動化ツールでは、`navigate`ツールの
  back指定が一貫して「Cannot find a next page in history」エラーとなり、実際の
  ブラウザ「戻る」操作そのものでの確認はできなかった（前回セッションと同じ制約）。
  また、409エラー時に呼ばれる`alert()`・確認ダイアログの`confirm()`がネイティブダイアログ
  としてタブをフリーズさせ自動化コマンドが応答不能になる事象が発生したため、
  検証用に`window.alert`/`window.confirm`をページ側スクリプトで一時的に上書きして
  進めた（本番相当の`public/admin/`側コードは一切変更していない）

### 9.6 管理画面：選手・推し対象管理 `public/admin/targets.html`（2026-09-13新設・ローカル確認まで）

8.5章のAPIに対応する管理画面。`masters.html`（チーム管理・デバイス管理）と同じ構成
（新規登録フォーム＋一覧＋編集モーダル、`common.css`/`common.js`を読み込む）で追加した。

- 新規登録フォーム：名前（必須）・所属チーム（必須、ドロップダウン）・種別type
  （自由入力＋`<datalist>`によるオートコンプリート。初期候補は`player`/`mascot`/`team`/
  `artist`/`unit`、読み込んだ一覧に含まれる既存値も動的に追加）・背番号（任意）・
  画像URL（任意）・プロフィール文（任意、テキストエリア）・有効/無効（チェックボックス）
- 一覧：所属チームでの絞り込み、各行に編集・削除ボタン
- 削除：`confirm()`後にDELETEを呼ぶ。409 `TARGET_IN_USE`受信時は
  「「〈名前〉」は既にデバイスの推し選択または応援ログで使用されているため削除できません。」
  という具体的な文言をエラーバーに表示する（8.5章のガードに対応）
- ランチャー（`index.html`）に「選手・推し対象管理」のリンクカードを追加した

### 9.7 応援ランキング画面 `public/target-report.html`（2026-09-13新設・ローカル確認まで）

8.6章のAPIを表示する一般公開ページ。認証方針は`battle.html`と同じ
（`/api/v1/admin/`配下ではないためnginxのIP制限は適用されない。会場等の任意の端末で
表示する必要があるための意図的な設計）。

- タブ切り替えで「試合ごと」「全期間通算」の2表示モードを提供
  - 「試合ごと」：URLパラメータ`event_id`を読み取り、`GET /events/:id/target-scores`を
    3秒間隔でポーリング（`battle.html`と同じポーリング方式。一時的な通信断は直前の表示を
    保持したまま再試行バナーのみ表示し、`event_id`未指定・存在しないイベントは
    致命エラーとして専用メッセージを表示）
  - 「全期間通算」：ページ読み込み時に`GET /target-scores`を1回取得。手動更新ボタンあり
  - `event_id`パラメータの有無で初期表示タブを自動選択（有れば「試合ごと」、無ければ
    「全期間通算」）
- 表示項目：順位・対象の画像またはアバター（`battle.html`と同じ頭文字色分けフォールバック
  パターン）・名前・所属チーム名・応援量（`total_intensity`降順、サーバー側で整列済み）
- デプロイ時の配置先は`battle.html`と同じ`/var/www/cheerstick-app/`配下
  （runbook.md「デプロイ手順」の対象に本ページも追加が必要。本番反映時に注意）

### 9.8 管理画面：ジャンル管理UI（`masters.html`、改善3件フェーズ1、2026-09-16新設・ローカル確認まで）

8.7章のAPIに対応するUI。既存の「チーム管理」（9.5章、B-4）と同じ構成
（新規登録フォーム＋一覧＋編集モーダル）で、`masters.html`内チーム管理セクションの
直前に追加した。

- 新規登録フォーム：ジャンル名のみ（必須）
- 一覧：ジャンル名と編集ボタンのみ（削除機能は8.7章の方針により無し）
- ジャンルの新規登録・編集に成功すると、同一ページ内のチーム管理・デバイス管理の
  ジャンルプルダウン（`GET /categories`を参照している箇所）も自動的に再取得する
  （新規ジャンル追加直後にチーム登録フォームへ反映されるようにするため）
- チーム登録フォームのジャンルドロップダウン自体（`GET /categories`の呼び出し方）は
  変更していない

### 9.9 画像アップロードUI（`masters.html`・`targets.html`、改善3件フェーズ2、2026-09-16新設・ローカル確認まで）

8.8章のAPIに対応するUI。チームロゴ（`masters.html`）・選手/推し対象写真
（`targets.html`）の入力欄を、「URLをテキストで直接指定」方式から
「ドラッグ＆ドロップ／ファイル選択」方式へ置き換えた。

- 共通実装：`public/admin/common.js`に`setupImageUploadWidget()`を新設し、両ページで
  共通利用する。ドロップゾーン（クリックでファイル選択も可）・隠しファイル入力・
  アップロード状態表示・プレビュー画像・隠しURL入力（`type="hidden"`）の5要素一式で
  構成する
- **既存のcreate/update送信処理（organizations/targetsの各API呼び出し）は変更していない**：
  アップロード成功時にウィジェットが隠しURL入力（従来`orgCreateLogoUrl`等として
  テキスト入力欄だった要素をそのまま`type="hidden"`に変更して流用）へURLをセットする
  ことで、送信側コード（`.value`を読むだけ）に手を加えずに済む設計にした
- クライアント側で先に形式（jpg/png）・サイズ（5MB）をチェックしてからアップロードする
  （サーバー側の検証と二重になるが、明らかに対象外のファイルで無駄なリクエストを
  送らないためのUX目的。サーバー側の検証（8.8章のマジックバイト確認等）を置き換える
  ものではない）
- 編集モーダルを開く際は、既存のURL（`organizations.logo_url`／`targets.image_url`）を
  ウィジェットの`setUrl()`でプレビュー・隠しURL入力へ反映する
- 新規登録フォームは送信成功後、フォームリセットに合わせてウィジェットの表示（プレビュー・
  状態表示）もリセットする
- 初期・既定画像（`assets/images/`配下、git管理下でデプロイ時にコピーする従来方式）の
  運用フローは変更していない。本UIは今後の新規登録・差し替え時にのみ使う想定
  （両方式の共存についての論点整理は`docs/worklog.md`該当日エントリ参照）

**動作確認（2026-09-16、pg-mem疑似DBを使ったローカルサーバー＋ブラウザ自動操作で実施）**：
`masters.html`でファイル選択によるチームロゴアップロード→新規チーム登録→一覧反映→
編集モーダルでの既存ロゴプレビュー表示、`targets.html`で同様の画像アップロード→
新規選手登録→一覧反映を、実際のブラウザ操作で確認した。コンソールエラー無し。

### 9.10 管理画面：チームカラー設定UI（`masters.html`、2026-09-17新設・ローカル確認まで）

8.3章追記のAPI（`organizations.color`）に対応するUI。チーム新規登録フォーム・
編集モーダルの両方に「チームカラー」項目を追加した。

- `<input type="color">`のカラーピッカーと、隣にHEXコードのテキスト入力欄をセットで配置。
  `input`イベントで双方向に同期する（ピッカー変更→テキスト欄反映、テキスト欄への
  正しいHEX入力→ピッカー反映。テキスト欄が不正な値の間はピッカー側を更新しない）
- テキスト欄には`/^#[0-9A-Fa-f]{6}$/`によるクライアント側チェックを実装し、不正な間は
  エラーメッセージ表示＋登録・保存ボタンを`disabled`にする（8.3章のAPI側バリデーションと
  二重になるが、明らかに不正な値での無駄なリクエストを避けるUX目的。サーバー側検証を
  置き換えるものではない。9.9章の画像アップロードUIと同じ考え方）
- 新規登録フォームのデフォルト色は`#3B82F6`（既存organizationsレコードにHEX形式の
  デフォルト値を持つ列定義は無いため、指示書に例示された初期色をそのまま採用）
- 編集モーダルを開く際、既存の`color`が正しいHEX形式ならそのままピッカー・テキスト欄へ
  反映、未設定（NULL）や不正な形式ならデフォルト色にフォールバックする
- チーム一覧テーブルに「カラー」列を追加し、`organizations.color`を背景色とした
  小さい正方形のスウォッチ（`.color-swatch`）を表示する。値が無い・不正な場合は
  グレー（`#cccccc`）で表示する
- 併せて`common.css`に`button:disabled`のスタイル（半透明化・`cursor: not-allowed`）を
  新設した。従来`disabled`状態の見た目が通常時と区別できなかったため
  （本UI実装時に気づいたもので、他の`disabled`ボタン全般に影響する）

**動作確認（2026-09-17、pg-mem疑似DBを使ったローカルサーバー＋ブラウザ自動操作で実施）**：
バックエンドAPI（`POST`/`PATCH /admin/organizations`）に対し、不正な形式（`"blue"`等）で
400 `INVALID_COLOR_FORMAT`、正しいHEX形式で201/200、未指定・空文字で既存動作維持
（新規はNULL、更新時は元の値を保持）となることを確認した。ブラウザ操作では、
テキスト欄への正しいHEX入力でピッカーが追従すること、不正な値でエラー表示と
登録ボタンの無効化（見た目・`disabled`属性の両方）が働くこと、新規登録したチームが
一覧にカラー付きで反映されること、編集モーダルで既存色が正しくプリフィルされ、
変更後保存すると一覧のスウォッチが即時更新されることを確認した。コンソールエラー無し。

### 9.11 順位確定機能の画面（Phase 4、2026-09-24実装・staging確認まで）

8.9章のバックエンドAPIに対する画面実装。管理側1画面＋会場スクリーン側2画面の構成
（B案：ユーザー別・選手別を別画面に分離）。ランチャー（`public/admin/index.html`）の
`launcher-nav`に「順位確定」項目を追加した（`events.html`等と同じ
`<a href>` + `nav-title` + `nav-desc`パターン）。

```
public/admin/ranking-control.html  … 管理用。イベント選択＋「順位確定」ボタン＋確定結果表示
public/ranking-user.html           … 会場スクリーン用。ユーザー別順位発表
public/ranking-target.html         … 会場スクリーン用。選手・推し対象別順位発表
```

**`ranking-control.html`**

- イベント選択は`events.html`と同じ`GET /admin/events`を再利用（新規API無し）
- 「順位確定」ボタンの表示可否は`events.html`の`actionButtonsFor(event)`と同じ規約：
  対象イベントのstatusがlive/paused/finishedのときのみボタンを描画し、
  scheduled/cancelledではグレーアウトやエラー表示をせず、ボタン自体を描画しない
- ボタン押下で8.9章のPOSTを実行し、レスポンス（ユーザー別・選手別それぞれ上位20件）を
  その場で表形式表示する。400 INVALID_EVENT_STATUS・404 EVENT_NOT_FOUNDはerror-barへ
  分かりやすいメッセージで表示する
- 会場スクリーンURL（`ranking-user.html`・`ranking-target.html`、いずれも
  `?event_id=<選択中のイベントID>`）を、`events.html`の対抗戦URL欄
  （`.battle-url-row`、9.3章）と同じ構成でテキスト入力＋「コピー」ボタンとして表示する。
  この欄はイベントのstatusに関わらず、イベントが選択されていれば常に表示する
  （未確定でもスクリーン側を先に開いておく運用を想定。スクリーン側は未確定時
  「まだ順位が確定していません」を表示するため支障が無いため）

**`ranking-user.html`・`ranking-target.html`（会場スクリーン、2画面はrankingTypeパラメータ
以外ほぼ同一構成）**

- `battle.html`（9.4章）と同じ設計：URLパラメータ（`event_id`、`target-report.html`と
  同じ命名。`battle.html`の`battle_id`とは対象が異なるため揃えていない）を受け取り、
  3秒間隔で`GET /events/:eventId/ranking-snapshots/latest?rankingType=user|target`
  （8.9章）をポーリングして描画する単独ページ（WebSocket接続は行わない）
- 配色・レイアウト・エラー表示（`event_id`未指定時の案内、`EVENT_NOT_FOUND`時の致命エラー、
  一時的な通信断時は直前の表示を保持したまま再試行バナーのみ表示）は`battle.html`を踏襲
- `snapshotId: null`（未確定）の場合は「まだ順位が確定していません」の待機表示にする
- 同順位は同じ順位番号で複数行表示、番号の飛びはAPIの計算結果をそのまま表示する
  （画面側での調整は行わない）。1〜3位の行には金・銀・銅の枠線を付ける演出を追加した
  （`battle.html`のチームカラー基調の配色パターンを踏襲した拡張）
- `battle.html`側にあった「前回取得結果と同じ場合は再描画をスキップする」という最適化は
  実装時点のコードには存在しなかったため（調査済み）、Phase 4でも同様の最適化は追加していない

**動作確認（2026-09-24、staging DBに接続した一時ローカルサーバー〔`src/app.js`相当に
`public/`の静的配信を追加しただけの構成、リポジトリには非コミット〕、claude-in-chromeでの
ブラウザ確認）**：

- `ranking-control.html`：finished/paused/scheduledそれぞれのイベントでボタンの表示・
  非表示切り替えを確認（scheduledのテストイベントを一時作成し確認後に非表示化）。
  finished・pausedのイベントで実際に「順位確定」を実行し、確定結果表示（応援ログ0件時の
  「応援ログがありません」、および3名分のテストデータによる同率1位→3位表示）を確認
- `ranking-user.html`：未確定イベントでの「まだ順位が確定していません」表示、確定済み
  イベントでの実データ表示（金・銀・銅の枠線、同順位表示）を確認
- 両画面ともブラウザコンソールにJSエラー・例外なし（`read_console_messages`で確認）
- 確認用に作成したイベント1件・ユーザー3件・cheer_logs・ranking_snapshotsは
  すべて削除・非表示化して原状回復した（詳細は`docs/worklog.md` 2026-09-24エントリ参照）
- `ranking-target.html`は`ranking-user.html`との差分（rankingType・タイトル文言のみ）が
  小さいため、待機表示のみブラウザで確認し、確定結果表示は実データ確認を実施していない

**未確認のまま残った点**：

- 静的ファイルの2箇所デプロイ（runbook.md「デプロイ手順」）・staging/本番への反映は未実施
- `ranking-target.html`の確定結果表示（実データでのレンダリング）は`ranking-user.html`側の
  確認で共通コードパスであることの確認に留め、個別のブラウザ確認は行っていない
- 実際の会場での大画面表示・演出面の調整は未実施（`battle.html`と同様、最小実装のまま）

> **2026-09-24追記：上記2点を解消し、本番デプロイも完了。**
> - `ranking-target.html`の確定結果表示を、短い名前（1文字）・長い名前（40文字超、
>   括弧・中黒混在）・HTMLタグを含む名前（`<script>alert(1)</script>`、XSS対策確認用）・
>   記号混じりの英語名（アポストロフィ・アンパサンド・引用符）・同率1位の5パターンで
>   実データ確認した。いずれもレイアウト崩れ無く表示され、`<script>`タグは
>   textContent/escapeHtml経由でエスケープされ実行されない（アラート等が発火しない）ことを
>   確認した。確認用に作成したtargets・cheer_logs・ranking_snapshotsはすべて削除して
>   原状回復した
> - 静的ファイル4件（`ranking-control.html`・`ranking-user.html`・`ranking-target.html`・
>   更新済み`admin/index.html`）を`/var/www/cheerstick-admin/`・`/var/www/cheerstick-app/`へ
>   反映。`diff`で反映確認、新規3ファイルは`chown ubuntu:ubuntu`・`chmod 664`を実施し
>   既存ファイルと所有者・パーミッションを揃えた
> - 本番ドメイン経由の疎通確認：`admin.cheerstick.com/ranking-control.html`は
>   nginx IP制限により403（想定通り）、`app.cheerstick.com/ranking-user.html`・
>   `ranking-target.html`はいずれも200で配信されることを確認
> - **実際の会場での大画面表示・演出面の調整は引き続き未実施のまま**（`battle.html`と同様）

### 9.12 お客様向け「デモモード」機能（管理画面へのボタン追加、2026-09-29実装・ローカル確認まで）

`docs/proposals/demo-mode-admin-ui.md`（実装前調査）の結果（方式1＝子プロセス起動）に
基づく実装。管理画面（`public/admin/events.html`）に、お客様の前ですぐに100 vs 100の
応援合戦デモを見せられるボタン3つを追加した。**本番EC2・WebARENAへの反映は未実施。**

- カテゴリー「デモ用」・対象チーム・台数（各100台）・実行時間（60秒固定）は
  サーバー側で固定しており、リクエストボディからは一切受け付けない
  （安全策。`scripts/demo/battle-demo-prepare.js`の既存の「デモ用」カテゴリー不在時に
  例外を投げる仕組み、`--pause-other-live`の対象限定と合わせた二重の保護）
- `scripts/demo/battle-demo-prepare.js`・`scripts/demo/battle-demo.js`はいずれも
  無改修（in-process require / `child_process.spawn`でそのまま再利用）

**状態管理（`src/services/demoModeState.js`）：** `cheerstick-server`プロセスの
メモリ上（モジュールレベル変数）にのみ持つ。`idle`（未セット）→`set`（セット済み）→
`running`（実行中）の3状態。pm2再起動時は意図的に引き継がず、常に`idle`から始まる。
setup/start/stopの二重呼び出し（ダブルクリック等）を防ぐため、awaitを挟む前に
同期的にチェックする排他ロック（`transitioning`フラグ）を持つ。

**管理API（`src/controllers/adminDemoController.js`、`src/routes/admin.js`に追加。
既存の管理APIと同じくnginx側のIP制限のみ、アプリケーションレベル認証なし）：**

```
POST /admin/demo/setup
  現在runningなら409 { error: "DEMO_RUNNING" }。二重呼び出し中なら409 { error: "DEMO_BUSY" }。
  前回のbattleIdがあれば先にbattle-demo-prepare.jsの--finish-run相当を実行してから
  （失敗しても続行）、--yes --pause-other-live --devices-per-team=100で新規セットアップする。
  成功時201 { status, battleId, screenUrl, elapsedMs, remainingMs }

POST /admin/demo/start
  setでなければ409（{error:"DEMO_RUNNING"}または{error:"DEMO_NOT_SET"}）。
  二重呼び出し中なら409 DEMO_BUSY。battle-demo.jsをchild_process.spawnで起動する
  （--url=ws://127.0.0.1:<PORT>/cheer・--score-url=.../event-battles/:id/score・
  --duration-ms=60000・--burst --target-range=0.35-0.65、9/28〜29のテスト設定を踏襲）。
  成功時200 { status:"running", ... }

POST /admin/demo/stop
  runningでなければ409 DEMO_NOT_RUNNING。子プロセスへSIGTERMを送り、終了（'exit'イベント）を
  待ってから応答する。5秒応答が無ければSIGKILL。応答時点で子プロセスは実際に終了している。

GET /admin/demo/status
  { status, battleId, screenUrl, elapsedMs, remainingMs }を返す。runningでないときは
  elapsedMs/remainingMsはnull。screenUrlは`/battle.html?battle_id=...&gauge=recent&poll=1000`
  という相対パス（絶対URL化はフロント側のAPP_BASEに委ねる。対抗戦ペア一覧の
  battleScreenUrl()と同じ考え方）
```

**子プロセスの`--report-interval-ms`について（実装時に判明した調整）：**
`battle-demo.js`の「duration-ms経過で自動終了」判定は、`reportIntervalMs`（既定10秒）
ごとの定期チェックでのみ行われる。本番の60秒固定設定では`10000ms`のままで従来と
変わらないが、コントローラー側では`durationMs`に比例させた値
（`max(1000, min(10000, floor(durationMs/6)))`）を明示的に渡すようにした
（ローカル確認でテスト専用の短縮durationMsを使った際、既定の10秒間隔のままだと
自動終了の検出が大幅に遅れることが判明したため。60秒固定の場合は`60000/6=10000`で
結果的に同じ値になり、本番の挙動は変わらない）。

**pm2再起動時のorphan化防止（`src/index.js`に追加）：** 従来`cheerstick-server`本体に
`SIGINT`/`SIGTERM`のハンドラは無かった。デモの子プロセスが実行中にpm2から再起動・終了
させられた場合に子プロセスが残り続けないよう、両シグナルのハンドラを新規に追加し、
追跡中の子プロセスへ`SIGTERM`を送ってから、従来と同じ即時終了（`process.exit`）を
行うようにした。

**画面側（`public/admin/events.html`、試合一覧カードの直後に「デモモード」カードを新設）：**
①デモをセット・②デモを開始/停止（トグル）・③表示画面を開く（`target="_blank"`のリンク）
の3つ。`GET /admin/demo/status`を2.5秒間隔でポーリングし、状態・残り秒数の表示、
ボタンの活性/非活性を切り替える。ページのリロード・別タブへの遷移をまたいでも、
状態はサーバー側のメモリに保持されているため復元される。

**指示書の記述との解釈の相違（要確認）：** 指示書の「デバイス・チームの取得ロジック」の
記述は「デモ用カテゴリーに属する最初の2チーム」等の汎用的な取得を想定していたが、
実際の`battle-demo-prepare.js`は`findOrganization()`でチーム名（既定`EMUTTO`・
`J SPORTS`）を直接指定して検索する設計（新規作成はしない）。今回はこの既存デフォルトを
そのまま使う形にした（結果的に対象は正しく「デモ用カテゴリーの既存2チーム」に絞られる
ため、動作上の実害はないと考えられる）。

**ローカル確認（`scripts/demo/local-verify-demo-mode.js`新規、pg-mem＋実サーバー、
HTTP経由でAPIを一気通貫確認。25項目、全PASS）：**

- 初期状態`idle`、`idle`時の`start`は409 `DEMO_NOT_SET`
- `setup`の同時呼び出し（Promise.allで2件同時発行）は一方だけ201、他方は409
  `DEMO_BUSY`になり、`event_battles`が1件しか作られないことを確認
- `setup`後は`set`、`battleId`・`screenUrl`（`battle_id`・`gauge=recent`・`poll=1000`を
  含む）が正しく返る
- `start`で`running`になり、`remainingMs`が`durationMs`付近であること、実際に子プロセスが
  起動している（PIDの生存確認）ことを確認
- `running`中の`start`・`setup`はいずれも409（`DEMO_RUNNING`）
- `stop`は応答時点で子プロセスが実際に終了していること（PID生存確認）、
  `running`でないときの`stop`は409 `DEMO_NOT_RUNNING`であることを確認
- 再度`setup`すると、前回のバトルの両試合が`finished`になり（自動終了）、
  新しい`battleId`が発行されることを確認
- テスト専用の短縮`durationMs`経過後、自動的に`set`へ戻ること、その際も子プロセスが
  実際に終了していることを確認（本番用の60秒固定はAPIのリクエストボディからは
  変更不可のまま。環境変数`DEMO_MODE_TEST_DURATION_MS_OVERRIDE`はテスト専用）
- pm2相当の終了シグナルのシミュレーション：実際にpm2からのSIGTERMを受けて呼ばれるのと
  同じ関数（`killRunningChildForShutdown()`）を直接呼び、実行中の子プロセスが実際に
  終了することを確認
- 既存の`scripts/demo/local-verify.js`（27項目）・`scripts/rate-limit/local-verify.js`
  （26チェック）とも引き続き全PASS（回帰無し）

**ブラウザでの確認（claude-in-chrome、スクラッチ領域の一時サーバー＋pg-mem、
リポジトリ非コミット）：** セット→開始（カウントダウン表示）→表示画面を開く（新規タブで
実際の対抗戦画面が開き、WebSocket経由の応援データが反映されて動くことを確認）→停止
（即座に「セット済み」へ戻る）→ページリロード後も状態が復元される、の一連の流れを確認した。

**次回への申し送り：** 試合一覧テーブルは既存実装どおりカテゴリーによる絞り込みが無いため、
デモで作成した試合（「デモ対抗戦 EMUTTO vs J SPORTS ...」）が通常の試合一覧にも
表示される（今回のスコープ外の既存動作。実害は無いと考えられるが、運用上気になる場合は
別途対応を検討）。

> **2026-09-29追記（対象チームの取得をチーム名に依存しない方式へ変更、ローカル確認まで）：**
> 上記「指示書の記述との解釈の相違（要確認）」で残っていた、チーム名（`EMUTTO`・
> `J SPORTS`）に依存する実装を解消した。KMT様の指示により、`setup`処理内で
> `src/controllers/adminDemoController.js`の新関数`resolveDemoTeams()`が、
> 「デモ用」カテゴリーに属する既存チームのうち**作成日時が最も古い2件**を
> （`cheerQueries.listCategoriesForAdmin()`・`listOrganizationsForAdmin()`を
> in-process呼び出しして）決定し、そのチーム名を`--team-a-name`・`--team-b-name`として
> `prepare.main()`へ明示的に渡すよう変更した。**`scripts/demo/battle-demo-prepare.js`
> 自体は引き続き無改修**（同スクリプトはチーム名で検索する設計のまま）。これにより、
> 将来チーム名を変更してもコード変更なしでそのまま動作する。既存の安全策
> （カテゴリー不在時は新規作成せず例外・対象を「デモ用」カテゴリーのみに限定）は
> そのまま維持している。
>
> **ローカル確認（`scripts/demo/local-verify-demo-mode.js`に新規4項目追加、
> 計29項目、全PASS）：** 既存2チームの名前を旧デフォルト名と無関係な名前
> （「チームアルファ」「チームベータ」）へリネームし、さらに名前がアルファベット順で
> 先頭に来る（＝もし実装が名前順や一覧の先頭2件で選んでいた場合に誤って選ばれるはずの
> 「罠」となる）3チーム目「AAAA」を後から追加したうえで`setup`を実行し、実際に選ばれる
> 2チームが、作成日時の古い順で正しくリネーム後の元2チームになっていること（「AAAA」は
> 選ばれないこと）をDBで確認した。既存25項目・`scripts/demo/local-verify.js`（27項目）・
> `scripts/rate-limit/local-verify.js`（26チェック）とも引き続き全PASS（回帰無し）。

### 9.13 ゲージ火花演出 `fx=spark`（デモモードのみ、2026-10-01実装・ローカル確認まで）

`battle.html`（対抗戦画面）の綱引きゲージに、勢いが強いときだけ火花・光・揺れを出す演出。
**本番未反映。** 対象は`battle.html`のみ（`ranking-user.html`・`ranking-target.html`・`public/index.html`には無関係）。

**発火条件・有効化**
- URLに`fx=spark`と`gauge=recent`の**両方**があるときだけ有効（「勢い」が`gauge=recent`の計算結果に依存するため）。
  どちらか欠ければ見た目・挙動は従来と変わらない（`fx`単独・`gauge=recent`のみ・パラメータ無しの3経路で、変更前後のレイアウト座標が一致することをヘッドレスChromeで確認）
- 「勢い」＝既存の`gaugeAnimState.smoothedMagnitude`（リーダー側への押し込み幅。0〜0.5-range、なめらか追従後）をそのまま再利用（新しい計算式は追加していない）
- **発火** ＝ `smoothedMagnitude >= SPARK_INTENSITY_THRESHOLD`（初期値`0.20`＝リーダー側が70%以上）かつ、揺れ停止中（`holding`＝`gaugeRecentState.holding || counterStallState.stalled`）でないとき。
  holding中は自動的にOFF。ON/OFFは毎フレーム（`tickRecent()`）にクラス（`#sparkLayer.on`・`#tugGaugeShake.gauge-shake`）の付け外しで行う。定数は他のゲージ定数（`COUNTER_STALL_*`の直後）に置いた
- しきい値の決め方：既定`amp=3`・`range=20`ではリーダー側の最大が80%（`smoothedMagnitude`の最大0.30）。拮抗〜中程度のリードでは出さず、最大押し込みの約2/3（70%）以上で出す値として仮決め。実機のデモで見て調整する想定（定数1箇所の変更のみ）
- 診断：`window.__battleDebug.sparkOn`に現在の発火状態を出す

**見た目**
- `fx`有効時のみ、バー色を固定グラデーション（A側：外側が濃い赤→拮抗点側が薄いオレンジ、B側：拮抗点側が薄い水色→外側が濃紺）にする。`organizations.color`には追従しない（今回の固定値でよいとの指示）
- 火花28個・拮抗点の光（`.gauge-hot-glow`）は、ゲージと同サイズの透明な重ねレイヤー`#sparkLayer`内に置き、位置（left）は毎フレームのゲージ境界（`finalA`）に追従
- 揺れ（`barShake`）は、JSが`width`を毎フレーム更新するゲージ本体（`#tugFillA/B`）ではなく、外側の新規ラッパー`#tugGaugeShake`にのみ適用（`transform`と`width`更新の競合回避）。ゲージ幅の値（リーダー側50%以上等の不変条件）は揺れの影響を受けず、ヘッドレス確認で強い勢い（80%）〜停止の間、ゲージ幅が従来の計算結果のままであることを確認

**管理画面のチェックボックス（`public/admin/events.html`）**
- 配置：「デモモード」枠内、「表示画面を開く」ボタンの右。ラベル「ゲージ演出（火花）」、`id="sparkEffectToggle"`
- 既定は常にOFF（`autocomplete="off"`、サーバー状態は問い合わせない。リロードでOFFに戻ることを確認）
- 「デモをセット」押下時の状態だけが反映される：`POST /admin/demo/setup`のボディに`{ sparkEffect: true|false }`を含める。
  あとからチェックを変えても、すでにセット済みのデモの`screenUrl`は変わらない（次の「デモをセット」で反映）
- サーバー（`adminDemoController.js`）：`sparkEffect === true`（真偽値のtrueのみ。省略・文字列"true"等はfalse）のとき、`screenUrl`の末尾に`&fx=spark`を付ける
  （例：`/battle.html?battle_id=...&gauge=recent&poll=1000&fx=spark`）。`demoModeState.js`に`sparkEffect`を保持し、`GET /admin/demo/status`の応答にも`sparkEffect`・`fx=spark`入りの`screenUrl`が出る
- **対抗戦ペア登録（実機イベント用、8.4章）への対応は見送り**（デモモードのみの機能とするKMT様判断、2026-10-01）。ペア一覧のURLは従来どおり`battle_id`のみ

**確認結果（ローカル）**：`scripts/demo/local-verify-demo-mode.js`に`sparkEffect`の検証5項目を追加し34/34 PASS。他4本（27/26/8/35）も全PASS。
ブラウザ確認は模擬スコアAPI＋ヘッドレスChrome（CDP）で実施：強い勢いで約3秒後に発火、応援停止後約2〜3秒で消火、拮抗では非発火。

> **2026-10-01追記（見た目の調整：縦幅2倍・グラデーション全般化・火花の上下両方向化、ローカル確認まで）：**
> 上記9.13の「見た目」のうち、以下を変更した（上記の記述は残し、本追記を現行とする）。
> データ側（API・DB・WebSocket・ポーリング・レート制限）、火花の発火条件・ON/OFFの仕組み
> （`fx=spark`、管理画面チェックボックスはデモモード限定）は変更していない。本番未反映。
>
> 1. **ゲージの縦幅2倍（`gauge=recent`全般）**：`#tugGaugeWrap.gauge-tall`（JSが`gauge=recent`のとき付与）で
>    `#tugGauge`と`#sparkLayer`の高さを56px→112px。増えた高さは、`flex:1; min-height:0`の`#battleGrid`
>    （数値エリア）が自動的に縮んで吸収する（テーマ画像・ラベル・余白は不変。JSの位置・揺れ・アニメの計算は未変更）。
>    画面の高さが低い場合のため、`html.gauge-recent-mode`のときだけpt表示のフォントを
>    `clamp(32px, min(9vw, 11vh), 96px)`（従来は`min(9vw)`相当の96px上限）にした（1280×900・1920×1080では従来の96pxのまま。
>    1024×640＋テーマ画像でもはみ出さない）
> 2. **グラデーションを`gauge=recent`全般に適用**：クラス`fx-spark`を`gauge-recent`へ改名し、付与条件を
>    `fx=spark`から`gauge=recent`へ変更（`fx=spark`の判定からは切り離した）。パラメータ無しの単色ゲージは不変。
>    **実機の本番イベントの画面（`gauge=recent`付き）の見た目も変わる**
> 3. **火花を上下両方向に**：28個のうち、配列の奇数番目（0始まり、14個）の終点yの符号を反転して下方向にした
>    （偶数番目14個は上方向のまま）。x・個数・色・速さ・発火条件は不変（コード上で反転しているため元データの配列は不変）
>
> **確認（ヘッドレスChrome）**：パラメータ無しは、1280×900／1920×1080／1024×640（テーマ画像の有無）の4通りで、
> 旧版とレイアウト座標・画素が完全一致。`gauge=recent`は縦幅112px、`gauge=recent&fx=spark`は強い勢いで
> 発火し、ゲージ幅（80%上限・B優勢時38.7%等）の不変条件・エラー0。火花の終点は上14・下14。
> 既存テスト5本全PASS（27/26/34/8/35）。
> 火花は個々が小さく半透明のため、静止画ではかなり淡く見える（今回は見た目を変更していない）。

## 10. 未実施の検証

**2,000〜20,000本規模の負荷試験は一度も実施していない。**
現構成は1台のEC2上でREST API・WebSocketを単一プロセスが処理し、PostgreSQLも同居。
リリース前に以下の確認が必要：

- 同時接続数を段階的に上げた際のメモリ / FD / CPU 挙動
- `count` メッセージが毎秒×接続数ぶんDBへ向かう際の詰まり（バッチINSERTの要否）
- nginx `proxy_read_timeout` の妥当性
- pm2 インスタンス数とEC2インスタンスタイプの妥当性
- 最悪時のスケールアップ手順（インスタンスタイプ変更＋再起動）の事前準備

### 10.1 実機接続1本使用時のAWS負荷基準値（2026-09-17計測）

負荷試験そのものではなく、実機接続1本という最小構成での基準値として記録する。

```
インスタンスタイプ：t3.micro（2 vCPU、メモリ約909.5MiB）
CPU使用率：0%（load average 0.00/0.00/0.00）
メモリ：使用中453.5MiB（うちpm2のcheerstick-serverプロセス自体は74.5MB）、
        ホスト全体RAM使用率48.1%（pm2表示）
ディスク：ルート53%使用（6.8GB中3.6GB）
PostgreSQLアクティブ接続数：8件（pg_stat_activity）
```

**所見：** CPU・メモリとも1本接続時点では余裕があるが、**メモリ総量自体が
t3.micro（約1GiB）と小さい。** 上記の2,000〜20,000本規模の商用リリースに
対し、早い段階でメモリが上限に達する可能性が高いため、負荷試験の実施前に
インスタンスタイプのスケールアップ要否を検討することを推奨する。

### 10.2 将来検討：pm2 cluster mode検証（8,000〜10,000本規模、単発イベント対応、2026-09-24追記）

**現時点のステータス：方向性の合意のみ。実装・検証は未着手。** 着手時期は
「8,000〜10,000本規模のイベントが具体化した段階」を想定。

**背景：** 現状2,000本での実機運用が前提だが、将来的に**1イベント限定**で
8,000〜10,000本規模の対応を検討する可能性がある。この規模では、10.1節や
worklog（2026-09-21）で確認済みのNode.jsシングルスレッド制約（m5.largeでも
4,000接続時にCPUが瞬間的に100%へ達する事象を確認済み）が問題になると想定される。

**方針：**

- インスタンスサイズを上げるだけでは根本解決にならない（シングルスレッド制約は
  vCPU数を増やしても解消しない）ため、**pm2 cluster mode（`pm2 start ... -i max`）
  による複数プロセス並列化が本命の対策**
- ただし、WebSocketのセッション管理（`this.sessions`のMap）がプロセスごとの
  メモリ内に閉じているため、cluster mode化する場合は**Sticky Session対応
  （同一デバイスを常に同じプロセスへ振り分ける仕組み）が必要になる可能性が高い**。
  まずSticky Session無しでcluster mode化し、負荷試験でセッション不一致の問題が
  実際に起きるかを確認してから、要否を判断する段階的な検証が望ましい
- **「1イベント限定」という条件により、常時稼働を維持する必要がない。**
  「試合当日だけ一時的にスケールアップという運用はダウンタイムが発生するため
  使えない」という通常運用時の制約は、単発イベント対応に限っては当てはまらない。
  イベント当日のみ大きめのインスタンス（m5.xlarge等）を一時起動し、終了後に
  通常サイズへ戻す運用が現実的な選択肢となる
- インスタンスの選択肢としては、同系統でのスケールアップ（m5.xlarge・m5.2xlarge）
  の他、コスト最適化の余地としてGraviton系（m6g/m7g、同スペックで2〜3割程度安い
  傾向、ただしネイティブモジュール依存パッケージのARM対応要確認）や
  コンピューティング最適化系（c5系等）も将来の比較検討候補として記録しておく

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

> **2026-09-11追記（本番DB再確認）：** 上記「0件」を2026-09-11、本番DB
> （`cheerstick_production`）へのSSH経由・読み取り専用SELECTで再確認した
> （2026-08-10時点の記述から約1ヶ月、9/6のB-1/B-2実機検証を挟んでの再確認）。
> **`cheer_logs`の総行数は引き続き0件のまま変化なし。** `event_id`別
> `GROUP BY`でも0行であり、本番`events`テーブルに存在する唯一の実地検証
> イベント「【テスト】B1B2確認 20260906」（8.1・8.2章）でも書き込みは
> 発生していなかった。原因の切り分け（実機接続時にイベントが`live`状態で
> なかった可能性等）は未実施。詳細は`docs/worklog.md`2026-09-11エントリ
> （本番DB SSH接続の再試行・cheer_logs実データ確認）参照

> **2026-09-17追記（原因特定・解消）：** 実機（CheerStick本体・Androidアプリ、
> MAC `A4:C1:38:D1:C5:6E`）を用いた4回目の接続テストで、上記「原因の切り分け
> 未実施」の状態を解消した。原因は2点：（1）検証対象デバイスの
> `devices.category_id`が未設定であったこと（6.2章の判定により`connect`が
> `status:"error"`を返し、そもそもチーム選択自体に進めない状態だった）、
> （2）デバイスの選択中チームに対応するイベントが`live`化されていなかったこと
> （4.3章の判定により、`live`以外はDB保存がスキップされる仕様どおりの動作）。
> `docs/verification-checklist-hardware.md`項目1の手順（category設定→
> テストイベント作成・live化→応援動作→`cheer_logs`確認）に沿ってこの2点を
> 解消した状態で応援動作を行ったところ、`cheer_logs`への書き込みを初めて
> 実機で確認できた。既存記述（0件だった時点の記録）は削除せず、原因が実機
> 検証で判明したことをここに追記する。詳細は`docs/worklog.md`2026-09-17
> エントリ参照。

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

### 11.8 `event_battles`テーブルにアプリDB接続ロール（`cheerstick`）の権限が無い（2026-09-11追記・同日解消済み）

> **2026-09-11解消：** KMT様がTeraTermで`ALTER TABLE event_battles OWNER TO cheerstick;`
> を実行（`\dt`で所有者が`cheerstick`に変わったことをKMT様側で確認済み）。Claude Code側でも
> 以下の再確認を実施し、権限問題が解消したことを確認した。
> - `GET /api/v1/event-battles/<存在しないUUID>/score`：`permission denied`ではなく
>   `404 {"error":"BATTLE_NOT_FOUND"}`が返ることを確認
> - `GET /api/v1/admin/event-battles`（一覧取得）：`200 []`（権限エラーなし）を確認
> - `POST /api/v1/admin/event-battles`で実際にテスト行をINSERT（既存の非表示化済み
>   テストイベント2件をペアリング、新規イベントは作成せず）→ `201 Created`で成功
> - 作成したテスト行に対し`GET .../score`で`total_intensity`を含むJOIN・SUM集計まで
>   正常応答することを確認（`team_a`/`team_b`とも`total_intensity: 0`。9/6の実地検証時点で
>   `cheer_logs`が0件のままであるため、11.7章の記述と整合する結果）
> - `DELETE /api/v1/admin/event-battles/:id`でテスト行を削除、一覧が`[]`に戻ることを確認
>
> 以上により、対抗戦機能（8.4・9.3・9.4章）は本番で実際に使用可能な状態になった。
> 以下は問題発生時点（2026-09-11午前）の記録として残す。

**事象**

2026-09-11の「2チーム対抗応援合戦」機能の本番デプロイ（migration 011適用）時に発生。
`migrations/011_add_event_battles.sql`を`sudo -u postgres psql`（PostgreSQLスーパーユーザー）
経由で実行したため、作成された`event_battles`テーブルの所有者が`postgres`のままとなり、
アプリケーションのDB接続ロールである`cheerstick`に一切の権限（SELECT/INSERT/UPDATE/DELETE等）が
付与されていない。

```sql
-- 確認済み（2026-09-11、読み取り専用）
SELECT tablename, tableowner FROM pg_tables
  WHERE schemaname='public' AND tablename IN ('events','event_battles');
--    tablename    | tableowner
-- ----------------+------------
--  event_battles  | postgres     ← 他の全テーブルは cheerstick が所有
--  events         | cheerstick
```

**影響**

対抗戦関連のAPIが全て`{"error":"permission denied for table event_battles"}`で失敗する
（本番反映直後に`GET /api/v1/event-battles/:id/score`・`GET /api/v1/admin/event-battles`の
両方で実際に発生することを確認済み）。**既存の機能（WebSocket `connect`/`count`、
管理画面の試合・チーム管理等）には一切影響しない**（`event_battles`テーブルを
参照するのは対抗戦関連のコードのみのため）。

**対応が必要な点**

以下いずれかのSQLを、本番DBに対しPostgreSQLスーパーユーザー権限で実行する必要がある。
Claude Codeでの実行は権限クラシファイアにより`GRANT`文・`ALTER TABLE ... OWNER TO`文の
いずれもブロックされたため、**KMT様がTeraTerm等で直接実行する必要がある。**

```sql
-- 案A（推奨）：他の全テーブルと同じ所有者に揃える
ALTER TABLE event_battles OWNER TO cheerstick;

-- 案B：所有者は変更せず、events テーブルと同じ権限セットのみ付与する
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON event_battles TO cheerstick;
```

実行後、`GET https://api.cheerstick.com/api/v1/event-battles/<存在しないUUID>/score`が
`permission denied`ではなく`404`（`BATTLE_NOT_FOUND`相当）を返すことで解消を確認できる。

**対応時期**：実機到着前の準備の一環として、次回セッションまたはKMT様の手動対応で
早期解消が望ましい（`docs/verification-checklist-hardware.md`項目2（対抗戦のスコア表示）の
検証がこの解消を前提とするため。項目5の一括開始/停止/終了ボタンは既存の
`PATCH .../status`を呼ぶのみで`event_battles`テーブルを参照しないため、
本問題による影響は受けない）。

### 11.9 staging DB（`cheerstick_staging`）に migration 011（`event_battles`）が未適用（2026-09-13発見・同日解消）

> **2026-09-13解消：** staging DBへ`migrations/011_add_event_battles.sql`を適用した。
> 本番（11.8章）と異なり所有者問題は発生していない（適用方法は下記「対応」参照）。
> events.htmlから対抗戦ペアの登録・一覧・公開スコアAPIまで一連の動作を実データで確認し、
> 権限エラーが無いことを確認した。以下は問題発生時点（本節新設時）の記録として残す。

**事象**

管理画面3ページ分割（9.5章）の staging DB実データ確認中、events.htmlの対抗戦ペア一覧が
以下のエラーで取得に失敗することが判明した。

```
対抗戦ペア一覧の取得に失敗しました: relation "event_battles" does not exist
```

**原因（推定）**：11.8章の本番デプロイ（2026-09-11）は本番DB（`cheerstick_production`）に
対してのみ実施しており、staging DB（`cheerstick_staging`）へは`migrations/011_add_event_battles.sql`
を適用していない。11.8章の権限問題（本番のみで発生・解消済み）とは別の問題であり、
staging側は「テーブル自体が存在しない」状態である。

**影響**：staging DBを使う限り、対抗戦ペア登録・一覧・スコア表示（8.4・9.3・9.4章）の
実データ確認ができない。9.5章の3ページ分割の動作確認でも、この部分のみ確認できていない
（events.html・masters.htmlのそれ以外の機能への影響は無いことを確認済み）。

**対応**：今回は確認のみで、修正は行っていない。次回、staging DBへ
`migrations/011_add_event_battles.sql`を適用するかは、本番と同様
`sudo -u postgres psql`経由で実行すると11.8章と同じ所有者問題が再発する可能性があるため、
適用方法も含めKMT様と相談のうえ判断すること。

**解消（2026-09-13）**

本番（11.8章）で発生した所有者問題（`sudo -u postgres`経由で実行したため、作成された
テーブルの所有者が`postgres`になり、アプリのDB接続ロールに権限が無い状態になった）を
踏まえ、staging DBでは異なる方法で適用した。

- `.env`の`DATABASE_URL`（`cheerstick_stg@localhost:5433`、KMT様確立のSSHトンネル経由）を
  そのまま使い、Node（`pg`ライブラリ）経由で**アプリの接続ロール`cheerstick_stg`自身**が
  `migrations/011_add_event_battles.sql`の7文を1文ずつ実行した
- 事前に読み取り専用で確認した内容：`cheerstick_stg`が`public`スキーマへの`CREATE`権限を
  持っていること（`has_schema_privilege`で確認）、`schema_migrations`に001〜010が
  適用済みで011が未適用であること、`event_battles`テーブルがまだ存在しないこと
- **接続ロール自身がテーブルを作成すれば、そのロールが自動的に所有者になる**ため、
  本番のような所有者不一致（アプリロールに権限が無い状態）は原理的に発生しない。
  適用後、`event_battles`・`events`とも所有者が`cheerstick_stg`で一致していることを
  実際に確認した（`pg_tables`参照）。`OWNER TO`・`GRANT`文はいずれも実行していない
  （指示どおり、所有者変更操作は行っていない）
- 構造（列・PK・CHECK制約・2本のFK・2本のインデックス）も仕様どおりであることを確認した
- 動作確認：events.htmlから対抗戦ペア（テスト試合１×テスト試合4）を実際に登録→
  一覧表示→公開スコアAPI（`GET /api/v1/event-battles/:id/score`、`total_intensity: 0`。
  staging DBの`cheer_logs`が空のため妥当）→削除、の一連の流れをUI操作で確認し、
  権限エラーが一切発生しないことを確認した。確認後に削除し、`event_battles`は0行
  （適用直後と同じ状態）に戻している。対象イベント（テスト試合1/4）のstatusは
  ペア登録・削除の前後で変化していないことも確認した（仕様どおり）
- **`schema_migrations`テーブルへの適用記録（INSERT）は今回実施していない。**
  指示された作業範囲（migration本体の適用・所有者確認）に含まれていなかったため、
  記録の要否は次回判断とする。未記録のままだと、次回`node src/db/migrate.js`を
  staging DBに対して実行した際、011を再適用しようとして`already exists`エラーに
  なる可能性がある点に注意

> **2026-09-13追記（同日中に対応）：** 上記の`schema_migrations`未記録の状態を本日中に
> 解消した。KMT様指示により、`src/db/migrate.js`が実際に使用しているINSERT文
> （`INSERT INTO schema_migrations (filename) VALUES ($1)`、`applied_at`はデフォルトの
> `NOW()`に委ねる）と全く同じ形式で`'011_add_event_battles.sql'`の1行を追加した。
> 追加後、`SELECT * FROM schema_migrations ORDER BY filename`で001〜011が
> `filename`昇順（＝適用順）で揃っており、011の`applied_at`が実行時刻（他の行と同じ
> カラム構成・型）で記録されていることを確認した。これにより、次回staging DBに対して
> `node src/db/migrate.js`を実行しても011は`SKIP`扱いとなり、再適用エラーは発生しない。
> 詳細は`docs/worklog.md`同日エントリ（「schema_migrationsへの011適用記録の追加」）参照

### 11.10 WebSocketの接続が正しくクローズされず残る場合がある（幽霊接続、2026-09-17発見）

**事象**

実機接続テスト（4回目、11.7章参照）中の監視で、同一デバイス（MAC
`A4:C1:38:D1:C5:6E`）の再接続時にサーバー側のWebSocket接続（`ss -tnp`で確認）が
一時的に2件同時に存在する事象を観測した。また、アプリを終了しても、あるいは
アプリ内「応援を終了する」ボタンを押しても、サーバー側の接続がすぐに消える場合と、
数分以上残り続ける場合の両方が実際に観測され、切断のタイミングが安定しないことを
確認した。

**調査結果（コード確認）**

- `src/websocket/index.js:164`：`connect`時に`this.sessions.set(deviceId, ws)`で
  新しい接続を登録する際、**同一MACの既存（旧）接続を明示的にcloseする処理が
  無い。** 新旧の接続が両方生きたまま並存できる構造になっている
- `src/websocket/index.js:281-285`：`ws.on('close')`のクリーンアップは、
  応援演出プッシュ配信用に予約された内部Map（`this.sessions`）のエントリを
  削除するのみで、**TCP/WebSocket接続自体を能動的にcloseする処理ではない**
  （closeはOS/wsライブラリ任せ）。加えて、新しい接続が来て`sessions`が
  上書きされた後に旧接続の`close`イベントが遅れて発火すると、キー名のみで
  無条件に`delete`するため、既に新しい生きた接続で更新済みのエントリを
  誤って消してしまう可能性がある（現状`sessions`はプッシュ配信に未使用のため
  実害は無いが、将来この機能を実装する際の不具合の温床になり得る）
- 4.4章記載の**ping/pongハートビートが未実装**であることを本調査でも再確認した
- `public/index.html`の「応援を終了する」ボタン（`endCheeringBtn`、957-963行目）は
  `window.CheerStickBridge.sendEnd({stat: 'end'})`をネイティブアプリへ送り、
  画面表示を切り替えるのみで、**JS側からWebSocketをcloseする処理は無い。**
  `socket`の`close`イベントハンドラ（595-644行目）にも「意図的な切断だから
  再接続しない」という分岐は無く、`hasShownContent`が真であれば常に自動再接続を
  試みる実装になっている。そのため、終了ボタン押下後に実際に接続が消えるか
  どうかは、**ネイティブアプリ（Vanstone様管轄、本リポジトリ管理外）がボタンの
  `sendEnd`シグナルを受けてWebView自体を破棄するかどうかに依存している**と
  推測される（本リポジトリのコード確認だけでは断定できない）
- 本番nginx（`/etc/nginx/sites-enabled/cheerstick-ws`）の`proxy_read_timeout`・
  `proxy_send_timeout`はいずれも86400秒（24時間）と長く設定されており、
  クライアントが正常なFINを送らずに消えた場合、サーバー側の接続は
  最大24時間近く残り得る

**実機での観測結果**

- 監視した範囲では、同時に3件以上の接続が並存した事例は無く、最大でも2件
  （新旧の一時的な並存）だった
- 4回目の接続テスト（本日）では、接続確立からテスト終了操作までの間、
  接続数は常に1件のままで推移し、2件以上の同時並存は発生しなかった
  （20秒間隔の監視ログで確認）

**影響・リスク評価**

- 実機1本での運用では、TCP接続1本分のメモリ・ファイルディスクリプタ消費は
  無視できる規模であり、現時点での実害は無い
- ただし、10章に記載の2,000〜20,000本規模の商用リリースでは、切断検知の
  仕組みが無いまま幽霊接続が蓄積し、EC2インスタンス（10.1章参照）の
  リソースを圧迫する実害に発展し得る

**対応が必要な点（今回は未実装、対応案）**

1. **新規接続時に同一デバイスの旧接続を明示的にcloseする対策**（低コスト。
   再接続が発生した場合にのみ効果があり、根本対策ではない）
2. **ping/pongハートビートの実装**（4.4章記載の根本対応。10章の負荷試験と
   合わせて計画する）

対応時期・優先度はKMT様の判断が必要。

> **2026-09-20追記：上記対応案(a)(b)を実装した（`feature/reference-data`ブランチ、
> ローカル・pg-mem疑似DBによる動作確認まで。本番デプロイは対象外）。**
>
> **実装前調査（フェーズ0）で判明した事実：**
> - 本番EC2のファイルディスクリプタ上限は、SSHログインシェルの`ulimit -n`（1024）とは別に、
>   実際に`pm2`で稼働する`cheerstick-server`プロセス（systemdサービス`pm2-ubuntu.service`、
>   `LimitNOFILE=infinity`）では`/proc/<pid>/limits`実測で1,048,576となっており、
>   20,000接続規模に対して既に十分な余裕があることを確認した。**そのためファイル
>   ディスクリプタ上限の引き上げ（ecosystem設定・systemd設定の追加変更）は不要と判断し、
>   今回は実施していない。**
> - `ws`ライブラリは`^8.21.0`で`ws.ping()`／`pong`イベントとも標準搭載済みであり、
>   バージョンに起因する懸念は無かった
>
> **実装内容：**
> 1. **ping/pongハートビート**（`src/websocket/index.js`）：30秒間隔（`HEARTBEAT_INTERVAL_MS`）で
>    全接続を走査し、90秒間（`HEARTBEAT_TIMEOUT_MS`）pong応答が無い接続を`ws.terminate()`する。
>    各接続の`ws.lastPong`にタイムスタンプを持たせ、`pong`イベントで更新する方式。
>    20,000接続規模での送信集中を避けるため、ping送信自体は接続ごとにランダムなジッター
>    （0〜15秒）を挟んで発火させる（`startHeartbeat()`メソッド）
> 2. **新規接続時の旧接続close**：`connect`メッセージ受信時、同一デバイスIDの旧接続が
>    `sessions`に残っていれば、新しい接続に置き換える前に`close(4000, 'replaced by new
>    connection')`で切断するようにした
> 3. **close時のsessions競合バグ修正**：`close`ハンドラで`sessions.delete()`する前に、
>    Mapに登録されている値が自分自身の`ws`インスタンスと一致する場合のみ削除するよう変更
>    （新接続への置き換え後に旧接続の`close`が遅れて発火しても、新接続のエントリを
>    誤って消さない）
> 4. **クライアント側（`public/index.html`）**：「応援を終了する」ボタン
>    （`endCheeringBtn`）のクリックハンドラに、`intentionalClose`フラグを立てたうえで
>    `socket.close()`を呼ぶ処理を追加。`socket`の`close`イベントハンドラの先頭で
>    このフラグを見て、意図的な切断の場合は自動再接続をスキップするようにした
>
> **動作確認（ローカル・pg-mem疑似DB、2026-09-20）：**
> - サーバー側（ハートビート・旧接続close・sessions競合修正）：pg-mem疑似DB上に
>   migrations 001〜008を適用した実サーバーを起動し、`ws`クライアントで自動テストを実施。
>   同一デバイスIDでの新規接続時に旧接続がcode 4000でcloseされること、旧接続の
>   `close`イベントが遅れて発火しても新接続の`sessions`エントリが誤って削除されない
>   こと（新接続はOPENのまま維持）、pongを返さない接続（`ws.pause()`で意図的に無応答化）
>   がタイムアウト後に`terminate()`され`sessions`から削除されることを確認した
>   （検証はタイムアウト定数のみ2秒/5秒に短縮したテスト用コピーで実施。本番相当の
>   30000ms/90000msはソースコードの直接確認で担保）
> - クライアント側（`public/index.html`）：同じpg-mem疑似DB環境に実際の`index.html`
>   （`API_BASE`のみ本番ではなくローカルサーバーを指すようテスト用コピーで変更）を配信し、
>   claude-in-chromeでブラウザ操作を実施。「応援を終了する」ボタン押下後、
>   サーバーログに新たな`connect`が記録されないこと、および`netstat`でポート4002への
>   ESTABLISHED接続が残っていないこと（TCP接続自体が閉じたこと）を確認し、
>   自動再接続が発生しないことを確認した
> - 検証専用スクリプト・HTMLはリポジトリ外（セッションのスクラッチパッド）に置き、
>   リポジトリには一切コミットしていない
>
> **今回のスコープ外・次回への申し送り：**
> - 実データ（staging/本番DB）・実機での動作確認は未実施（ローカルpg-mem疑似DBのみ）
> - 本番デプロイは未実施。デプロイ時は`src/websocket/index.js`・`public/index.html`の
>   コード反映（`public/index.html`は「デプロイ時の注意」章の2箇所デプロイに注意）のみで、
>   マイグレーション・`.env`変更は不要
> - ファイルディスクリプタ上限は現状（実効1,048,576）で20,000接続規模に対応可能と
>   判断したため、追加対応は行っていない。実際の負荷試験（10章）で想定と異なる結果が
>   出た場合は改めて見直す

> **2026-09-20追記：本番デプロイ実施。** 事前にgitタグ（`main-20260920ver`・
> `feature-reference-data-20260920ver`）および本番DBバックアップ
> （`cheerstick_production_20260920_065628.sql`）を取得したうえで、`src/websocket/index.js`・
> `public/index.html`を本番反映した（マイグレーションなし）。`pm2 restart`後のログに
> エラーは無く、既存API（管理API・静的ファイル配信）の疎通も既存どおり200で応答することを
> 確認した。詳細は`docs/worklog.md`同日エントリ参照。

> **2026-09-20追記：本番デプロイ後、新しい実機（Android端末 moto g53y 5G、
> CheerStick本体、MAC `A4:C1:38:95:77:67`）で実地検証を実施した。** 結果は以下の通り：
> - **(a) 「応援を終了する」ボタンでの明示的close**：正規のボタン操作後、約7分間の観察で
>   自動再接続が発生しないことを実機で確認した（フェーズ3の意図通りの動作）
> - **(b) CheerStick本体の電源OFF（Bluetooth切断）**：WebSocket接続自体には影響が
>   無いことを確認した。Bluetooth層とWebSocket層は独立しており、これは正常な結果で
>   不具合ではない
> - **(c) スマートフォンの機内モード（ネットワーク断）**：約82秒（設定90秒に近い
>   タイミング）でサーバー側が接続を自動検知・切断することを確認した。
>   ping/pongハートビートが実際のネットワーク断シナリオで機能することを実機で実証した
>
> 検証中、terminate実行の瞬間を示すログが存在しなかったため（個々のping/pong自体は
> 意図的に無ログ化していたが、terminate発生時点も無ログだった）、`src/websocket/index.js`に
> `[WS] heartbeat timeout mac=... terminated`の1行ログを追加した（コミット`71bbdee`）。
> 個々のping送信・pong受信は引き続き無ログのままとし、実際にterminateが発生した
> 瞬間のみ記録する設計とした。ローカル・pg-mem環境（タイムアウト定数のみ短縮した
> テストコピー）でログ出力を確認済み。本番デプロイは今回未実施。

## 11.11 CheerStick本体〜アプリ間の接続が原因不明のまま切れる（カウントアップ停止）事象

**事象**：Bluetoothペアリング・チーム/推し選択まで正常に完了し、一度はカウントアップ
（応援量の反映）も機能する状態になるが、**途中で応援量が反映されなくなる**事象が
2026-09-17・2026-09-20の両実機検証で発生している。

**現状の回避策**：アプリを一度終了し、再度起動・再接続することで復旧する。

**サーバー側ログ調査で判明していること（2026-09-20時点）**：
- 事象発生中もWebSocket接続自体は生きたままであることを確認済み（`ss`でESTABLISHED
  状態が継続）
- `count`メッセージ受信に対するエラーログ（`[WS] handler error`）も発生していない
- 本章（11.10）のWebSocket幽霊接続対策（ping/pongハートビート・旧接続close・
  クライアント側close、2026-09-20実装）の不具合ではないと判断している
  （上記の通り接続自体は正常に維持されており、対策導入前から存在していた可能性が高い）

**推定される原因**：上記からサーバー側WebSocket層より手前、具体的には実機の
BLEブリッジ〜ネイティブアプリ間、またはネイティブアプリのWebView連携部分
（`window.onCheerStickData`等、5.2章参照）である可能性が高いと考えられるが、
**本リポジトリの管理範囲外（Vanstone様管轄）であり、現時点で原因は未特定。**

**次回への申し送り**：Vanstone様への確認事項（5.2章のLEDブリッジ未実装の件と
合わせて）に、本事象の再現条件・ログ有無を追加することを検討する。

## 11.12 BLE切断のサーバー記録（`ble_disconnect`、migrations/013、2026-09-29実装・ローカル確認まで）

Vanstone様からの逆質問（「BLE切断の頻度・条件を、サーバー側で集計できないか」）を受けて実装した。
2026-07-25の幽霊接続問題調査時点では「接続の安定性を優先し、後回しにする」という優先順位づけの
判断で意図的に見送られていた（4.4章・935行目参照）が、11.10章の幽霊接続対策（ping/pong・
旧接続close等）が完了したことを受けて、今回対応した。**本番EC2への反映は未実施。**

### クライアント側（`public/index.html`）

`isBleDisconnectPayload()`（変更なし）が真になったとき、既存の
`CheerStickBridge.sendLED({LED:{r:0,g:0,b:0}, stat:'BleRetry'})`に加えて、
WebSocketで`{ type: 'ble_disconnect', id: <mac> }`をサーバーへ送信する。

- **立ち上がりエッジのみ送信**：`bleDisconnectNotified`フラグにより、連続して異常データを
  受信し続けている間（＝BLEが切断されたまま）は最初の1回のみ送信し、正常なペイロードが
  戻ってくるまで再送しない。指示書には明記が無かった判断だが、`window.onCheerStickData`は
  約1秒間隔で呼ばれるため（5.1章）、素直に毎回送信すると1回の物理的な切断につき
  数十件の通知が送られてしまい、Vanstone様が求める「頻度」の集計が意味を持たなくなるため
  追加した
- 送信は既存の`send()`関数（WebSocketが`OPEN`状態でなければ何もしない）をそのまま使うため、
  接続自体が切れている場合は自然に送信がスキップされる（指示書どおり、無理な再接続等は行わない）
- 既存のカウント送信処理（BLE切断時は`return`し以降の処理に進まない設計）は変更していない

### サーバー側

`src/websocket/index.js`に新しいメッセージ種別`ble_disconnect`のハンドラを追加した
（既存の`count`ハンドラと同じパターン）。`id`（MACアドレス）からデバイスを検索し、
選択中チームに`status='live'`の試合があればその`event_id`とあわせて、
`ble_disconnect_logs`テーブル（新規、`migrations/013_add_ble_disconnect_logs.sql`）へ
1件INSERTする。レスポンスは返さない（クライアント側は応答を待たない設計）。
`id`が無い・対応するデバイスが見つからない場合は、エラー応答もせず静かに何もしない
（レスポンス不要のメッセージのため、不正な入力で`{type:'error'}`を送り返す必要は無いと判断）。

```sql
CREATE TABLE ble_disconnect_logs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID        NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    event_id    UUID        REFERENCES events(id) ON DELETE SET NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**記録方式の判断（案A：ログのみ／案B：DB記録）**：**案B（DB記録）を採用した。**
理由：Vanstone様が求めているのは「頻度・条件の傾向」の分析であり、pm2ログ
（`out.log`/`error.log`）はログローテーションで古い分が失われる運用のため、
長期間・大量デバイスにまたがる集計には不向きと判断した。DBテーブルであれば
`docs/runbook.md`のSQL例のとおり任意の期間・条件で集計でき、既存の`cheer_logs`等と
同じ運用（migrationで管理）にも馴染む。実装・確認の手間は案Aよりやや大きいが、
新規テーブル1つ・ハンドラ1ケースのみで収まる範囲だった。

**レート制限（トラックA）の対象外であることの確認**：`ble_disconnect`はWebSocket
経由のメッセージであり、11.10章・12章で確認済みのとおり、`ws`パッケージはHTTPサーバーの
`upgrade`イベントに直接フックしておりExpressのミドルウェアチェーン（レートリミッタ含む）を
一切通らない。したがって`count`・`connect`等の既存WebSocketメッセージと同様、
トラックAのレート制限は一切適用されない（コード変更・追加確認は不要、構造上そうなる）。

### ローカル確認（`scripts/ble-disconnect/local-verify.js`新規、pg-mem＋実サーバー、
実際のWebSocketクライアントで一気通貫確認。8項目、全PASS）

- 選択中チームが無いデバイスからの`ble_disconnect`：`event_id`が`NULL`で1件記録される
- 選択中チーム＋`live`中の試合があるデバイスからの`ble_disconnect`：`event_id`が
  その試合のIDで記録される
- 未登録デバイス（一度も`connect`していないMAC）・`id`が無いメッセージ：
  エラーにならず（ソケットが切断されない）、記録もされない
- `ble_disconnect`に対してレスポンスが送られないこと、サーバー側は重複排除せず
  送られてきた分だけそのまま記録すること（立ち上がりエッジ制御はクライアント側の
  責務という設計どおり）を確認した
- クライアント側の立ち上がりエッジ判定（`bleDisconnectNotified`）は、決定的
  シミュレーション（Node.js、リポジトリ非コミット）で、連続30回の切断ペイロードでも
  送信は1回のみ、切断→復帰→再切断で送信が2回になる、正常ペイロードのみでは
  一度も送信されないことを確認した
- 既存の`scripts/demo/local-verify.js`（27項目）・`scripts/rate-limit/local-verify.js`
  （26チェック）・`scripts/demo/local-verify-demo-mode.js`（29項目）とも
  引き続き全PASS（回帰無し）

集計用SQLクエリ例は`docs/runbook.md`「BLE切断ログの集計例」参照。

---

## 12. 大規模イベント対応：レート制限（トラックA、2026-09-28実装）

背景・調査結果は`docs/proposals/large-event-scaling.md`参照。会場Wi-Fiが1つの公開IPに
集約される想定（8,000〜10,000接続）で、従来の「`/api/v1`全体を同一IPから15分500回」
という単一制限では観客のほとんどが429になるため、ルートを4系統に分けて別々の
リミッターを適用する設計へ変更した（`src/middleware/rateLimit.js`）。

### 12.1 系統

| 系統 | 対象ルート | 制限 |
|---|---|---|
| (a) 観客の入口 | `GET /api/v1/webview/geturl`・`GET /api/v1/webview/reference` | IPごとの上限（既定15分50,000回）＋デバイスごとの上限（既定15分60回）を**両方**適用。デバイスIDは`id`クエリ（MACアドレス）、または`reference`のトークン方式（`ENABLE_REFERENCE_TOKEN=true`時）の`token`から取り出す。IDが無い・16進12桁に正規化できない場合はデバイス側の上限を適用せず、IP側のみ適用する |
| (b) スコア・閲覧系 | `GET /event-battles/:id/score`・`GET /target-scores`・`GET /events/:id/target-scores`・`GET /events/:id/ranking-snapshots/latest` | 別枠のIPごとの上限（既定15分6,000回）＋サーバー側の短時間キャッシュ（既定1,000ms、`src/middleware/scoreCache.js`）。応答が全員同じルートのみ対象。エラー応答（4xx/5xx）はキャッシュしない。同時に届いた同一キーのリクエストは1回の計算を共有する（in-flight共有） |
| (c) 管理API | `/api/v1/admin/*` | 別枠のIPごとの上限（既定15分20,000回、暴走検知用）。nginxのオフィスIP制限（`docs/runbook.md`「管理API アクセス制限」）はそのまま維持 |
| (d) その他 | 上記以外の`/api/v1`（死んだコード・未使用の旧REST等含む）と`/health` | 従来どおりのIPごとの上限（既定15分500回）。`/health`の扱いは変更していない |

### 12.2 環境変数

すべて未設定でも既定値で動く。数値でない・負の値は既定値へ戻り、起動時ログに警告が出る。

| 変数名 | 既定値 | 内容 |
|---|---|---|
| `RL_WINDOW_MS` | 900000（15分） | すべてのリミッターの時間枠 |
| `RL_AUDIENCE_IP_MAX` | 50000 | (a)のIPごとの上限 |
| `RL_DEVICE_MAX` | 60 | (a)のデバイスごとの上限 |
| `RL_SCORE_IP_MAX` | 6000 | (b)のIPごとの上限 |
| `RL_ADMIN_IP_MAX` | 20000 | (c)のIPごとの上限 |
| `RL_DEFAULT_IP_MAX` | 500 | (d)のIPごとの上限 |
| `SCORE_CACHE_TTL_MS` | 1000 | (b)のキャッシュ有効期間（ミリ秒）。`0`で無効 |

起動時に有効な値が1行でログに出る（`[rate-limit] config: ...`、秘密情報は含まない）。

### 12.3 cluster mode（トラックB）との関係

各リミッターは`express-rate-limit`の既定`MemoryStore`（プロセス内メモリ）を使っている。
**pm2 cluster modeで複数プロセスになると、プロセスごとに別々にカウントされるため、
実質の上限は「値×プロセス数」になる。** 共有ストア（Redis等）の導入は未実施（トラックB
の範囲外）。cluster mode化する際は、プロセス数に合わせて上記環境変数の値を調整する
運用とする（`docs/proposals/large-event-scaling.md` B-1参照、同じ制約が
`this.sessions`Mapにも当てはまる）。

### 12.4 429のログ

429が発生すると、リミッター名（`audience-ip`・`audience-device`・`score`・`admin`・
`default`）・IP・（デバイスの場合は）デバイスキーを含むログを1行出す。**同じリミッターの
ログは10秒に1回までにまとめ、その間の件数を添える**（会場で数千件の429が出ても
ログが埋まらないようにするため）。429のレスポンスの形（ボディ・`RateLimit-*`ヘッダー・
`Retry-After`）は変更していない（`express-rate-limit`の既定のまま。ネイティブアプリ・
既存クライアントへの影響を避けるため）。

### 12.5 スコアキャッシュと`gauge=recent`（ゲージの「直近の勢い」表示）の関係

`gauge=recent`（`cheerstick-battle-gauge-recent-20260928.md`で仕様策定、履歴の差分から
勢いを演出する機能）は、本節の実装時点では未実装。設計上の確認として、
**1秒キャッシュにより同じ値が続けて返っても、`gauge=recent`は壊れない**ことを確認済み：
同一値が複数回届いても「履歴の最古との差分が小さすぎる場合は直前のゲージ位置を保持する」
仕様のため、キャッシュヒットで同値が繰り返されるケースは、通常のポーリングで実際の
応援量が一時的に変化しなかったケースと区別できない（同じ入力に対して同じ結果になるだけ）。

### 12.6 応援ログ書き込みモード `CHEER_LOG_WRITE_MODE`（トラックB-①、2026-09-30実装・ローカル確認まで）

`count`1件あたり3回だったDB往復（4.3章）を減らすための切り替え可能な実装。
ブランチ`feature/scale-cheer-log-write`。DBスキーマ変更・依存追加は無い。
**本番未反映。** 効果測定計画は`docs/tasks/2026-09-30-cheer-log-write-measurement-plan.md`。

| 値 | 挙動 |
|---|---|
| `legacy`（既定。未設定・`legacy`/`cached`以外の値も同じ） | 従来どおり。`count`ごとに①`findDeviceWithProfile`②`findLiveEventForOrganization`③`insertCheerLog`の3往復（live試合が無い場合は①②の2往復） |
| `cached` | ①をデバイス情報キャッシュ、②をlive試合キャッシュで置き換える。**live試合あり=1往復（INSERTのみ）、liveなし=0往復** |

起動ログに`[WS] cheer-log-write config: mode=<legacy|cached> device_cache_ttl_ms=60000 live_event_cache_ttl_ms=2000`を1行出す。
`.env`変更後は`pm2 restart cheerstick-server --update-env`（`.env.example`参照）。TTLは固定値で環境変数化していない。

**デバイス情報キャッシュ（接続ごと、TTL 60秒）**
- `ws`オブジェクトに`device_id`・`owner_user_id`・`selected_organization_id`・`current_target_id`の4項目のみ保持（メールアドレス等は保持しない）
- `msg.id`が保持しているidと一致するときだけ使う。未登録デバイス（`findDeviceWithProfile`がnull）はキャッシュしない
- `connect`・`register`・`select_team`・`set_oshi`の処理前後でその接続のキャッシュを破棄する。取得中に破棄された場合は世代番号で古い結果を保存しない
- 旧接続の`close`（幽霊接続対策、11.10章）では接続オブジェクトごと消えるため追加処理なし。新接続は自分のキャッシュ（未取得）から始まる
- 管理画面のデバイス更新（CSV取込・一括適用等、`owner_user_id`等の変更）や、SQL直接変更は即時には反映されず最大60秒遅れる

**live試合キャッシュ（組織ごと・プロセス共通、TTL 2秒）**
- 「その組織に、直近2秒以内に確認した時点でlive試合が有った／無かった」という事実を記憶する（「liveなし」も同様にキャッシュ）。省略されるのは`findLiveEventForOrganization`のSELECTのみで、`insertCheerLog`そのものには関与しない。ただし`insertCheerLog`を呼ぶか・どの`event_id`で呼ぶかの判断材料が最大TTLぶん古くなりうる（下記）
- 期限切れ時は取得中のPromiseを共有し、同時に大量のSELECTが走らないようにする
- `updateEventStatus`・`updateEvent`・`hideEvent`の成功時に、同一プロセス内で**全組織分を即時破棄**する（`updateEvent`で`organization_id`が変わる場合に旧・新の両方が対象になるため）。破棄前に始まって取得中だったSELECTの結果はキャッシュに保存されない
- `ble_disconnect`のlive試合確認（4.2章、11.12章）はキャッシュを使わない（`legacy`と同じ）

**キャッシュが古いことによる影響範囲（ローカルで実際にシミュレーションし確認済み）**
管理画面（`PATCH /admin/events/:id/status`等）経由の変更は即時破棄されるため影響なし。**SQLの直接書き換えなど、破棄をバイパスした場合のみ**：
- `live`になった直後、最大2秒間：その組織のcountが記録されない
- `finished`/`paused`になった直後、最大2秒間：その組織のcountが記録され続ける（旧`event_id`で）
- 影響は**その組織のみ・最大2秒**で、TTL経過後は自動で解消し、試合をまたいで残ることは無い

**cluster mode（トラックB）との関係**
- 即時破棄は**同一プロセス内のみ**有効。pm2 cluster mode化した場合、管理画面のリクエストを受けたワーカー以外には破棄が届かず、他ワーカーはTTL（2秒）が切れるまで古い状態を使う（管理画面経由の変更でも、最大2秒の遅れが発生する）
- デバイス情報キャッシュは接続（`ws`）ごとのため、cluster mode化の影響は受けない

**ローカル確認結果**：`scripts/cheer-log-write/local-verify.js`（pg-mem、35項目PASS）。1countあたりの実測往復数は`legacy`=3（live試合なし=2）、`cached`=1（liveなし=0）。詳細は`docs/worklog.md`2026-09-30「トラックB-①」エントリ参照。

**本番での効果測定結果と採用判断（2026-10-01追記。岩村様の報告に基づく記録）**

上記冒頭の「本番未反映」は2026-10-01時点で解消している（反映手順：`docs/tasks/2026-10-01-rollout-cheer-log-write-mode.md`）。
WebARENA VPSから`battle-demo.js`で、本番EC2（t3.micro）に対し`legacy`/`cached`を同条件で比較した
（各規模3分前後。最大値。`mem_available`は最小値）。

| 規模 | モード | load1最大 | cpu_user最大 | mem_available最小 |
|---|---|---|---|---|
| 各100台 | legacy | 0.27 | 10.4% | 387MB |
| 各100台 | cached | 0.19 | 10.4% | 322MB |
| 各250台 | legacy | 1.41 | 14.4% | 335MB |
| 各250台 | cached | 0.31 | 10.7% | 307MB |
| 各500台 | legacy | 1.79 | 24.6% | 277MB |
| 各500台 | cached | 0.60 | 14.6% | 256MB |

- 送信の成功・失敗：**全規模・両モードで失敗0・サーバーエラー0**（送信件数は各100台で約5,500件、各250台で約14,500件、各500台で約43,900件）
- 各250台・各500台の`cpu_user`平均で約33%低下（手順書の判断基準＝相対20%以上を上回る）。
  各100台は`cpu_user`にほぼ差が出なかった（規模が小さいと効果が見えにくい）
- **判断：効果ありとして`cached`を本番で採用する。** 本番`.env`は既に`CHEER_LOG_WRITE_MODE=cached`に設定済みで、
  コードの追加変更は無い
- 注意：`mem_available`の最小値は`cached`の方が低い値が出ているが（各100台で-65MB、各500台で-21MB）、
  原因の切り分けは行っていない（試験の順序〔`legacy`が先〕による測定時点のベースライン差の可能性があるが未検証）。
  別途の問い合わせが無い限り、メモリ面の影響は「未確認」とする
- 未確認の事項：最大1,000接続の範囲の結果であり、10,000接続（毎秒約2,000件）で`pg.Pool`（max 20）が持つかは
  今回の測定範囲外（`cached`でもINSERTは1メッセージ1回のまま）。今後の検討事項の優先度は
  `docs/proposals/large-event-scaling.md`の変更履歴（2026-10-01）に記録

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
| 2026-09-14 | 9.3に追記：一括「停止」を`live`の行のみに限定する再修正を記録 | 同日の`actionButtonsFor()`ベース判定では、`finished`の試合が「終了を取り消す」と同じ`paused`遷移として一括「停止」の対象に含まれてしまい、「停止」というラベルの意図（live中の試合の一時中断）と実際の挙動（finishedの試合の復活）がずれることが判明。事故防止のため、一括「停止」のみ`actionButtonsFor()`に頼らず現在の状態が`live`の行に限定するよう`bulkChangeStatus()`を再修正した。一括「開始」「終了」は変更なし。個別ボタンの「終了を取り消す」は単発ボタンでのみ実行可能なまま。既存記述は削除せず追記で更新した |
| 2026-09-11 | 11.7に追記：`cheer_logs`0件の本番DB再確認結果を記録 | 前回・前々回セッションでブロックされ続けていた本番EC2へのSSH接続を再試行したところ今回は成功し、`cheerstick_production`へ読み取り専用SELECTで接続できた。`cheer_logs`総行数・`event_id`別内訳とも0件のまま変化なし（2026-08-10時点の記述から約1ヶ月、9/6のB-1/B-2実機検証を挟んでも変化なし）であることを確認。既存記述（2026-08-10時点の「0件」）は削除せず追記で更新した。詳細は`docs/worklog.md`2026-09-11エントリ（本番DB SSH接続の再試行・cheer_logs実データ確認）参照 |
| 2026-09-11 | 「2チーム対抗応援合戦」機能を本番デプロイ（7章のmigration 011記述、8.4・9.3・9.4の「本番未反映」記述に追記、11.8「event_battlesテーブルにcheerstickロールの権限が無い」を新設） | KMT様指示により実機到着前の準備として本番反映を実施。migration 011適用・`git pull`・静的ファイル（`battle.html`含む）反映・pm2再起動・疎通確認まで完了したが、migrationをpostgresスーパーユーザーで実行した副作用でアプリのDB接続ロール（`cheerstick`）に`event_battles`テーブルの権限が付与されておらず、対抗戦関連APIが`permission denied`で失敗する状態であることが判明した。`GRANT`/`ALTER TABLE ... OWNER TO`いずれも権限クラシファイアにブロックされたため、KMT様の手動対応（TeraTerm）が必要な既知の課題として11.8に記録した。既存記述は削除せず追記で更新した。詳細は`docs/worklog.md`2026-09-11エントリ（「2チーム対抗応援合戦」機能の本番デプロイ）参照 |
| 2026-09-11 | 11.8に追記：DB権限問題の解消確認を記録 | KMT様がTeraTermで`ALTER TABLE event_battles OWNER TO cheerstick;`を実行。Claude Code側でスコアAPI・管理API一覧取得の200/404応答、実際のテスト行INSERT→スコア取得→DELETEの一連の流れを権限エラーなく確認し、対抗戦機能が本番で使用可能になったことを11.8章に追記で記録した。既存記述（問題発生時点の記録）は削除せず残した。詳細は`docs/worklog.md`2026-09-11エントリ（`event_battles`権限修正の解消確認）参照 |
| 2026-09-13 | 9.5「管理画面のランチャー方式への再構成」を新設 | `public/admin/index.html`（試合管理・対抗戦・チーム管理・デバイス管理が同居する1,468行の単一ファイル）を、ランチャー（index.html）＋events.html（試合・対抗戦）＋masters.html（チーム・デバイス）＋共通ファイル（common.css/common.js）の構成に再編した。8.0・8.1・8.2・8.3・8.4・9.3節が説明する機能自体（バックエンドAPI・DB）に変更は無く、フロントエンドのファイル分割のみ。既存記述は削除せず、現在の参照先を9.5にまとめた。ローカルの静的ファイルサーバーによる表示・遷移・コンソールエラー無しの確認までで、staging DBに接続した実データでの動作確認・本番デプロイは未実施（KMT様指示により今回の対象外）。nginxのIP制限（本番の実ファイルを読み取り専用で確認済み）は追加設定なしで新規ファイルにも適用される見込みであることを確認した |
| 2026-09-13 | 9.5に追記：events.htmlでのチーム一覧の自動再取得（pageshow対応）を記録 | masters.htmlでチーム登録後、ブラウザの「戻る」でevents.htmlに戻ってもbfcache復元によりスクリプトが再実行されず、試合登録フォームのチームプルダウンが更新されない問題への対処として、`window.addEventListener('pageshow', () => loadOrganizations())`をevents.htmlに追加した。新規API・設計変更は無い。ローカルの擬似APIサーバーで、pageshow未発火時はプルダウンが更新されないこと、`pageshow`イベント発火時（bfcache復元時にブラウザが実際に発火させるものと同一）に試合登録フォーム・編集モーダル双方のチームプルダウンが最新化されることを確認した。既存記述は削除せず追記で更新した |
| 2026-09-13 | 9.5に追記：staging DBでの実データ動作確認結果を記録、11.9「staging DBにmigration 011が未適用」を新設 | KMT様がSSHトンネルを確立したstaging DBに接続し、3ページ（index.html/events.html/masters.html）を実データで確認した。events.htmlの試合一覧・新規登録・編集・個別状態変更・一括操作（対象外スキップ・部分成功含む）、masters.htmlのチーム一覧・編集・新規登録、デバイス一覧・単体登録・CSV取込・一括適用がいずれも正常動作することを確認。pageshow修正も実データ環境で再確認した（実際のブラウザ戻る操作は自動化環境の制約で不可のため前回同様pageshowイベント発火による検証）。一方、staging DBに`migrations/011_add_event_battles.sql`が未適用で`event_battles`テーブルが存在せず、対抗戦関連機能の実データ確認ができなかったため11.9章に新規課題として記録した（本番の11.8章とは別問題、修正は未実施）。検証用に新規登録したチーム2件・デバイス2件はUI上に削除手段が無いためstaging DBに残存している旨、およびデバイス一括適用の誤操作で既存デバイス2件のデモ機フラグを一時的に変更したが直後に復元した旨も記録した。既存記述は削除せず追記で更新した |
| 2026-09-13 | 11.9に追記：staging DBへのmigration 011適用完了・対抗戦機能の実データ確認結果を記録、runbook.md「staging環境マイグレーション適用時の注意」に追記 | 本番（11.8章）の所有者問題（`sudo -u postgres`経由が原因）を踏まえ、staging DBでは`.env`のアプリ接続ロール（`cheerstick_stg`）自身で`migrations/011_add_event_battles.sql`を1文ずつ実行する方法に変更した（接続ロール自身が新規テーブルを作成すればそのロールが所有者になるため、所有者不一致が原理的に発生しない）。適用前に`cheerstick_stg`のCREATE権限・schema_migrations適用状況・テーブル未存在を読み取り専用で確認したうえで実行し、適用後に所有者一致（`cheerstick_stg`）を確認した。`OWNER TO`等の所有者変更操作は行っていない（指示どおり）。events.htmlから対抗戦ペアの登録・一覧・公開スコアAPIまで実際にUI操作で確認し権限エラーが無いことを確認、確認後に削除し原状回復した。`schema_migrations`への適用記録（INSERT）は今回実施しておらず次回判断とする旨を明記した。runbook.mdの既存の所有者問題節（`ALTER TABLE`が対象）には、`CREATE TABLE`はこの問題の対象外である旨を追記した。既存記述は削除せず追記で更新した |
| 2026-09-13 | 11.9に追記：schema_migrationsへのmigration 011適用記録を追加した旨を記録 | KMT様指示により、staging DBの`schema_migrations`テーブルへ`011_add_event_battles.sql`の適用記録を追加した。`src/db/migrate.js`が実際に使用しているINSERT文（`INSERT INTO schema_migrations (filename) VALUES ($1)`、`applied_at`はデフォルトの`NOW()`）と同じ形式・パラメータ渡しで実行し、既存001〜010のレコード形式（カラム構成・値の入れ方）と一致させた。追加後`SELECT * FROM schema_migrations ORDER BY filename`で001〜011が適用順に揃っていることを確認した。これにより次回`node src/db/migrate.js`をstaging DBに対して実行しても011は`SKIP`され再適用エラーは発生しない。既存記述は削除せず追記で更新した |
| 2026-09-13 | 8.5「管理API：選手・推し対象（targets）登録・編集・削除」・8.6「チーム別・選手別の応援集計API」・9.6「管理画面：選手・推し対象管理」・9.7「応援ランキング画面」を新設 | KMT様指示により「選手データ管理UI」「チーム別・選手別の応援集計画面」を実装。フェーズ0（実装前調査）で、targets.typeの決め打ち判定はORDER BY (type='mascot')と表示ラベル分岐2箇所（`public/index.html`）のみで実装の妨げにならないこと、devices.current_target_id・cheer_logs.target_idの外部キーがいずれもON DELETE SET NULLであること、public/index.htmlに「チーム選択→推し選手選択」UIが既に完全実装済みであること（WebView側の追加実装は不要）を確認し、想定外の問題は無かったため実装に進んだ。バックエンドは既存のorganizations管理API（8.3章）と同じパターンで`GET/POST/PATCH/DELETE /admin/targets`を新設（マイグレーション無し、既存列のみ使用）、DELETE時はdevices.current_target_id・cheer_logs.target_idの参照有無をアプリ層で事前確認し409 TARGET_IN_USEでブロックするガードを実装（11.7章と同種の孤児レコード化を防ぐため）。集計APIは`GET /events/:id/target-scores`・`GET /target-scores`をevent_battlesスコアAPI（8.4章）と同じ設計方針（認証追加なし、SUM集計）で新設。フロントエンドは`public/admin/targets.html`（masters.htmlと同じ構成）、ランチャーへのリンクカード追加、`public/target-report.html`（battle.htmlと同じ認証方針・ポーリング方式、タブで「試合ごと」「全期間通算」を切替）を新設。staging DBに接続したローカルサーバーで、CRUD・削除ガード（デバイス参照・cheer_logs参照の両経路）・集計API（試合ごと・全期間通算）・フロントエンドの一連の操作を実際に確認し、確認用データはすべて削除・非表示化して原状回復した（削除APIの無いデバイス1件を除く）。本番デプロイは未実施（KMT様指示により今回の対象外）|
| 2026-09-16 | 6章「マルチスポーツ対応（新ジャンル追加）について」に追記、8.7「管理API：ジャンル（categories）登録・編集」・8.8「画像アップロードAPI」・9.8「管理画面：ジャンル管理UI」・9.9「画像アップロードUI」を新設 | KMT様指示による「管理画面の改善3件」（ジャンル管理API/UI、ロゴURL欄のデプロイ確認、画像アップロード機能）を実装。フェーズ0（前回セッションの調査で「masters.htmlにロゴURL入力欄が無い」との認識だった点を、本番`/var/www/cheerstick-admin/masters.html`とリポジトリのdiffで再確認したところ差分無し、ブラウザキャッシュが原因と判断）はコード変更なし。フェーズ1（ジャンルCRUD）はorganizations管理API（8.3章）と同じパターンで実装、categories.slug列（NOT NULL UNIQUE・アプリコード未参照）はUI非公開のままサーバー側自動生成とした。フェーズ2（画像アップロード）はmulter（メモリストレージ・5MB上限）を新規導入し、拡張子とマジックバイトの両方を検証したうえでUUIDファイル名でUPLOAD_DIR（本番は/var/www/cheerstick-app/images/uploads/）へ保存するAPIを新設、既存のURL直接入力方式は置き換えつつ既存のcreate/update送信処理自体は変更しない設計とした。本番nginx（cheerstick-api）へのclient_max_body_size追加・uploads/ディレクトリ作成は実施済み（詳細はdocs/runbook.md参照）。コード本体（アプリケーション・管理画面）の本番デプロイは今回対象外（ローカル・pg-mem疑似DBによる動作確認まで）。詳細はdocs/worklog.md該当日エントリ参照 |
| 2026-09-17 | 8.3に追記：`organizations.color`設定APIを追加、9.10「管理画面：チームカラー設定UI」を新設 | KMT様指示により、migration 007（2026-07-31）で追加済みながら未使用のまま残っていた`organizations.color`列を、管理API（`POST`/`PATCH /admin/organizations`への`color`パラメータ追加、HEX形式`/^#[0-9A-Fa-f]{6}$/`のバリデーション、不正時400 `INVALID_COLOR_FORMAT`）と`masters.html`のUI（カラーピッカー⇔HEXテキストの双方向同期、一覧のカラースウォッチ列）から設定可能にした。空文字・未指定は既存動作を変えない（更新時は値を変更しない、新規登録時はNULLのまま）方針とした。実装中に`disabled`ボタンの見た目が通常時と区別できないことに気づき、`common.css`に`button:disabled`のスタイルを追加した（他の`disabled`ボタン全般に影響する副次的な改善）。ローカル・pg-mem疑似DBによるAPI（バリデーション正常系・異常系）とブラウザ操作（双方向同期・エラー表示・一覧反映）の確認まで完了。本番デプロイは今回対象外（KMT様指示）。詳細はdocs/worklog.md該当日エントリ参照 |
| 2026-09-17 | 11.7に追記：cheer_logsが0件だった原因の特定・解消を記録、8.4に追記：対抗戦スコア表示の実データ確認を記録 | 実機（CheerStick本体・Androidアプリ、MAC A4:C1:38:D1:C5:6E）を用いた4回目の接続テストで、docs/verification-checklist-hardware.md項目1の手順に沿い、cheer_logsが0件だった原因（デバイスのcategory_id未設定、対象イベント未live化の2点）を特定・解消し、cheer_logsへの書き込みを初めて実機で確認した。あわせて対抗戦スコア表示（項目2）・通算応援量表示（項目4）を実データで確認した。既存記述は削除せず追記で更新した。詳細はdocs/worklog.md 2026-09-17エントリ参照 |
| 2026-09-17 | 4.4・5.2に追記、11.10「WebSocketの接続が正しくクローズされず残る場合がある（幽霊接続）」を新設 | 実機接続テスト中の監視で、同一デバイスの再接続時にサーバー側WebSocket接続が一時的に2件並存する事象、および「応援を終了する」ボタン押下後も接続が残り続ける場合がある事象を発見。コード調査により、新規接続時に旧接続を明示的にcloseする処理が無いこと（src/websocket/index.js:164）、close時のクリーンアップがTCP接続自体を閉じないこと（281-285行目）、ping/pongハートビート未実装（4.4章の既知課題と一致）、public/index.htmlの終了ボタンがWebSocketをcloseしない設計であることを確認し、11.10章に新規課題として記録した。あわせて5.2章にLED制御ブリッジの実機再確認結果を追記した。対応案（旧接続の明示的close、ping/pong実装）は今回未実装。詳細はdocs/worklog.md 2026-09-17エントリ参照 |
| 2026-09-17 | 10.1「実機接続1本使用時のAWS負荷基準値」を新設 | 実機接続1本使用時の本番EC2（t3.micro）の負荷状況（CPU・メモリ・ディスク・PostgreSQL接続数）を計測し、2,000〜20,000本規模の商用リリースに対するメモリ制約のリスクを所見として記録した。詳細はdocs/worklog.md 2026-09-17エントリ参照 |
| 2026-09-17 | 6章に追記：デバイス量産・ジャンル運用方針の決定を記録 | KMT様より、2,000本のMACアドレス一括登録（Jリーグ単独契約前提）が契約白紙のため見送りとなり、契約が決まった分から順次ジャンルを作成しCSV一括取込で割り当てる新方針への転換を共有された。あわせて、デバイスのcategory_idによるチーム絞り込みがサーバー側SQLで堅牢に実装済みであることの確認結果（既存の6.2・8.5章の内容）を、本方針決定の根拠として追記した。既存記述は削除せず追記で更新した。詳細はdocs/worklog.md 2026-09-17エントリ参照 |
| 2026-09-24 | 7章のmigration一覧に訂正を追記（012はstaging適用済み）、8.9「管理API・閲覧API：順位確定機能」を新設 | Phase 4（画面実装）着手前の現状確認で、2026-09-23セッションが`/handover`未実行のまま終了しており、当該セッションで実装された順位確定機能バックエンド（Phase 1〜3、コミットceca327〜18e797f）がspec.mdに一切仕様化されていなかったことが判明した（7章のmigration一覧への言及のみ）。あわせて、その一覧記載「staging・本番とも未適用」も誤りで、stagingには既に012が適用済みであることを確認した。既存記述は削除せず、8.9章を新設してAPI仕様を正式に記録し、7章には訂正を追記した。POST/GETでレスポンスのキー命名規則（snake_case/camelCase）が異なる実装上の癖も明記した |
| 2026-09-24 | 9.11「順位確定機能の画面」を新設 | 8.9章のバックエンドに対するPhase 4（画面実装）を実施。`public/admin/ranking-control.html`（イベント選択＋確定ボタン＋結果表示＋会場スクリーンURL欄）、`public/ranking-user.html`・`public/ranking-target.html`（`battle.html`のデザイン言語・3秒ポーリング方式を踏襲した会場スクリーン、rankingTypeのみ異なる）を新設し、管理画面ランチャーに導線を追加した。staging DBに接続した一時ローカルサーバー（リポジトリ非コミット）とclaude-in-chromeによるブラウザ確認で、ボタンの状態別表示切り替え、確定操作の正常系・エラー系、同順位表示、未確定時の待機表示を確認した。確認用データはすべて削除・原状回復した。静的ファイルのstaging/本番デプロイ、`ranking-target.html`の確定結果表示の個別確認は未実施のまま残した |
| 2026-09-25 | 8.4に追記：対抗戦テーマ画像機能を記録、9.4に追記：battle.htmlのテーマ画像表示・綱引きゲージ変更を記録 | KMT様指示書（対抗戦のイベント別テーマ画像対応・綱引き式ゲージへの変更）に基づき実装。Phase 0調査で`events.metadata`が完全未使用であること、既存の画像アップロード機能（8.8章）がそのまま流用できること、`getEventBattleMeta()`のSQLが`events.metadata`列を一切SELECTしていないことを確認し報告、KMT様承認を得てPhase 1へ着手した。`events.metadata.themeImageUrl`に保存する設計のため、対抗戦（1画面2イベント）でどちらの画像を採用するかは指示書に明記が無く、試合A優先・試合Bフォールバックとする判断をKMT様へ報告して実施した。staging DB（KMT様がTeraTermで確立したSSHトンネル経由）に接続したローカルサーバーで、画像アップロード機能単体（正常系・拡張子偽装・ファイル無し）、テーマ画像の設定・解除・フォールバック、綱引きゲージの比率表示（0:0固定・750:250）をAPI・claude-in-chromeによるブラウザ確認の両方で確認した。確認中、テーマ画像の高さに上限が無いと極端なアスペクト比の画像でレイアウトが崩れる不具合を発見し`max-height`制約を追加して修正した。確認用データ（試合2件・対抗戦ペア1件）はすべて削除・非表示化して原状回復した。本番デプロイ（画像アップロード機能の本番反映を含む）は未実施のまま次回に持ち越し |
| 2026-09-26 | 9.4に追記：battle.htmlのレイアウト調整（画像拡大・順序変更・ゲージ全幅化・配色中間化・カウンター縮小）を記録 | KMT様指示書（対抗戦画面のデザイン調整）に基づき実装（コミット`cb03903`）。ゲージ配色は45%/60%/75%ミックスの3候補を提示しKMT様の承認（75%）を得てから実装した。このセッションではstaging DBへのSSHトンネルが確立できず、リポジトリ非追跡の一時モックページでの見た目確認に留まった。staging実データでの確認・スマートフォン幅での崩れ確認は未実施のまま次回に持ち越し。詳細はdocs/worklog.md 2026-09-26エントリ参照 |
| 2026-09-26 | 9.4に追記：staging実データ確認・ゲージ追加太さ調整（56px）・本番デプロイ完了を記録 | KMT様がSSHトンネルを確立し、staging実データ確認（EMUTTO vs J SPORTSは実際には本番の恒久デモデータでありstagingには無いことが判明）を実施。KMT様からのスマホ幅ゲージ崩れの報告は調査したがコード上再現条件が見当たらず、本番デプロイ未実施状態での確認だった可能性を報告し、KMT様の判断で別タスクへ先送りとした。ゲージ太さの追加要望（40px→56px）のみ先に対応し、承認を得て`git push`・本番EC2への反映（コミット`55eff67`）まで完了した。詳細はdocs/worklog.md 2026-09-26「続き」エントリ参照 |
| 2026-09-26 | 9.4に追記：スマートフォン幅懸念の解消確認（セッション終了記録） | 本番デプロイ完了後、KMT様がスマートフォンで改めて確認し、デスクトップと同じ「画像→ゲージ→カウンター」の順序で正しく表示されることを確認。原因はpush・本番デプロイ前の旧コードを見ていたことによる混同で、コード自体に画面幅依存の順序切り替え機構は存在せず、追加修正は不要と確定した。詳細はdocs/worklog.md 2026-09-26「セッション終了記録」エントリ参照 |
| 2026-09-28 | 第12章「大規模イベント対応：レート制限（トラックA）」を新設 | `docs/proposals/large-event-scaling.md`の調査結果を受け、会場Wi-Fiが1つの公開IPに集約される想定（8,000〜10,000接続）に向けたレート制限の再設計を実装（ブランチ`feature/rate-limit-large-event`）。ルートを4系統（観客の入口・スコア閲覧系・管理API・その他）に分け、系統ごとに別のリミッター・環境変数・（スコア系のみ）短時間キャッシュを適用した。DBスキーマ変更・依存追加は無し。本番未反映（手順書は`docs/tasks/2026-09-28-rate-limit-deploy.md`） |
| 2026-09-30 | 12.6「応援ログ書き込みモード`CHEER_LOG_WRITE_MODE`（トラックB-①）」を新設 | `count`1件あたり3回のDB往復を減らす切り替え可能な実装（既定`legacy`＝従来どおり、`cached`＝デバイス情報の接続ごと60秒キャッシュ＋live試合の組織ごと2秒キャッシュ）。DBスキーマ変更・依存追加なし。ローカル（pg-mem）で往復回数の削減・キャッシュの古さの影響範囲（最大2秒・当該組織のみ）・管理画面経由の即時破棄を確認。本番未反映 |
| 2026-10-01 | 12.6の「本番未反映」状態の更新（追記のみ）：`feature/scale-cheer-log-write`を`feature/reference-data`へマージ済み（`ea833ad`）、本番反映・負荷試験の手順書を`docs/tasks/2026-10-01-rollout-cheer-log-write-mode.md`に作成 | 2026-09-30は「マージ・本番反映しない」方針だったが、KMT様の2026-10-01指示書により、`.env`未設定なら動作不変（既定`legacy`）の状態でマージし、本番でlegacy/cachedを負荷試験で比較する方針に変更された。12.6章の既存記述（「本番未反映」等）は削除せず残す。本番反映・負荷試験は岩村様がTeraTermで実施予定で、本記載時点では未実施（本番は`28dc9c3`のまま） |
| 2026-10-01 | 12.6に追記：本番でのlegacy/cached比較測定の結果と`cached`採用の判断を記録 | WebARENAからの負荷試験（各100・250・500台）で、`cached`は各250台・500台の`cpu_user`平均が約33%低下（基準の20%以上を超過）、送信失敗・サーバーエラーは全規模で0だったため、効果ありとして本番`.env`の`CHEER_LOG_WRITE_MODE=cached`を採用。コード変更なし。数値は岩村様の報告に基づく記録。12.6章の既存記述は削除せず追記のみ |
| 2026-10-01 | 9.13「ゲージ火花演出`fx=spark`（デモモードのみ）」を新設 | KMT様指示書に基づき、`battle.html`に火花・光・揺れの演出（`gauge=recent`＋`fx=spark`のときのみ）を追加し、管理画面「デモモード」枠にON/OFFチェックボックスを設置。対抗戦ペア登録（実機）への対応は見送り（デモモードのみとするKMT様判断）。既存記述の変更・削除なし |
| 2026-10-01 | 9.4・9.13に追記：`gauge=recent`のゲージ縦幅2倍・グラデーションの`gauge=recent`全般への適用、火花の上下両方向化 | KMT様指示書（見た目調整）に基づく。実機の本番イベント画面（`gauge=recent`付き）の見た目にも影響することをKMT様が確認済み。既存記述の変更・削除なし（9.13の「`fx`有効時のみバー色」は追記で現行を明記） |
