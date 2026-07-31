# 試合の非表示化機能 本番反映 実施手順書

作成日：2026-07-31
対象：Claude Code（`C:\Projects\cheerstick-server`、EC2作業）
関連：`docs/proposals/admin-hide-endpoint.md`（設計方針v2）、
　　　`docs/tasks/2026-07-31-hide-endpoint-staging.md`（staging実装・検証、完了済み）

---

## 0. 前提

staging環境での実装・検証は完了済み（commit `19baf8f`・`02cb6e6`、push済み）。
本タスクはこれを本番へ反映する。

**案B（管理画面新設）と異なり、インフラ変更（nginx・DNS・SSL）は一切不要。**
すでに`admin.cheerstick.com`は稼働中であり、今回はアプリケーションコードと
DBスキーマの変更のみで完結する。

---

## 1. 禁止事項

- `sudo systemctl restart nginx`（今回nginxの変更自体が無いため触れる必要なし）
- DNSレコードの操作（対象外）
- バックアップを取らずにマイグレーションを適用すること
- STEP 4の動作確認より前に、本番データ（実際の試合データ）を操作すること
- 停止ポイントを飛ばして次工程へ進むこと

---

## STEP 0. 前提確認

```bash
cd /home/ubuntu/cheerstick-server-new
git log --oneline -5
git status
```

現在のコミット位置を確認する（案B反映後の状態のはず）。

```sql
-- 本番DBに対して実行（読み取りのみ）
SELECT current_database();
\d events
```

`events`テーブルに`hidden_at`列が**まだ存在しない**ことを確認する
（存在する場合は想定外なので、直ちに報告し停止すること）。

```sql
SELECT tablename, tableowner FROM pg_tables
WHERE schemaname='public' AND tablename='events';
```

**所有者が`cheerstick`であることを確認する。** stagingで発生した所有者問題
（`docs/runbook.md`参照）は、本番では発生しない想定だが、念のため確認する。
もし`cheerstick`以外だった場合は、STEP 2で同様の`must be owner of table`
エラーが出る可能性があるため、その旨を先に報告すること。

---

## STEP 2. バックアップ

```bash
sudo -u postgres pg_dump cheerstick_production > ~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
ls -la ~/backups/ | tail -5
```

バックアップファイルのサイズが0でないことを確認する。

### ■ 停止ポイント①

**STEP 0・1の結果を報告し、KMT様の指示を待つこと。** マイグレーション適用前の
最終確認ポイント。

---

## STEP 3. マイグレーション適用

```bash
cd /home/ubuntu/cheerstick-server-new
node src/db/migrate.js
```

```
Migration failed: ... must be owner of table events
```

というエラーが出た場合は、STEP 0で確認した所有者を踏まえて対応を判断する
（stagingと異なり、本番では基本的に発生しない想定）。発生した場合は
**その場でALTER TABLE OWNER TOを実行せず、まず報告すること。**

適用後、確認する。

```sql
\d events
```

`hidden_at | timestamp with time zone |` の行が追加されていること。

---

## STEP 4. コードデプロイ

```bash
git pull origin feature/reference-data
git log --oneline -3
```

`02cb6e6`まで到達していることを確認する。

```bash
git diff <直前のコミット>..HEAD --stat -- package.json package-lock.json
```

差分があれば`npm ci`を実行する。無ければ不要。

```bash
pm2 restart cheerstick-server
pm2 logs cheerstick-server --lines 40 --nostream
```

エラーが出ていないこと、`online`であることを確認する。

### 一般APIの疎通確認（必須）

```bash
curl -sI "https://api.cheerstick.com/api/v1/webview/geturl?id=<テスト用MAC>"
curl -sI "https://app.cheerstick.com/index.html"
curl -sI "https://admin.cheerstick.com/"
```

いずれも案B反映時と変わらず正常であることを確認する。

### ■ 停止ポイント②

**STEP 3・4の結果を報告し、KMT様の指示を待つこと。**

---

## STEP 5. 動作確認（テストデータを使用、後片付けまで含む）

### 5-1. テスト試合の登録・非表示化確認

管理画面（`https://admin.cheerstick.com/`）で、テスト用の試合を1件登録する。

| # | 操作 | 期待結果 |
|---|---|---|
| 1 | テスト試合を登録（`live`にはしない） | 一覧に表示される |
| 2 | 削除ボタン→確認ダイアログでOK | 200/204、一覧から消える |
| 3 | 同じ試合を`live`にしてから削除を試みる | 409、「進行中の試合は削除できません」 |
| 4 | `live`を停止してから削除 | 成功する |

### 5-2. 後片付け（物理削除、設計6.2の運用に沿う）

これはテストデータであり、応援ログは存在しないはずなので、確認のうえ
物理的に削除してよい。**設計書6.2の手順どおり、削除前に必ず確認すること。**

```sql
-- 対象のevent_idを確認したうえで
SELECT COUNT(*) FROM cheer_logs WHERE event_id = '<テスト試合のID>';
```

0件であることを確認してから、以下を実行する。

```sql
DELETE FROM events WHERE id = '<テスト試合のID>';
```

