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

**事前ホワイトリスト方式に確定済み**（初期案の「WebViewでチーム選択」「出荷検査時間帯の
自動登録」の2案は不採用。史的経緯としてPDF仕様書を参照）。

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

### 4.2 メッセージ種別

| type | 内容 |
|---|---|
| `connect` | 接続確立 |
| `set_name` | 名前設定 |
| `set_oshi` | 推し選手設定 |
| `count` | 応援量送信（後述） |
| `broadcast` | 試合状態通知（stat: start / stop） |
| `select_team` | チーム選択（CATEGORY_MISMATCH検証あり／※生存確認要） |

### 4.3 応援量カウント（2026-07-23 実装）

```
{ type: "count", id, value, duration_ms }

判定ロジック：
  デバイスの選択中チーム(organization)に status='live' の試合がある
    → cheer_logs へ記録（公式記録、通算応援量に反映）
  無い場合（scheduled / paused / 試合なし）
    → DB保存はスキップ（画面上のその場限り表示のみ。練習・動作確認用）
```

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
```

### events.status

CHECK制約により以下のみ許可：`scheduled` / `live` / `paused` / `finished` / `cancelled`

## 8. REST API

```
PATCH /api/v1/admin/events/:id/status
  body: { status }
  ⚠️ 認証なし。本番公開前に認証必須。現状は誰でも試合状態を操作できる。
     URLを外部に一切共有しないこと。
```

## 9. フロントエンド（public/index.html）

```
画面フロー：
  完了画面(welcomeCard) → [START] → 応援中画面(cheeringCard) → [終了] → 完了画面

応援中画面の表示：
  ✅ 応援量カウント（試合中の累計）
  ✅ 電池残量表示（volt <= 3.0V で「電池残少」）
  ❌ LEDカラープレビュー（グッズ自体が光るため不要との方針）
  ❌ 試合状態(stat)表示（不要との方針）

チームカラーは team.color（APIレスポンス）を --team-color CSS変数と
LED色計算の両方に反映（以前は固定値ハードコードだった）
```

### 未対応

- BLE切断時のサーバー通知（`type: "ble_disconnect"`）は見送り。クライアント側表示のみ
- 実機（ネイティブアプリ）での動作テストはVanstone側ブリッジ実装完了後でないと不可

## 10. 未実施の検証

**2,000〜20,000本規模の負荷試験は一度も実施していない。**
現構成は1台のEC2上でREST API・WebSocketを単一プロセスが処理し、PostgreSQLも同居。
リリース前に以下の確認が必要：

- 同時接続数を段階的に上げた際のメモリ / FD / CPU 挙動
- `count` メッセージが毎秒×接続数ぶんDBへ向かう際の詰まり（バッチINSERTの要否）
- nginx `proxy_read_timeout` の妥当性
- pm2 インスタンス数とEC2インスタンスタイプの妥当性
- 最悪時のスケールアップ手順（インスタンスタイプ変更＋再起動）の事前準備

---

## 変更履歴

| 日付 | 変更内容 | 理由 |
|---|---|---|
| 2026-07-25 | 初版作成 | handover v14 および監査結果を統合。以後はこのファイルを正本とする |
| 2026-07-25 | 第6章（カテゴリー機能）を「生存確認が必要」から「実装済み」へ更新 | コードリーディングにより、categoriesテーブル・listOrganizations(categoryId)・computeStatus()のcategory_id必須チェック・setDeviceOrganizationのCATEGORY_MISMATCH検証の4点が現行コードに存在し、実装コミットd75d8f1以降削除されていないことを確認。本番DBへのmigration 004適用状況のみ未確認として残す |
| 2026-07-25 | 3.3の再有効化手順に「REFERENCE_TOKEN_SECRETの再生成」ステップを追加 | コードレビューで`reference_url`（WebSocket connect応答・REST /webview/reference）が既に実装済みであることを確認。有効化時に本番の秘密鍵をローテーションする運用が未文書化だったため、実行はせず手順のみ記録。現在の`REFERENCE_TOKEN_SECRET`の値は一度チャットへ露出したため、必ずローテーションする旨を理由として明記 |
