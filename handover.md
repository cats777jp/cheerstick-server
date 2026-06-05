# CheerStick Server — 引継ぎドキュメント

## プロジェクト概要

| 項目 | 内容 |
|---|---|
| リポジトリ | [cats777jp/cheerstick-server](https://github.com/cats777jp/cheerstick-server)（Private） |
| 本番サーバー | https://cheerstick-server.onrender.com |
| ホスティング | Render.com（Web Service + PostgreSQL） |
| 主要技術 | Node.js / Express / PostgreSQL（pg） |

---

## 現在の状態（2026-06-05 時点）

- **サーバー**: 稼働中 — https://cheerstick-server.onrender.com
- **DB**: Render.com PostgreSQL（13テーブル作成済み）
- **GitHub**: `main` ブランチと Render が自動連携済み（push → 自動デプロイ）

---

## 作業ログ

### 2026-06-05

#### 1. DB設計確定（13テーブル）

**設計方針**
- 汎用設計（Jリーグ以外のスポーツ・エンタメにも対応）
- ENUMではなく VARCHAR でtype管理（柔軟性のため）
- 将来の仕様変更に対応する JSONB カラムを積極活用

**マスター系（7テーブル）**

| テーブル | 概要 |
|---|---|
| `users` | メール認証・OAuth（Google等）両対応 |
| `devices` | MACアドレスで一意識別、ユーザーと紐づけ |
| `organizations` | チーム・リーグ・プロダクション等 |
| `venues` | スタジアム・ホール等の会場 |
| `targets` | 応援対象（選手・チーム・アーティスト等）を汎用管理 |
| `events` | 試合・コンサート等。同時刻の複数イベントを許容 |
| `event_targets` | イベント×応援対象の中間テーブル（多対多） |

**トランザクション系（5テーブル）**

| テーブル | 概要 |
|---|---|
| `cheer_logs` | 応援生ログ（デバイスからの生データ原票） |
| `cheer_summaries` | 応援集計（イベント×ターゲット×ユーザー単位） |
| `awards` | ランキング・アワード結果 |
| `user_target_follows` | ユーザーの応援対象フォロー関係 |
| `device_event_sessions` | デバイスのイベント接続セッション・通信品質ログ |

#### 2. `migrations/001_initial_schema.sql` 作成

- UUID 主キー（`pgcrypto` の `gen_random_uuid()` 使用）
- `users.updated_at` 自動更新トリガー関数 `set_updated_at()` 実装
- JSONB カラム（`targets.metadata`, `events.metadata`, `cheer_logs.raw_sensor_data`）に GIN インデックス追加
- `schema_migrations` テーブルで適用済みファイルを追跡（二重適用防止）

#### 3. `src/db/migrate.js` 更新

- 旧: SQL を JS 内にハードコード
- 新: `migrations/` ディレクトリの `.sql` ファイルをソート順に読み込み
- トランザクション管理（BEGIN / COMMIT / ROLLBACK）で途中失敗時の安全性を確保

#### 4. Render.com PostgreSQL 作成

| 項目 | 値 |
|---|---|
| サービス名 | `cheerstick-db` |
| プラン | Free |
| Database | `cheerstick` |
| User | `cheerstick_user` |
| リージョン | Virginia (US East) |
| **有効期限** | **2026-07-05（本番前に Basic プランへ移行必要）** |

> **注意**: Render Free プランの PostgreSQL は作成から90日で削除されます。

#### 5. Render.com Web Service デプロイ

| 項目 | 値 |
|---|---|
| サービス名 | `cheerstick-server` |
| プラン | Free |
| URL | https://cheerstick-server.onrender.com |
| Build Command | `npm install && npm run migrate` |
| Start Command | `npm start` |
| 環境変数 | `DATABASE_URL`（Internal URL・自動注入）、`NODE_ENV=production` |
| GitHub 連携 | `main` ブランチへの push で自動デプロイ |

#### 6. マイグレーション実行完了

```
APPLY 001_initial_schema.sql
Migration complete. 1 file(s) applied.
```

13テーブル全て正常に作成済み。

---

## 次のステップ

1. **API 動作確認** — `/health` エンドポイント等でサーバー疎通確認
2. **WebSocket 実装** — アプリからの応援データ受信
3. **認証機能の追加** — JWT または API キー認証
4. **アプリ側 JS ブリッジのテスト結果待ち**
5. **Render.com DB を Basic プランへ移行** — 本番前（期限: 2026-07-05）

---

## インフラ構成

```
GitHub (cats777jp/cheerstick-server)
  └─ push to main
       └─ Render Web Service (cheerstick-server)
            ├─ Build: npm install && npm run migrate
            ├─ Start: npm start
            └─ Render PostgreSQL (cheerstick-db)
                 └─ DATABASE_URL (Internal, 自動注入)
```

## 重要ファイル

| ファイル | 役割 |
|---|---|
| `render.yaml` | Render サービス定義 |
| `migrations/001_initial_schema.sql` | 初期スキーマ（13テーブル） |
| `src/db/migrate.js` | マイグレーション実行スクリプト |
| `src/db/index.js` | DB 接続プール（pg.Pool） |
| `.env.example` | 環境変数テンプレート |
