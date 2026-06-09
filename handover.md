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
