# CheerStick Server — 引継ぎドキュメント（v10・統合版）

作成日：2026年7月22日
（このファイルはGitで管理されている正式な引継ぎドキュメントです。以降はこのファイル1本を更新していく運用とします）

---

## プロジェクト概要

| 項目 | 内容 |
|---|---|
| リポジトリ | cats777jp/cheerstick-server（Private） |
| 本番サーバー | AWS EC2（稼働中） |
| 開発・検証環境 | Render.com（過去に使用。現在は本番稼働のためロール終了、後述） |
| 主要技術 | Node.js / Express / PostgreSQL / WebSocket |

---

## ビジネス背景

- 応援グッズ（ジャイロセンサー＋マイコン内蔵）をBLEでスマホと接続
- ペンライトを振ることで「誰が・どの選手を・どのくらい応援したか」を数値化
- 応援熱量を可視化し、試合MVP・月間MVP・年間MVPなどの体験を提供
- 初期: Jリーグ（V・ファーレン長崎）、将来: 各種スポーツ・エンタメへ展開
- 収益モデル: **応援グッズ販売がメイン**（13,000本で初期投資相殺）、2ndステップでAPI提供
- グッズは**ジャンル（スポーツ）単位で販売される**ため、MACアドレスの時点でカテゴリー（Jリーグ／Vリーグ等）が確定している前提（詳細は本ドキュメント末尾「カテゴリー機能」参照）

---

## システム構成

```
BLEスティック最大2000本（将来20000本）
  → Bluetooth →
スマホアプリ（ネイティブ）
  → JavaScriptブリッジ →
WebView（振動計算・LED制御・SPA、public/index.html）
  → WebSocket/HTTPS →
KMT管理サーバー（Node.js + Express、AWS EC2上で稼働）
  ├─ WebSocketサーバー（wss://ws.cheerstick.com/cheer）
  ├─ REST API（geturl等、api.cheerstick.com）
  ├─ MACアドレスによるHTTPリダイレクト
  └─ PostgreSQL（EC2上に直接インストール）
       ├─ 1stステップ: 管理ダッシュボード
       └─ 2ndステップ: 企業向けAPI提供
```

---

## 管理体制

| 項目 | 担当 |
|---|---|
| サーバー・インフラ・ドメイン・SSL | KMT単独管理 |
| アプリ開発 | サーリューション（国内協力会社） |
| デバイス開発 | ヴァンストーン（国外・中国） |
| MACリストのカテゴリー振り分け | KMT（入荷ロット単位で判別・付与） |

障害時フロー:
- アプリ系: KMT → サーリューション → ヴァンストーン
- サーバー系: KMT単独で収束

---

## ロードマップ・進捗

### ✅ 完了：Render.com 開発・検証フェーズ
- DB設計確定（13テーブル、後にカテゴリー機能で14テーブルに拡張）
- マイグレーション作成・適用
- Render.comでの初期検証

### ✅ 完了：AWS本番環境への移行
- EC2インスタンス構築、PostgreSQL直接インストール
- `api.cheerstick.com` / `app.cheerstick.com` / `ws.cheerstick.com` すべてSSL込みで稼働中
- geturl・WebSocket本実装（チーム選択・推し選択フロー含む）
- V・ファーレン長崎ロゴ／ヴィヴィくん画像の本番配置
- ユーザー登録フロー3段階（register→select_team→set_oshi）の実装・本番反映
- **カテゴリー（ジャンル）機能の追加**（2026-07-22、詳細は末尾セクション参照）

### ⬜ 未完・今後の作業
- 選手データの実データ化（現状サンプル選手A/B/Cのプレースホルダー）
- CSVインポート機能（MACリスト・選手データの一括投入、category_id列対応含む）
- Grafana設定（監視・可視化）
- devicesController.jsの既存バグ修正（存在しないlocationカラム参照、実害なし）
- cheerstick-api（旧プロセス）の完全削除（新環境の安定稼働確認後）
- Vanstoneへの正式返信（geturlエンドポイントの本番URL確定について。未実施の場合は最優先）
- admin.cheerstick.com（Grafana等用、優先度低）

