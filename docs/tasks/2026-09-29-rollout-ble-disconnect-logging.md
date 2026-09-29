# BLE切断のサーバー記録機能 本番反映 手順書

作成日：2026-09-29
対象：岩村様（TeraTermでの手動実行。本番EC2へのSSH・書き込みはすべて岩村様が行う）
関連：`cheerstick-rollout-ble-disconnect-prep-20260929.md`（指示書）、
　　　`cheerstick-ble-disconnect-and-led-investigation-20260929.md`（実装指示書）、
　　　`docs/spec.md` 11.12章（BLE切断のサーバー記録）、
　　　`docs/tasks/2026-09-29-rollout-gauge-and-demo-mode.md`（構成を踏襲した前回手順書）

---

## 0. 前提

- 本番の現在のHEAD：`b17b335`（2026-09-29昼に反映済み、ゲージ・カウンター固定の同期修正）
- 今回反映する範囲：`b17b335`から`c9e5466`まで（本書作成時点のローカル
  `feature/reference-data`のHEAD）
- 含まれる変更（`git diff --stat b17b335..HEAD`で確認済み、詳細は1-1参照）：
  `public/index.html`（クライアント側の送信・立ち上がりエッジ検出）、
  `src/websocket/index.js`・`src/db/cheerstickQueries.js`（サーバー側のハンドラ）、
  `migrations/013_add_ble_disconnect_logs.sql`（新規テーブル）、`docs/`配下
- **`package.json`・`package-lock.json`に変更は無い**（1-1で確認済み）。`npm install`は不要
- **今回はマイグレーション適用（新規テーブル作成）と`pm2 restart`の両方が必要**
- **`public/index.html`は観客が使うWebViewのページであり、静的ファイルの2箇所デプロイ対象
  （`/var/www/cheerstick-app/index.html`）。** `git pull`だけでは配信内容が変わらない
  （`docs/runbook.md`「デプロイ手順」節と同じ構造の問題）。他の静的ファイル
  （`public/admin/events.html`・`public/battle.html`）には今回変更が無いため、
  コピー対象は`index.html`のみ（1-1の差分確認で確認済み）
- **確立中のWebSocket接続が一度切れる。** 実機テストと重ならない時間帯に実施する

---

## 1. 反映前の確認結果（Claude Codeが実施済み。読み取りのみ、本番へは未反映）

### 1-1. 差分の確認

```
$ git diff --stat b17b335..HEAD
 docs/runbook.md                            |  45 +++++
 docs/spec.md                               |  77 ++++++++
 docs/worklog.md                            |  85 +++++++++
 migrations/013_add_ble_disconnect_logs.sql |  29 +++
 public/index.html                          |  19 +-
 scripts/ble-disconnect/local-verify.js     | 288 +++++++++++++++++++++++++++++
 src/db/cheerstickQueries.js                |  13 ++
 src/websocket/index.js                     |  25 +++
 8 files changed, 578 insertions(+), 3 deletions(-)
```

- `public/`：`index.html`のみ変更（`isBleDisconnectPayload()`検知時のWebSocket通知・
  立ち上がりエッジ検出）。`public/admin/events.html`・`public/battle.html`に変更は無い
- `src/`：`websocket/index.js`（`ble_disconnect`ハンドラ追加）・`db/cheerstickQueries.js`
  （`insertBleDisconnectLog()`追加）
- `migrations/`：`013_add_ble_disconnect_logs.sql`（新規、全文は1-2参照）
- `scripts/`：`ble-disconnect/local-verify.js`（新規、ローカル確認専用。本番には影響しない）
- `docs/`：`spec.md`・`runbook.md`・`worklog.md`
- **`package.json`・`package-lock.json`：変更無し**（`git diff --stat`の出力に含まれない
  ことで確認済み）。本番での`npm install`は不要

### 1-2. マイグレーションの内容確認

`migrations/013_add_ble_disconnect_logs.sql`の全文：

