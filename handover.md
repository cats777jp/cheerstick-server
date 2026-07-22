# CheerStick Server — 引継ぎドキュメント

## プロジェクト概要

| 項目 | 内容 |
|---|---|
| リポジトリ | cats777jp/cheerstick-server（Private） |
| 開発サーバー | https://cheerstick-server.onrender.com |
| 本番サーバー | AWS（移行予定） |
| ホスティング（開発） | Render.com（Free・検証専用） |
| ホスティング（本番） | AWS（自社管理・KMT） |
| 主要技術 | Node.js / Express / PostgreSQL / WebSocket |

---

## ビジネス背景

- 応援グッズ（ジャイロセンサー＋マイコン内蔵）をBLEでスマホと接続
- ペンライトを振ることで「誰が・どの選手を・どのくらい応援したか」を数値化
- 応援熱量を可視化し、試合MVP・月間MVP・年間MVPなどの体験を提供
- 初期: Jリーグ（V・ファーレン長崎）、将来: 各種スポーツ・エンタメへ展開
- 収益モデル: 応援グッズ販売（13,000本で初期投資相殺）、2ndステップでAPI提供

---

## システム構成

```
BLEスティック最大2000本（将来20000本）
  → Bluetooth →
スマホアプリ（ネイティブ）
  → JavaScriptブリッジ →
WebView（振動計算・LED制御・SPA）
  → WebSocket/HTTPS →
KMT管理サーバー（Node.js + Express）
  ├─ WebSocketサーバー（集計・保存のみ）
  ├─ REST API（管理・データ提供）
  ├─ MACアドレスによるHTTPリダイレクト
  └─ PostgreSQL
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

障害時フロー:
- アプリ系: KMT → サーリューション → ヴァンストーン
- サーバー系: KMT単独で収束

---

## ロードマップ

### 現在: Render.com 開発・検証フェーズ
- ✅ 完了: DB設計確定（13テーブル）
- ✅ 完了: マイグレーション作成・適用
- ✅ 完了: Render.com デプロイ済み
- ⬜ 未完: APIの動作確認
- ⬜ 未完: WebSocket実装
- ⬜ 未完: 認証機能の追加（JWT または APIキー）
- ⬜ 未完: アプリ側JSブリッジのテスト結果待ち
- ⬜ 未完: MACアドレスによるリダイレクト処理実装
- ⬜ 未完: 結合テスト（アプリとサーバー）

### 次: AWS移行（2026年7月末週目安）
- AWS環境設計・構築（EC2 or ECS + RDS）
- ドメイン設定・SSL証明書設定
- Render.comからAWSへデータ移行
- 本番環境動作確認・負荷テスト（2000本接続）
- 監視・アラート設定（CloudWatch等）
- ログ可視化・障害対応手順書整備

### 本番リリース: 2026年8月第1週
- V・ファーレン長崎での商用リリース
- 管理ダッシュボード稼働（1stステップ）

### 将来
- 企業向けAPI提供（2ndステップ）
- 20000本対応スケールアップ
- 各種スポーツ・エンタメへ展開

---

## スケジュール（重要）

| 時期 | 内容 |
|---|---|
| 2026年5月末 | デバイス・アプリ発注済み（納期55日） |
| 2026年7月5日 | Render.com DB期限（この前にAWS移行完了が目標） |
| 2026年7月末週 | デバイス・アプリ納品予定 |
| 2026年8月第1週 | 本番リリース（V・ファーレン長崎） |

---

## 現在の環境情報

### ローカル環境（Windows 11 Pro）

| 項目 | 内容 |
|---|---|
| 作業フォルダ | C:\Projects\cheerstick-server |
| Node.js | v26.3.0 |

### Render.com（開発・検証専用）

| 項目 | 内容 |
|---|---|
| Web Service | cheerstick-server（Free） |
| URL | https://cheerstick-server.onrender.com |
| DB | cheerstick-db（Free） |
| DB期限 | 2026年7月5日 |
| Build Command | npm install && npm run migrate |
| 環境変数 | DATABASE_URL（Internal）, NODE_ENV=production |

⚠️ Render.comは検証専用。Basicプランへの移行は不要。本番はAWSへ移行。

---

## DB設計（13テーブル）

### マスター系（7テーブル）

| テーブル | 概要 |
|---|---|
| users | メール認証・OAuth（Google等）両対応 |
| devices | MACアドレスで一意識別、ユーザーと紐づけ |
| organizations | チーム・リーグ・プロダクション等 |
| venues | スタジアム・ホール等の会場 |
| targets | 応援対象（選手・チーム・アーティスト等）汎用管理 |
| events | 試合・コンサート等。同時刻の複数イベントを許容 |
| event_targets | イベント×応援対象の中間テーブル |

### トランザクション系（5テーブル）

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

---

## 重要ファイル

| ファイル | 役割 |
|---|---|
| render.yaml | Render.comサービス定義 |
| migrations/001_initial_schema.sql | 初期スキーマ（13テーブル） |
| src/db/migrate.js | マイグレーション実行スクリプト |
| src/db/index.js | DB接続プール（pg.Pool） |
| .env.example | 環境変数テンプレート |
| handover.md | 本ドキュメント |

---

## 注意事項

- .envファイルは絶対にGitHubにプッシュしない
- 本番環境への変更時は必ず「1. Yes」で内容確認してから実行
- 外部コードをClaude Codeに読み込ませる前に内容を目視確認（プロンプトインジェクション対策）
- AWS移行はRender.com DB期限（7月5日）までに完了させる
- 将来の20,000本対応を見据えた設計を維持する

---

## Claude Codeの使い方

### 起動
```
cd C:\Projects\cheerstick-server
claude
```

### 終了
```
/exit または Ctrl+C を2回
```

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
| `devices.preset_organization_id` | 追加。**将来拡張用の予約カラム**（チーム専用グッズ対応）。今回はロジック未実装・常にNULL |

### WebSocketロジック変更（`src/websocket/index.js`, `src/db/cheerstickQueries.js`）

- `category_id`が未設定のデバイスは`connect`時に`status: "error"`＋「カテゴリー未設定のデバイスです。サポートまでお問い合わせください。」を返す（`computeStatus`内で最優先チェック）
- `team_selection`の選択肢（`organizations`）は、デバイスの`category_id`で絞り込むように変更（`listOrganizations(categoryId)`）
- `select_team`で、選択された`organization_id`がデバイスの`category_id`と一致しない場合はエラー（`CATEGORY_MISMATCH`）を返し更新を拒否
- **`category_selection`状態・`select_category`メッセージは実装していない**（カテゴリーはCSVインポート時に確定しており、正常フローには存在しない前提のため、意図的にスコープ外とした設計判断）
- `preset_organization_id`を使った分岐（将来、team_selectionをスキップしてplayer_selectionへ直接進める機能）はTODOコメントのみ。ロジック未実装

### 本番反映

- ブランチ`feature/category-support`で実装 → `main`へマージ・push（マージコミット `7c100b6`、実装コミット `d75d8f1`）
- EC2本番環境（`cheerstick-server`, `/home/ubuntu/cheerstick-server-new`）へ反映済み
  - 変更ファイル（`migrations/004_add_category.sql`, `src/db/cheerstickQueries.js`, `src/websocket/index.js`）を転送し、md5sumで一致確認
  - 適用前に本番DB（`cheerstick_production`）を`pg_dump`でバックアップ（`~/db_backups/`配下）
  - `npm run migrate`でマイグレーション適用済み（`schema_migrations`に`004_add_category.sql`記録済み）
  - `pm2 restart cheerstick-server`済み、ログにエラーなし

### 動作確認

実回線（`wss://ws.cheerstick.com/cheer`）で確認済み。検証用に一時作成したテストデバイス・ダミー組織・テストユーザーは確認後すべて削除済み（本番データへの影響なし）。

- ✅ 正常系: `connect`（unregistered）→`register`（team_selection、teamsがJリーグの1チームのみに絞り込まれることを確認）→`select_team`→`player_selection`→`set_oshi`→`complete`
- ✅ 異常系: category_id未設定のMACアドレスで`connect`→`status: "error"`＋所定メッセージを実フレームで確認

### 次回への申し送り

- **CSVインポート機能実装時**、`category_slug`列からの`category_id`反映が必要（仕様は別紙`csv-import-category-spec.md`参照。不明なslugはインポートエラーとして弾く設計）
- **`preset_organization_id`の将来実装**：チーム専用グッズ運用が始まった際、値が入っているデバイスは`team_selection`をスキップして`player_selection`から開始する分岐の実装が必要（現状はカラムのみ存在、ロジック未実装）
