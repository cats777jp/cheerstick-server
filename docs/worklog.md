# CheerStick 作業ログ

**追記のみ。過去エントリの編集・削除は禁止。** 新しいエントリを先頭に追加すること。

---

## 2026-07-25 ドキュメント運用体制のコミット・push

### 実施したこと
- 前セッションで作成済みだった `.gitattributes` / `.gitignore` 変更 / `CLAUDE.md` ・
  `SETUP.md` ・ `docs/` ・ `.claude/`（いずれも未コミットのworking tree状態）を、
  ユーザー指示に沿って3つの単独コミットに分割してコミット
  1. `3962fd0` chore: テキストファイルの改行コードをLFに統一（`.gitattributes` のみ）
  2. `d87db8c` chore: 引継ぎドキュメントをgit管理対象に変更（`.gitignore` のみ）
  3. `840e36d` docs: 引継ぎドキュメント体制を整備（`CLAUDE.md`/`SETUP.md`/`docs/`/`.claude/`）
- `cheerstick-ws` / `nodered-backup/` / `*.bak_*` は指示通り触れず未追跡のまま残した
- `feature/reference-data` を `origin` にpush（upstream未設定だったため `-u` で新規設定）

### 変更したファイル
- `.gitattributes`（新規）／ `.gitignore`（改行コード運用ルールのコメント更新）
- `CLAUDE.md` / `SETUP.md` / `docs/spec.md` / `docs/runbook.md` / `docs/worklog.md` / `.claude/skills/handover/SKILL.md`（コミット確定のみ、内容は前セッションで作成済み）

### 判明した事実 / 想定と違ったこと
- `git add --renormalize .` は `-u` を暗黙に含むため、未追跡の新規ファイル（`.gitattributes` 自体）は
  ステージされない。別途 `git add .gitattributes` が必要だった。
- 最初のコミットでパス指定を忘れ、事前にステージ済みだった `.gitignore` の変更が
  `.gitattributes` のコミットに混入する事故を起こした。push前だったため
  `git reset --soft HEAD~1` で取り消し、パス指定付きで正しくコミットし直した。
  （教訓：複数コミットに分割する際は、必ず `git commit -- <path>` でコミット対象を明示する）

### 次回への申し送り
- 上記の分割コミットにより本セッションの申し送り事項に変化なし。下の優先度リストを参照。

### 未解決のまま残した課題
- 特になし（本セッションはコミット整理・pushのみ。下記の既存課題は継続）

---

## 2026-07-25 ドキュメント運用体制の整備

### 実施したこと
- 引継ぎ書を単一ファイルで書き直す運用をやめ、`docs/` 配下の3ファイル分割に移行
  - `spec.md`（累積型・削除禁止）／ `runbook.md`（環境情報）／ `worklog.md`（追記のみ）
- `CLAUDE.md` を設置し、セッション開始・終了時の手順を常時指示化
- `/handover` スキルを追加し、セッション終了時の docs 更新手順を固定化

### 判明した事実 / 想定と違ったこと
- v10で実装した「カテゴリー機能」の記述が v12 以降の引継ぎ書から消失していた。
  原因は単一ファイルを毎回書き直す運用で、触れなかった内容が自然に脱落したこと。
  コードの問題ではなくドキュメント運用の問題と判断。git管理により再発を防ぐ。
- 仕様書PDF（20260630）と現行実装に多数の差異がある。PDFは史的経緯として保管し、
  `docs/spec.md` を正本とする方針に変更。

### 次回への申し送り（優先度順）
1. **Vanstoneへブリッジ仕様（`window.onCheerStickData` 等の仮称）を提示・合意**
   → 唯一の社外依存。中国＋仲介1社経由のため往復に日数がかかる。最優先で発信
2. **Elastic IP 割当**（作業15分、未対応のままEC2再起動で4ドメイン全滅）
3. **管理API `PATCH /api/v1/admin/events/:id/status` に認証追加**（現在認証なしで公開中）
4. **負荷試験＋WebSocketハートビート実装**（2,000〜20,000本規模、未検証）
5. カテゴリー機能の生存確認（psql / grep で10分。設計判断は後回しで可）
6. 静的ファイル2重配置の恒久対応（nginx root統一）

### 未解決のまま残した課題
- マルチスポーツ対応の設計確定（初回リリースは長崎単独のため後倒し）
- 選手データの実データ化（現状サンプル選手A/B/Cのプレースホルダー）
- CSVインポート機能（MACリスト・選手データの一括投入）
- Grafana設定、admin.cheerstick.com
- `devicesController.js` の既存バグ（存在しない location カラム参照、実害なし）
- `cheerstick-api`（旧pm2プロセス）の削除
- チームカラーの正式HEX値（V・ファーレン長崎、暫定 #005AAA）
- 管理画面（試合状態操作・チームカラー設定のUI）

---

## 2026-07-23 v14までの作業（過去分の要約）

> handover v14 より転記。当時の記録を要約したもの。

### 実施したこと
- 本番EC2の状況確認（pm2 / index.htmlバージョン / nginx・SSL / DB稼働）
- 本番ディレクトリがgit管理外だった問題を解消。ローカル・GitHub・本番を完全同期（`c39ee16`）
- CORS設定修正：`ALLOWED_ORIGINS=https://app.cheerstick.com` を `.env` に追加
- 署名付きトークン（reference機能）を一時無効化、MACアドレス直指定方式へ切替
- 応援量カウント機能をサーバー側に新規実装（migration 006、events.status CHECK制約）
- 応援中画面（cheeringCard）をフロントに新規実装
- チームカラー対応（migration 007、organizations.color 列）

### 判明した事実
- 静的ファイルが2箇所にあり、`git checkout` だけでは本番配信先に反映されない。
  この見落としで当日デプロイ漏れが1度発生した。

### 未解決のまま残した課題
- 上記2026-07-25エントリの申し送りに引き継ぎ済み