```sql
-- =============================================================
-- migrations/013_add_ble_disconnect_logs.sql
-- BLE切断のサーバー記録：ble_disconnect_logs テーブルの新設
-- =============================================================

-- public/index.htmlがAPPからの異常データ（accel全軸ゼロ・volt/rssiゼロ）を検知した際、
-- WebSocket経由（type: "ble_disconnect"）で1件INSERTされる。連続して異常データを
-- 受信し続けている間（＝BLEが切断されたまま）は、クライアント側で立ち上がりエッジ
-- （最初の1回）のみ送信するため、1回の物理的な切断につき1行が記録される想定。
CREATE TABLE ble_disconnect_logs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID        NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    event_id    UUID        REFERENCES events(id) ON DELETE SET NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  ble_disconnect_logs             IS '...';
COMMENT ON COLUMN ble_disconnect_logs.device_id   IS '...';
COMMENT ON COLUMN ble_disconnect_logs.event_id    IS '...';
COMMENT ON COLUMN ble_disconnect_logs.occurred_at IS '...';

CREATE INDEX idx_ble_disconnect_logs_device_id   ON ble_disconnect_logs (device_id);
CREATE INDEX idx_ble_disconnect_logs_event_id    ON ble_disconnect_logs (event_id);
CREATE INDEX idx_ble_disconnect_logs_occurred_at ON ble_disconnect_logs (occurred_at);
```

（`COMMENT ON`の本文は省略。全文はリポジトリの同ファイル参照）

**安全性（複数回実行してもエラーにならないか）**：このファイル自体は`IF NOT EXISTS`等を
使っていない（`CREATE TABLE ble_disconnect_logs`のみ）。ただし、これは**本リポジトリの
既存マイグレーション全12本と同じ書き方**であり、`src/db/migrate.js`が`schema_migrations`
テーブル（ファイル名をキーに適用済みかどうかを記録）で二重適用を防ぐ設計になっているため、
通常の運用（`node src/db/migrate.js`経由での適用）では複数回実行されても2回目以降は
`SKIP`され、エラーにはならない。**ファイル単体を手動で`psql`に流し込むような使い方
（`migrate.js`を経由しない適用）をした場合のみ、2回目の実行でテーブル重複エラーになる**
点は、他の既存マイグレーションと同じ注意点として申し送る。

**外部キー制約の削除時挙動**：
- `device_id` → `devices(id)`：**`ON DELETE RESTRICT`**（`cheer_logs.device_id`と同じ方針）。
  参照されているデバイスは削除できない。本リポジトリにはデバイスの物理削除経路自体が
  実装されていないため、通常運用でこの制約が発火する場面は無い
- `event_id` → `events(id)`：**`ON DELETE SET NULL`**。イベントが削除されても、
  BLE切断の記録自体（デバイス・発生時刻）は残り、`event_id`のみ`NULL`化される。
  ただし`events`にも物理削除経路は実装されておらず（非表示化＝`hidden_at`のみ）、
  通常運用でこちらも発火しない見込み

### 1-3. 既存テストの最終確認（現在のHEAD、`c9e5466`で実施）

| スクリプト | 結果 |
|---|---|
| `scripts/ble-disconnect/local-verify.js` | PASS=8 FAIL=0 |
| `scripts/demo/local-verify.js` | PASS=27 FAIL=0 |
| `scripts/rate-limit/local-verify.js` | PASS=26 FAIL=0 |
| `scripts/demo/local-verify-demo-mode.js` | PASS=29 FAIL=0 |

いずれも全PASS（回帰無し）。

---

## 2. 全体の順序（6ステップ）

STEP 0（本番事前確認・バックアップ）→ STEP 1（本番`git pull`）→
STEP 2（マイグレーションの適用）→ STEP 3（静的ファイルのコピー）→
STEP 4（`pm2 restart --update-env`）→ STEP 5（疎通確認）

---

## STEP 0：本番の事前確認とバックアップ

```bash
ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126
```

1. 現在のHEAD（`b17b335`のはず）
   ```bash
   git -C /home/ubuntu/cheerstick-server-new log --oneline -1
   ```
2. 確立中の接続数・pm2の再起動回数（現在10のはず、反映後は11になる想定）
   ```bash
   ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l
   pm2 list
   ```
3. ロールバック用のgitタグを**ローカルPCで**作成する（本番EC2のDeploy Keyは読み取り専用）。

   ```bash
   git tag prod-before-ble-disconnect-logging-20260929 b17b335
   git push origin prod-before-ble-disconnect-logging-20260929
   ```
4. 本番DBバックアップ（`pg_dump`。**本番EC2上で実行**。新規テーブル作成を伴うため必須）
   ```bash
   mkdir -p ~/backups
   FILE=~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
   sudo -u postgres pg_dump cheerstick_production > $FILE
   ls -la $FILE   # サイズが非ゼロであることを確認
   ```