削除後、`SELECT * FROM events;`でテストデータが残っていないことを確認する。

---

## STEP 6. 報告

以下を含めて報告すること。

1. STEP 0〜5それぞれの結果
2. マイグレーション適用結果（`\d events`の出力）
3. 一般API疎通確認の結果
4. テスト試合の登録〜非表示化〜物理削除までの一連の確認結果
5. 本番の`events`テーブルにテストデータが残っていないことの明示

commitは不要（本番環境への直接作業のため、リポジトリ変更は無し）。

---

## 5. ロールバック手順

### STEP 3（マイグレーション）で問題が起きた場合

追加のみのマイグレーションのため、切り戻しは容易。

```sql
ALTER TABLE events DROP COLUMN hidden_at;
```

### STEP 4（コードデプロイ）で問題が起きた場合

```bash
cd /home/ubuntu/cheerstick-server-new
git log --oneline -5          # 現在位置の確認
git reset --hard <STEP0で確認した直前のコミット>
pm2 restart cheerstick-server
pm2 logs cheerstick-server --lines 40 --nostream
```

`hidden_at`列は残したままでよい（旧コードは単に参照しないだけで、
害はない）。

復旧後、一般API（geturl / app / admin）の疎通を確認すること。

---

## 補足：この後の展望

本タスク完了後、案B PHASE 6-5で見送っていた**本番用の初回試合データの登録**が
実施可能になる。これまでは誤操作時の復旧手段が無かったが、非表示化機能により
「間違えても消せる」状態になったため、8/9の試合登録に進める前提が整う。

---

## 実施結果（2026-07-31、Claude Code実施）

**STEP0〜5すべて実施済み。** 各停止ポイントでユーザー（KMT様）へ報告し、
指示を得てから次工程へ進む形で実施した。詳細は`docs/worklog.md`
2026-07-31エントリ「試合の非表示化機能 本番反映」を参照。

### STEP0（前提確認）

- ローカル：`02cb6e6`（想定どおり）
- EC2：`70683f4`。**想定（案B反映後）より1コミット（`a9d593c`、docs更新のみ）
  古い状態だった。** STEP4のgit pullでまとめて解消（差分は既存docs更新＋
  今回の実装のみで、想定外の混入なし）
- 本番DB：`current_database()`→`cheerstick_production`、`hidden_at`列は
  未存在（想定どおり）、`events`テーブル所有者は`cheerstick`（想定どおり。
  stagingで発生した所有者エラーは本番では未発生）

### STEP2（バックアップ）

`~/backups/cheerstick_production_20260731_083527.sql`（44,484バイト）取得済み。

### STEP3（マイグレーション適用）

```
SKIP  001〜009（既に適用済み）
APPLY 010_add_events_hidden_at.sql
Migration complete. 1 file(s) applied.
```

`\d events`で`hidden_at | timestamp with time zone |`列の追加を確認。
所有者エラーは発生せず。

### STEP4（コードデプロイ）

- `git pull origin feature/reference-data`：`70683f4`→`02cb6e6`（Fast-forward）
- `package.json`/`package-lock.json`：差分なし、`npm ci`不要
- `pm2 restart cheerstick-server`：`online`、`unstable restarts: 0`
- 一般API疎通確認：`api.cheerstick.com/geturl`・`app.cheerstick.com/index.html`・
  `admin.cheerstick.com/`いずれも`200`

### STEP5（動作確認・後片付け）

テスト試合（`7b7916a7-bfaf-424c-9298-3e4f314f1a0d`）で5-1の1〜4すべて確認。

| # | 操作 | 結果 |
|---|---|---|
| 1 | 登録（`scheduled`） | 一覧に表示 |
| 2 | 削除 | `200`、`hidden_at`設定、一覧から消滅 |
| 3 | （SQLで一時復元後）`live`化→削除 | `409` `CANNOT_HIDE_LIVE_EVENT` |
| 4 | `finished`化→削除 | `200`、一覧から消滅 |

5-2：`SELECT COUNT(*) FROM cheer_logs WHERE event_id=...`で**0件**を確認後、
`DELETE FROM events WHERE id=...`で物理削除。`SELECT * FROM events;`で
本番`events`テーブルが**0件（テストデータ残存なし）**であることを確認済み。

### 判明した事実 / 想定と違ったこと

- テスト試合登録時、作業端末（ローカルPC）のシェル文字コードの都合で
  タイトルが文字化けして保存された。IDベースの動作（非表示化・404/409判定・
  物理削除）には影響なし。テストデータのため物理削除済みで実害なし
- STEP0で判明した「EC2が想定より1コミット古かった」点以外は、手順書どおりに進行

### 次に必要な作業

1. 案B PHASE 6-5相当の書き込み動作確認（本番用初回試合データの登録、
   status遷移、日時往復、409競合表示）を改めて実施する（`docs/spec.md`11.3参照）
2. `docs/spec.md`11.4（`updateEventStatus`/`updateEvent`が`hidden_at`を
   チェックしない）・11.5（`routes/events.js`の死んでいるコード）は
   本番反映後も未対応のまま。対応要否はKMT様の判断待ち