### 本番リリース目標
- 2026年8月第1週：V・ファーレン長崎での商用リリース

---

## 現在の本番環境情報

```
EC2インスタンス：i-04576698e7325bddb（18.179.62.192）
稼働プロセス（pm2）：
  ├── nginx（80/443番、api/app/ws すべてのリバースプロキシ）
  ├── cheerstick-server（PM2管理、ポート3000、REST API + WebSocket統合プロセス）
  │     稼働ディレクトリ: /home/ubuntu/cheerstick-server-new
  └── cheerstick-api（停止中、ロールバック用に残置。安定稼働確認後に削除予定）

ドメイン・SSL：
  ├── api.cheerstick.com  ✅稼働中（geturl、Let's Encrypt SSL）
  ├── app.cheerstick.com  ✅稼働中（WebView本体、Let's Encrypt SSL）
  ├── ws.cheerstick.com   ✅稼働中（WebSocket、Let's Encrypt SSL、2026-10-19まで有効）
  └── admin.cheerstick.com ⬜未設定（Grafana等用、優先度低）

PostgreSQL：EC2上に直接インストール（RDSではなく最小コスト構成）
  DB: cheerstick_production / ユーザー: cheerstick
  バックアップ: 本番マイグレーション適用前にpg_dumpを取得する運用
  （例: ~/db_backups/cheerstick_production_pre_XXX_YYYYMMDD_HHMMSS.sql）
```

**インフラ運用上の制約：** このEC2環境にはAWS CLIと`gh`（GitHub CLI）が入っていない。Route53のレコード追加とGitHubのPublic/Private切替は、今後も手動対応が必要（もしくは、次回までにAWS CLI・gh CLIをEC2/ローカルにインストールしておくと自動化できる）。

---

## ローカル環境（Windows 11 Pro）

| 項目 | 内容 |
|---|---|
| 作業フォルダ | C:\Projects\cheerstick-server |
| Node.js | v26.3.0 |
| Claude Code起動 | `cd C:\Projects\cheerstick-server` → `claude` |
| Claude Code終了 | `/exit` または Ctrl+C を2回 |

⚠️ Render.comは開発・検証専用として使用していたもの。現在の本番運用はAWS EC2。Render.com DBの期限管理は現時点では本番運用に影響しない（本番はAWS上で完結しているため）。

---

## DB設計

### マスター系

| テーブル | 概要 |
|---|---|
| users | メール認証・OAuth（Google等）両対応 |
| devices | MACアドレスで一意識別。`category_id`（カテゴリー）、`selected_organization_id`（選択チーム）、`current_target_id`（選択推し）、`preset_organization_id`（将来拡張用・チーム専用グッズ対応）を保持 |
| organizations | チーム・リーグ・プロダクション等。`category_id`で所属カテゴリーを持つ |
| categories | カテゴリー（ジャンル）マスタ。例: Jリーグ、Vリーグ（2026-07-22追加） |
| venues | スタジアム・ホール等の会場 |
| targets | 応援対象（選手・チーム・アーティスト等）汎用管理 |
| events | 試合・コンサート等。同時刻の複数イベントを許容 |
| event_targets | イベント×応援対象の中間テーブル |

### トランザクション系

| テーブル | 概要 |
|---|---|
| cheer_logs | 応援生ログ（原票データ） |
| cheer_summaries | 応援集計（イベント×ターゲット×ユーザー単位） |
| awards | ランキング・アワード結果 |
| user_target_follows | ユーザーの応援対象フォロー |
| device_event_sessions | デバイス接続セッション・通信品質ログ |

### 設計方針
- 汎用設計（Jリーグ以外のスポーツ・エンタメにも対応）
- ENUMではなくVARCHARでtype管理（柔軟性のため）
- JSONB活用（targets.metadata, events.metadata, cheer_logs.raw_sensor_data）
- schema_migrationsテーブルで適用追跡（二重適用防止）