**確認項目：** HEAD・接続数・pm2再起動回数（10）を記録した、gitタグ・DBバックアップとも
成功した。
**中断の基準：** DBバックアップのサイズが0、または`pg_dump`がエラー終了した場合は、
原因を確認できるまで先へ進まない。

---

## STEP 1：本番へ`git pull`

**本番EC2上で実行する。**

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
git log --oneline -1   # c9e5466（またはその時点の最新）に到達していることを確認
git status             # コンフリクトが無いこと、意図しないローカル変更が無いことを確認
```

`Fast-forward`で完了するはず。

**確認項目：** `git log`のHEADが`c9e5466`（想定コミット）に一致すること。`git status`が
コンフリクト・意図しない差分無しであること。
**中断の基準：** `git pull`がコンフリクト等で失敗した場合、原因を確認できるまで
STEP 2へ進まない。

---

## STEP 2：マイグレーションの適用

**本番EC2上で実行する。**

```bash
cd /home/ubuntu/cheerstick-server-new
node src/db/migrate.js
```

**確認項目：**
- 出力に`SKIP  001_initial_schema.sql (already applied)`〜`SKIP  012_add_ranking_snapshots.sql
  (already applied)`が12件（既存分すべて）と、`APPLY 013_add_ble_disconnect_logs.sql`が
  1件のみ出力されること（それ以外の`APPLY`が無いこと）
- `Migration complete. 1 file(s) applied.`で終わること

適用後、テーブル構造を確認する。

```bash
psql -U cheerstick -d cheerstick_production -c "\d ble_disconnect_logs"
```

- `id`（uuid, PK）・`device_id`（uuid, not null）・`event_id`（uuid）・
  `occurred_at`（timestamptz, not null）の4列があること
- `device_id`に`devices(id)`への外部キー（`ON DELETE RESTRICT`相当）、
  `event_id`に`events(id)`への外部キー（`ON DELETE SET NULL`相当）があること
- `idx_ble_disconnect_logs_device_id`・`idx_ble_disconnect_logs_event_id`・
  `idx_ble_disconnect_logs_occurred_at`の3つのインデックスがあること

**中断の基準：** `node src/db/migrate.js`がエラー終了した場合、
または想定と異なる`APPLY`/`SKIP`件数だった場合、原因を確認できるまで
STEP 3へ進まない（DBバックアップからの復旧を検討する）。

---

## STEP 3：静的ファイルのコピー

**今回コピーが必要なのは`public/index.html`のみ**（1-1の差分確認のとおり、
`public/admin/events.html`・`public/battle.html`に変更は無い）。

**本番EC2上で実行する。**

```bash
cd /home/ubuntu/cheerstick-server-new
sudo cp public/index.html /var/www/cheerstick-app/index.html
diff /var/www/cheerstick-app/index.html /home/ubuntu/cheerstick-server-new/public/index.html && echo "index.html: OK"
```

既存ファイルへの上書きコピーのため、`chown`/`chmod`は不要。

**確認項目：** `diff`が差分無しで終了すること。
**中断の基準：** `diff`に差分が出た場合、反映は完了していない。原因を確認してから
先へ進む。

---

## STEP 4：`pm2 restart --update-env`

**確立中のWebSocket接続が一度切れる。** STEP 0で確認した接続数・時間帯を踏まえ、
実機テストと重ならないタイミングで実施する。実施直前に、もう一度接続数を確認しておく。

```bash
ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l   # 最終確認
pm2 restart cheerstick-server --update-env
pm2 logs cheerstick-server --lines 50 --nostream
```

**確認項目：**
- 新しいエラーが無いこと
- `[rate-limit] config: ...`の行が引き続き出力されること
- `pm2 list`の再起動回数が10→11（+1のみ）になっていること

**中断の基準：** 起動ログにエラーが出る、または`pm2 list`が`errored`表示になった場合、
STEP 5へ進まずロールバック（本書末尾）を検討する。

---

## STEP 5：疎通確認

**今回のSTEP 5は「エラーが出ずに、既存の動作が壊れていないこと」の確認にとどめる。**
BLE切断の記録が実機で実際に動作するかどうかの確認は、次回の実機検証の手順書
（別途）に委ねる。

1. **既存の`connect`〜`count`の回帰確認**：テスト用デバイスで、これまでどおり動作する
   ことを確認する。

   ⚠️ **指示書に例示のあった`DE:AD:BE:EF:00:01`は、`docs/runbook.md`「デモ用デバイスの
   登録」節の見出しに`未実行`と明記されており、本番に実在しない可能性がある。**
   実行前に必ず存在確認すること。

   ```bash
   psql -U cheerstick -d cheerstick_production -c \
     "SELECT id, mac_address, category_id FROM devices WHERE mac_address = 'DE:AD:BE:EF:00:01'"
   ```

   - 存在し、`category_id`が設定済みであれば、そのMACで`connect`〜`count`を試す
   - 存在しない、または`category_id`が未設定の場合は、代わりに
     `AA:00:00:02:00:00`〜`AA:00:00:02:00:63`等、9/28の100 vs 100デモで実際に使用した
     「デモ用」カテゴリー配下の既登録デバイス（`docs/spec.md` 8.4章・
     `docs/worklog.md` 2026-09-28エントリ参照）を使う。本番の実チーム・実デバイスには
     触れない安全なテスト対象として選定済みのもの
   - WebSocketクライアント（`wscat`等）で`{type:"connect", id:"<MAC>"}`を送り、
     正常な`status`（`error`以外）が返ること、続けて`{type:"count", id:"<MAC>",
     value:1, duration_ms:1000}`を送ってもエラー応答が返らないことを確認する

2. **`ble_disconnect_logs`が空のテーブルとして参照できること**
   ```bash
   psql -U cheerstick -d cheerstick_production -c "SELECT COUNT(*) FROM ble_disconnect_logs"
   ```
   - エラーにならず`0`（またはSTEP 5-1で偶然何か記録された場合はごく少数）が返ること

**確認項目：** 上記1・2がいずれもエラーなく完了すること。
**中断の基準：** いずれかでエラーが出た場合、報告する（本番運用への影響は無いと
考えられるが、原因不明のまま次の実機検証へは進まない）。

---

## 中断の基準（再掲）

- STEP 1：`git pull`のコンフリクト
- STEP 2：マイグレーションの適用エラー、想定と異なる`APPLY`/`SKIP`件数
- STEP 3：`diff`の差分残り
- STEP 4：`pm2 restart`後のエラー・再起動回数の異常な増加
- STEP 5：疎通確認のいずれかの失敗

いずれかに該当した場合、次のSTEPへ進まず報告する。

---

## ロールバック

対象コミットにマージコミットは含まれない（すべて通常のコミット）。
**`docs/`配下の変更（`c9e5466`のドキュメント部分）は`revert`しないこと。**
`docs/spec.md`・`docs/worklog.md`は追記のみで過去記述を削除しない運用のため
（`CLAUDE.md`）。ロールバックした場合は、その旨を`docs/worklog.md`へ**新しいエントリ
として**追記すること。

### コードを戻す場合

```bash
# ローカルPCで（新しい方から順に。7f0d35cがコード本体、c9e5466はdocsのみのためrevert対象外）
git revert 7f0d35c
git push origin feature/reference-data
```

```bash
# 本番EC2上
cd /home/ubuntu/cheerstick-server-new
git pull
sudo cp public/index.html /var/www/cheerstick-app/index.html
diff /var/www/cheerstick-app/index.html /home/ubuntu/cheerstick-server-new/public/index.html && echo "OK"
pm2 restart cheerstick-server --update-env   # src/の変更を戻すため必須
```

`public/index.html`は静的ファイルのため、`sudo cp`し直さない限り配信内容
（nginxが実際に返す内容）は変わらない。**`revert`しただけでは画面は新しいままなので、
必ず`cp`を実施すること。**

### マイグレーション（テーブル）を戻す場合

`git revert`はDBのスキーマ変更までは戻さない（マイグレーションは1度適用されると
`schema_migrations`に記録され、コード側を`revert`しても再実行されない）。
テーブル自体を削除する場合は、DOWN方向のSQLを手動で実行する。

```sql
-- 本番DBで実行（psql等）。BLE切断の記録データも失われる点に注意
DROP TABLE IF EXISTS ble_disconnect_logs;
DELETE FROM schema_migrations WHERE filename = '013_add_ble_disconnect_logs.sql';
```

**通常は、コードの`revert`（ハンドラを無効化）のみで十分**であり、テーブル自体の削除
（記録データの消失を伴う）は、明確な理由が無い限り推奨しない。KMT様の判断を仰ぐこと。