**シードデータ（本番投入済み）：**
```
categories: Jリーグ（id: 10000000-0000-0000-0000-000000000001）
organizations: V・ファーレン長崎（id: 00000000-0000-0000-0000-000000000001、category_id: Jリーグ）
targets:
  ヴィヴィくん・マスコット（id: ...101、実写真あり）
  サンプル選手A（id: ...102、背番号7、写真なし＝アバター表示）
  サンプル選手B（id: ...103、背番号10、写真なし＝アバター表示）
  サンプル選手C（id: ...104、背番号1、写真なし＝アバター表示）
```

---

## geturlエンドポイント

```
GET https://api.cheerstick.com/api/v1/webview/geturl?id={MACアドレス}
→ HTML（meta refresh）でWebView URLへリダイレクト（Vanstone確定仕様どおり）
実装場所：src/controllers/webviewController.js（本番稼働中）
```

---

## WebSocketプロトコル（現在の最新版）

```
接続先：wss://ws.cheerstick.com/cheer （本番稼働中）

status: "unregistered" | "team_selection" | "player_selection" | "complete" | "error"

1. connect
   HTML → Server: { type: "connect", id }
   Server → HTML: {
     type: "connect",
     status,
     user,         // { name, email } | null
     team,         // { id, name, logo_url } | null（選択済みチーム）
     member,       // { id, name, type, image_url, number, metadata } | null（選択済み推し）
     teams,        // status="team_selection"のときのみ。該当カテゴリーのチーム一覧
     targets,      // status="player_selection"のときのみ。選択肢一覧
     message       // status="error"のときのみ。ユーザー向けエラーメッセージ
   }

   ★category_idが未設定のデバイスは、他の判定より優先して status: "error" を返す
     （connect時のみでなく、常にこのチェックが最優先）

2. register
   HTML → Server: { type: "register", id, name, email }
   → email形式が不正な場合は { type: "error", message } を返す
   → チーム・推しの自動割当はしない

3. select_team
   HTML → Server: { type: "select_team", id, organization_id }
   → チームを変更した場合、推し選択は自動的にリセットされる
   → 選択されたorganization_idがデバイスのcategory_idと一致しない場合、
     エラー（CATEGORY_MISMATCH）で拒否

4. set_oshi
   HTML → Server: { type: "set_oshi", id, target_id }
   → 選択中チームに属さないtarget_idはエラー（TARGET_TEAM_MISMATCH）

★ category_selection状態・select_categoryメッセージは実装していない
  （カテゴリーはMACリスト取込み時に確定済みという前提のため、正常フローには存在しない設計）
```

---

## 重要ファイル

| ファイル | 役割 |
|---|---|
| migrations/001〜004_*.sql | スキーマ変更履歴（004はカテゴリー機能） |
| src/db/migrate.js | マイグレーション実行スクリプト（各ファイルを個別トランザクションでラップ） |
| src/db/cheerstickQueries.js | DB問い合わせ関数群（findDeviceWithProfile, listOrganizations, setDeviceOrganization等） |
| src/websocket/index.js | WebSocketサーバー本体（computeStatus, buildConnectResponse等） |
| src/controllers/webviewController.js | geturlエンドポイント |
| public/index.html | WebViewフロントエンド（チーム選択・推し選択カードUI） |
| handover.md | 本ドキュメント（Gitで管理、今後はこのファイルを正式版として更新） |

---

## 注意事項

- .envファイルは絶対にGitHubにプッシュしない
- 本番環境への変更時は必ず内容確認してから実行（Claude Code利用時も都度承認する運用を推奨）
- 外部コードをClaude Codeに読み込ませる前に内容を目視確認（プロンプトインジェクション対策）
- 本番DBへの変更（マイグレーション等）前は必ずpg_dumpでバックアップを取得する
- 検証用に本番DBへ投入した一時データ（テストデバイス・ダミー組織等）は、確認後必ず削除する
- 将来の20,000本対応を見据えた設計を維持する
- EC2にAWS CLI・gh CLI未導入のため、Route53・GitHub Public/Private切替は手動対応

---

## 2026-07-22: カテゴリー（ジャンル）機能の追加

### 背景

応援グッズは「Jリーグ用」「Vリーグ用」のようにジャンル単位で販売される（＝収益モデル上、グッズ購入時点でジャンルが確定している）。そのため、量産機のMACアドレスは入荷ロット段階でKMT側がカテゴリーを振り分け、CSVインポート時にカテゴリーが確定している前提とする。ユーザーにカテゴリーを選ばせる画面は作らず、category_id未設定のデバイスは異常系（エラー）として扱う設計。チーム選択・推し選択のUI/フロー自体は変更なし。

### スキーマ変更（`migrations/004_add_category.sql`）

| 変更 | 内容 |
|---|---|
| `categories`（新設） | カテゴリーマスタ。`name`, `slug`（例: `j-league`）。初期データとしてJリーグを投入 |
| `organizations.category_id` | 追加。既存のV・ファーレン長崎をJリーグに紐付け済み |
| `devices.category_id` | 追加。既存デバイス（テスト機）は暫定でJリーグに紐付け済み |
| `devices.preset_organization_id` | 追加。**将来拡張用の予約カラム**（チーム専用グッズ対応、例：Jリーグ・Vファーレン長崎専用グッズ）。今回はロジック未実装・常にNULL |

### WebSocketロジック変更（`src/websocket/index.js`, `src/db/cheerstickQueries.js`）

- `category_id`が未設定のデバイスは`connect`時に`status: "error"`＋「カテゴリー未設定のデバイスです。サポートまでお問い合わせください。」を返す（`computeStatus`内で最優先チェック）
- `team_selection`の選択肢（`organizations`）は、デバイスの`category_id`で絞り込むように変更（`listOrganizations(categoryId)`）
- `select_team`で、選択された`organization_id`がデバイスの`category_id`と一致しない場合はエラー（`CATEGORY_MISMATCH`）を返し更新を拒否
- **`category_selection`状態・`select_category`メッセージは実装していない**（意図的にスコープ外とした設計判断）
- `preset_organization_id`を使った分岐（将来、team_selectionをスキップしてplayer_selectionへ直接進める機能）はTODOコメントのみ。ロジック未実装

### 本番反映

- ブランチ`feature/category-support`で実装 → `main`へマージ・push（マージコミット `7c100b6`、実装コミット `d75d8f1`）
- EC2本番環境（`/home/ubuntu/cheerstick-server-new`）へ反映済み
  - 変更ファイル（`migrations/004_add_category.sql`, `src/db/cheerstickQueries.js`, `src/websocket/index.js`）を転送、md5sumで一致確認
  - 適用前に本番DB（`cheerstick_production`）を`pg_dump`でバックアップ（`~/db_backups/`配下）
  - `npm run migrate`でマイグレーション適用済み（`schema_migrations`に`004_add_category.sql`記録済み）
  - `pm2 restart cheerstick-server`済み、ログにエラーなし

### 動作確認

実回線（`wss://ws.cheerstick.com/cheer`）で確認済み。検証用に一時作成したテストデバイス・ダミー組織・テストユーザーは確認後すべて削除済み（本番データへの影響なし）。

- ✅ 正常系: `connect`（unregistered）→`register`（team_selection、teamsがJリーグの1チームのみに絞り込まれることを確認）→`select_team`→`player_selection`→`set_oshi`→`complete`
- ✅ 異常系: category_id未設定のMACアドレスで`connect`→`status: "error"`＋所定メッセージを実フレームで確認

### 次回への申し送り

- **CSVインポート機能実装時**、`category_slug`列からの`category_id`反映が必要。不明なslugはインポートエラーとして弾く設計とする
- **`preset_organization_id`の将来実装**：チーム専用グッズ運用が始まった際、値が入っているデバイスは`team_selection`をスキップして`player_selection`から開始する分岐の実装が必要（現状はカラムのみ存在、ロジック未実装）
- フロントエンド（`public/index.html`）は`status: "error"`の表示に未対応（今回スコープ外としたため）。実運用で未登録デバイスが発生した場合、ユーザーには何も表示されない（真っ黒な画面）状態になる。今後の改善候補
