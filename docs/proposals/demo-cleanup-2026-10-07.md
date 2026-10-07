# 使い捨てデモデータの削除作業の記録（2026-10-07、本番）

> **これは「参考資料」であり、実行用のスクリプトではない。**
> 本ファイルのSQLに書かれているID・期間・件数は**2026-10-07の今回限りの値**で、そのまま再実行すると危険
> （当時存在した対抗戦ペアのID、期間の上限、恒久デモのIDが固定値で埋め込まれている）。
> **次回のクリーンアップでは、このファイルを土台に、対象を洗い出し直す。** 手順は「5. 次回の作り直し方」参照。
> （このフォルダは本来、未実装の設計案を置く場所だが、岩村様の方針により、削除作業の記録をここに保存している。）

関連：`docs/worklog.md` 2026-10-07「続き4」「続き5」、`docs/spec.md` 11.7章（`cheer_logs`等の外部キーSET NULL）、
`docs/runbook.md`「デモ用ユーザー（`.invalid`）が`users`の集計に混入しうる点と除外方法」。

## 1. 何をしたか（結果は岩村様の報告に基づく記録）

- 動作確認用に作成された使い捨てのデモ試合・対抗戦ペアを、本番DB（`cheerstick_production`）から削除した（岩村様がTeraTermで実行）。
- **削除件数：** `cheer_logs` 277,134件、`ranking_snapshots` 8件（`ranking_snapshot_entries`はCASCADEで連動）、`event_battles` 3件、`events` 54件。
- 安全装置（下記のassert）はすべて成功。孤児データ（`cheer_logs.event_id IS NULL`）は削除前後とも0件。COMMIT済み、`VACUUM (ANALYZE) cheer_logs`実行済み。
- **削除前バックアップ：** `~/backups/cheerstick_production_20261007_052747.dump`（約14.5MB、`pg_dump -Fc`形式）。削除前に取得済み（岩村様の報告）。
- **残したもの：** 恒久デモ（試合`620f09c5`・`05efa49a`、対抗戦ペア`3d909ed3`、カテゴリー「デモ用」、チームEMUTTO・J SPORTS）、「実機検証20260917」「実機検証20260917（B）」と対抗戦ペア`ab600170`、hidden済みの【テスト】2試合、当日作成のテスト用live試合2件（`9f657ca2`・`c1826099`）。
- **削除しなかったもの：** デモ用デバイス（`is_demo`）とデモ用ユーザー（`demo-%@example.invalid`）。デモモードが同じデバイス・ユーザーを再利用するため。

## 2. 対象の決め方（今回の定義）

- **(A)** 指定6ペア（`37a40fdc`・`0012baea`・`5be87fb9`・`d0c76975`・`fdb9138d`・`925142a6`）のうち、**実行時点で存在していたペア**の両試合
- **(B)** 単発のデモ試合：ペアに紐づかず、タイトルが`デモ対抗戦 EMUTTO vs J SPORTS <日時>`または`デモ対抗戦 J SPORTS vs EMUTTO <日時>`で、`2026-09-28 09:17:06`以上`2026-10-07 00:00`未満に作成されたもの
- 恒久デモの2試合は常に除外（タイトルが`vs`を含まないため、パターンでも外れる）。
- UIの「削除」ボタン（`DELETE /event-battles/:id`、ペア行のみの物理削除）で先に消えたペアの試合は、ペアが無くなるため(B)として拾われる。実行時点では、当初6ペアのうち3ペアが既にUIで削除済みだったと、削除件数（3件）から読める。54試合の内訳は、3ペア×2＝6試合と単発48試合。
- **「タイトルで一括削除しない」：** 恒久デモの試合名（`デモ対抗戦 EMUTTO`・`デモ対抗戦 J SPORTS`）にも「デモ対抗戦」が含まれるため、パターンだけの削除は恒久デモを巻き込む。

## 3. 削除の方法（設計）

`events`を参照する外部キーの動作（`migrations/`で確認）：

| 子テーブル | 試合削除時の動作 |
|---|---|
| `cheer_logs`、`awards`、`ble_disconnect_logs` | `event_id`がNULLになる（**孤児化**） |
| `ranking_snapshots`→`ranking_snapshot_entries`、`event_battles`、`event_targets`、`cheer_summaries`、`device_event_sessions` | 連動して削除される |

- **順序（1トランザクション）：** `cheer_logs`を**先に明示削除**（試合を先に消すと孤児化するため）→ `ranking_snapshots` → `event_battles` → `events`。
- **`devices`・`users`は削除しない：** `cheer_logs.device_id`は`RESTRICT`（ログが残る限りデバイスは消せない）で、デモモードが再利用するため。
- **安全装置（件数が想定と違えば`1/0`のエラーで中断）：** 想定のペア数・試合数・応援ログ数／対象に`live`の試合・恒久デモ・直近10分の応援ログ・`awards`が無い／他のペアを巻き込まない。事後に、`event_id`がNULLの`cheer_logs`が削除前と同数であることを確認。
- **トランザクションは開いたまま終わる**（`psql`を対話モードで使う。`-f`で実行すると終了時に自動ROLLBACKされ、何も消えない）。出力を確認して手で`COMMIT`する。
- **一括で消す行数が多い場合：** 約50万行を超えるなら、`cheer_logs`の削除だけ分割（別トランザクション）する版を検討する（今回の約27万行は1トランザクションで実行した）。

## 4. 手順（今回実施したもの）

1. バックアップ：`sudo -u postgres pg_dump -Fc cheerstick_production -f ~/backups/cheerstick_production_<日時>.dump`（事前に`df -h /`で空き容量を確認、実行後にサイズが0でないことと`pg_restore -l`で読めることを確認する想定）
2. ドライラン（読み取り専用）を本番で実行：`sudo -u postgres psql -d cheerstick_production -f delete-demo-dryrun.sql`
3. 出力（特にセクション1・2・4のTOTAL・5・6）を確認。**セクション5の安全確認がすべて想定どおり**であること（`live_in_targets__expect_0`・`logs_last_10min__expect_0`・`protected_in_targets__expect_0`・`jikken_or_test_in_targets__expect_0`・`other_battles_touched__expect_0` が0、`protected_events_exist__expect_2`が2、`permanent_battle_exists__expect_1`が1）。`54 = 2 × battles_remaining ＋ single_events` の照合
4. 実行：`psql`を対話モードで開き、`\set expect_battles <battles_remaining>`・`\set expect_events 54`・`\set expect_logs 277134`、`\i delete-demo-exec.sql`。出力を確認して`COMMIT;`
5. 削除後：`event_id`がNULLの`cheer_logs`が削除前と同数であること、恒久デモ・実機検証が残っていることを確認。必要なら`VACUUM (ANALYZE) cheer_logs;`

## 5. 次回の作り直し方（このファイルを土台に、対象を洗い出し直す）

**そのまま実行しないこと。** 次回の対象（岩村様の指示）：残っているテスト用live試合2件（`9f657ca2`・`c1826099`、2026-10-07作成）と、今回の削除の前後に新たに実行したデモ分。

1. **まず今の状態を棚卸しする。** 本ファイル付録Aのドライランの「セクション1〜3・6」を土台に、デモ関連の全試合（作成日時・状態・応援ログ数・所属ペア）を一覧にする。
2. **固定値を全て更新する：**
   - 当初6ペアのID → 次回の削除対象ペアのID（ペアが無い／UIで削除済みなら空でよい）
   - 期間の下限・上限（`2026-09-28 09:17:06`／`2026-10-07 00:00`）→ 次回の範囲。上限を広げると、残したいデモ（直近のものなど）を巻き込みうるので、**期間ではなくIDで個別に指定する方が安全**
   - 恒久デモのID（試合`620f09c5-8ceb-45de-b35d-7bf47821950a`・`05efa49a-ca92-4190-94ff-eea24ec5033a`、ペア`3d909ed3-3207-4222-a6f9-a6c39980b910`）は変えない（常に除外）
   - 実行用SQLの`expect_*`は、ドライランの結果から決める（件数を推測で入れない）
3. **ドライランを先に実行し、安全確認を満たすこと。** 特に`live`の試合・直近10分の応援ログ・恒久デモ・実機検証の混入が0であること。`live`の試合は先に管理画面で「終了」する。
4. **バックアップを取ってから**実行する（`pg_dump -Fc`）。
5. 条件式（対象の決め方）を変えた場合は、**stagingの実PostgreSQL**で、トランザクション内に仕込んでROLLBACKする形で再検証する（pg-memでは`UPDATE … FROM`・相関サブクエリ・jsonb演算子が使えないため、実DBで確認する）。

## 6. 今回の検証と注意点

- **stagingでの検証（実PostgreSQL、トランザクション内に仕込んで最後にROLLBACK、16項目PASS）：** 当初6ペアのうち2ペアだけがUIで削除済みの状況、ドライランの見積りと実際に消えた件数の一致、想定件数違い／直近10分のログ／`live`の混入での中断（何も消えない）、孤児が増えないこと、デバイス・ユーザーが減らないこと、恒久デモ・期間外・実機検証・hidden済みの試合が残ること。
- **migration 013（`ble_disconnect_logs`）：** stagingには未適用で、BLE切断ログの確認文だけエラーになる（その文は独立させてあり、無視してよい。本番に013が入っていれば動く）。実行用SQLは`ble_disconnect_logs`を参照しない。
- **`Bash`ツールの落とし穴：** コマンド中の`\\`が`\`に変換され、`sed`やheredocで書いたpsqlメタコマンド（`\echo`・`\pset`）の先頭の`\`が落ちることがあった。SQLファイルはWriteツールで作成し、生成後に中身を確認する。
- **ドライランのセクション5は`logs_last_10min`等の「expect_0」列が0でなければ実行しない**、が運用ルール。

## 付録A. ドライランSQL（2026-10-07版・読み取り専用）

> 参考資料。ID・期間は今回限りの値（上記「5. 次回の作り直し方」を参照）。

```sql
-- 使い捨てデモ試合の削除：ドライラン v2（読み取り専用。何も変更しない）。2026-10-07更新。
-- 状況の変化（live試合の終了、UIでの一部ペア削除）に対応：当初の6ペアのうち「今も存在するもの」だけを対象とし、
-- ペアだけ消えた試合は「単発」として拾う。結果は毎回、現在のDBの状態から決まる。
SET default_transaction_read_only = on;
\pset pager off
\pset null '-'

\echo '=== 0. 接続先 ==='
SELECT current_database() AS db, current_user AS usr, now()::timestamp(0) AS now;

\echo '=== 1. 当初指定の6ペアは、今も存在するか（exists=false はUIで削除済み） ==='
SELECT v.id AS battle_id, (eb.id IS NOT NULL) AS exists_now, eb.label,
       ea.status AS a_status, ebv.status AS b_status, left(ea.id::text, 8) AS event_a, left(ebv.id::text, 8) AS event_b
FROM (SELECT unnest(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62','5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa','fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[]) AS id) v
LEFT JOIN event_battles eb ON eb.id = v.id
LEFT JOIN events ea  ON ea.id  = eb.event_a_id
LEFT JOIN events ebv ON ebv.id = eb.event_b_id
ORDER BY exists_now DESC, v.id;

\echo '=== 2. 問題のlive試合（9f657ca2…・c1826099…）の現在の状態 ==='
SELECT left(e.id::text, 8) AS id8, e.status, e.hidden_at IS NOT NULL AS hidden, e.created_at::timestamp(0) AS created, left(e.title, 44) AS title,
       (SELECT count(*) FROM cheer_logs c WHERE c.event_id = e.id) AS cheer_logs,
       (SELECT max(c.cheered_at)::timestamp(0) FROM cheer_logs c WHERE c.event_id = e.id) AS last_cheer,
       (SELECT string_agg(left(b.id::text, 8), ',') FROM event_battles b WHERE b.event_a_id = e.id OR b.event_b_id = e.id) AS battle,
       e.id
FROM events e
WHERE e.id::text LIKE '9f657ca2%' OR e.id::text LIKE 'c1826099%';

\echo '=== 3. デモ関連の全試合の現状（role：TARGET＝今回の削除対象／KEEP＝残す）。恒久デモは印付き ==='
WITH protected AS (
  SELECT unnest(ARRAY['620f09c5-8ceb-45de-b35d-7bf47821950a','05efa49a-ca92-4190-94ff-eea24ec5033a']::uuid[]) AS id
), del_battles AS (
  SELECT id, event_a_id, event_b_id FROM event_battles WHERE id = ANY(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62','5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa','fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[])
), tgt AS (
  SELECT event_a_id AS id, 'battle'::text AS src FROM del_battles
  UNION SELECT event_b_id, 'battle' FROM del_battles
  UNION SELECT e.id, 'single' FROM events e
    WHERE e.title ~ '^デモ対抗戦 (EMUTTO vs J SPORTS|J SPORTS vs EMUTTO) '
      AND e.created_at::timestamp(0) >= '2026-09-28 09:17:06'
      AND e.created_at::timestamp(0) <  '2026-10-07 00:00:00'
      AND NOT EXISTS (SELECT 1 FROM event_battles b WHERE b.event_a_id = e.id OR b.event_b_id = e.id)
      AND e.id NOT IN (SELECT id FROM protected)
)
SELECT e.created_at::timestamp(0) AS created, e.status,
       CASE WHEN e.id IN (SELECT id FROM protected) THEN 'KEEP(恒久デモ)'
            WHEN e.id IN (SELECT id FROM tgt) THEN 'TARGET'
            ELSE 'KEEP' END AS role,
       COALESCE(t.src, '') AS how,
       (e.hidden_at IS NOT NULL) AS hidden,
       left(e.title, 44) AS title,
       COALESCE((SELECT count(*) FROM cheer_logs c WHERE c.event_id = e.id), 0) AS cheer_logs,
       COALESCE((SELECT count(*) FROM ranking_snapshots s WHERE s.event_id = e.id), 0) AS snaps,
       (SELECT string_agg(left(b.id::text, 8) || CASE WHEN b.id = ANY(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62','5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa','fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[]) THEN '(当初6ペア)' ELSE '' END, ',')
          FROM event_battles b WHERE b.event_a_id = e.id OR b.event_b_id = e.id) AS battle,
       left(e.id::text, 8) AS id8
FROM events e LEFT JOIN tgt t ON t.id = e.id
WHERE e.title LIKE 'デモ対抗戦%' OR e.title LIKE '実機検証%' OR e.title LIKE '【テスト】%' OR e.id IN (SELECT id FROM tgt)
ORDER BY e.created_at;

\echo '=== 3b. 対抗戦ペア（event_battles）の現状（当初6ペア・恒久デモは印付き） ==='
SELECT eb.created_at::timestamp(0) AS created,
       CASE WHEN eb.id = '3d909ed3-3207-4222-a6f9-a6c39980b910' THEN 'KEEP(恒久デモ)'
            WHEN eb.id = ANY(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62','5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa','fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[]) THEN 'TARGET(当初6ペア)' ELSE '' END AS role,
       eb.label, ea.status AS a_status, ebv.status AS b_status, left(eb.id::text, 8) AS id8
FROM event_battles eb JOIN events ea ON ea.id = eb.event_a_id JOIN events ebv ON ebv.id = eb.event_b_id
ORDER BY eb.created_at;

\echo '=== 4. 再定義した削除対象と、消えるデータの行数（最終行 TOTAL が合計） ==='
WITH protected AS (
  SELECT unnest(ARRAY['620f09c5-8ceb-45de-b35d-7bf47821950a','05efa49a-ca92-4190-94ff-eea24ec5033a']::uuid[]) AS id
), del_battles AS (
  SELECT id, event_a_id, event_b_id FROM event_battles WHERE id = ANY(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62','5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa','fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[])
), tgt AS (
  SELECT event_a_id AS id, 'battle'::text AS src FROM del_battles
  UNION SELECT event_b_id, 'battle' FROM del_battles
  UNION SELECT e.id, 'single' FROM events e
    WHERE e.title ~ '^デモ対抗戦 (EMUTTO vs J SPORTS|J SPORTS vs EMUTTO) '
      AND e.created_at::timestamp(0) >= '2026-09-28 09:17:06'
      AND e.created_at::timestamp(0) <  '2026-10-07 00:00:00'
      AND NOT EXISTS (SELECT 1 FROM event_battles b WHERE b.event_a_id = e.id OR b.event_b_id = e.id)
      AND e.id NOT IN (SELECT id FROM protected)
), per AS (
  SELECT e.created_at::timestamp(0) AS created, e.status, t.src, left(e.title, 44) AS title, left(e.id::text, 8) AS id8,
         COALESCE(cl.n, 0) AS cheer_logs, COALESCE(cl.u, 0) AS with_user,
         COALESCE(rs.n, 0) AS snapshots, COALESCE(rse.n, 0) AS snap_entries,
         COALESCE(aw.n, 0) AS awards, COALESCE(cs.n, 0) AS summaries, COALESCE(ds.n, 0) AS sessions,
         COALESCE(et.n, 0) AS ev_targets
  FROM tgt t JOIN events e ON e.id = t.id
  LEFT JOIN (SELECT event_id, count(*) n, count(user_id) u FROM cheer_logs WHERE event_id IN (SELECT id FROM tgt) GROUP BY event_id) cl ON cl.event_id = e.id
  LEFT JOIN (SELECT event_id, count(*) n FROM ranking_snapshots WHERE event_id IN (SELECT id FROM tgt) GROUP BY event_id) rs ON rs.event_id = e.id
  LEFT JOIN (SELECT s.event_id, count(*) n FROM ranking_snapshot_entries x JOIN ranking_snapshots s ON s.id = x.snapshot_id WHERE s.event_id IN (SELECT id FROM tgt) GROUP BY s.event_id) rse ON rse.event_id = e.id
  LEFT JOIN (SELECT event_id, count(*) n FROM awards WHERE event_id IN (SELECT id FROM tgt) GROUP BY event_id) aw ON aw.event_id = e.id
  LEFT JOIN (SELECT event_id, count(*) n FROM cheer_summaries WHERE event_id IN (SELECT id FROM tgt) GROUP BY event_id) cs ON cs.event_id = e.id
  LEFT JOIN (SELECT event_id, count(*) n FROM device_event_sessions WHERE event_id IN (SELECT id FROM tgt) GROUP BY event_id) ds ON ds.event_id = e.id
  LEFT JOIN (SELECT event_id, count(*) n FROM event_targets WHERE event_id IN (SELECT id FROM tgt) GROUP BY event_id) et ON et.event_id = e.id
)
SELECT 0 AS ord, created, status, src, title, id8, cheer_logs, with_user, snapshots, snap_entries, awards, summaries, sessions, ev_targets FROM per
UNION ALL
SELECT 1, NULL, NULL, 'TOTAL', count(*)::text || ' events', NULL, sum(cheer_logs), sum(with_user), sum(snapshots), sum(snap_entries), sum(awards), sum(summaries), sum(sessions), sum(ev_targets) FROM per
ORDER BY ord, created;

\echo '=== 5. 安全確認（expect が付く列はすべて想定どおりであること。liveが混ざっていれば live_in_targets__expect_0 が0でなくなる） ==='
WITH protected AS (
  SELECT unnest(ARRAY['620f09c5-8ceb-45de-b35d-7bf47821950a','05efa49a-ca92-4190-94ff-eea24ec5033a']::uuid[]) AS id
), del_battles AS (
  SELECT id, event_a_id, event_b_id FROM event_battles WHERE id = ANY(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62','5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa','fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[])
), tgt AS (
  SELECT event_a_id AS id, 'battle'::text AS src FROM del_battles
  UNION SELECT event_b_id, 'battle' FROM del_battles
  UNION SELECT e.id, 'single' FROM events e
    WHERE e.title ~ '^デモ対抗戦 (EMUTTO vs J SPORTS|J SPORTS vs EMUTTO) '
      AND e.created_at::timestamp(0) >= '2026-09-28 09:17:06'
      AND e.created_at::timestamp(0) <  '2026-10-07 00:00:00'
      AND NOT EXISTS (SELECT 1 FROM event_battles b WHERE b.event_a_id = e.id OR b.event_b_id = e.id)
      AND e.id NOT IN (SELECT id FROM protected)
)
SELECT (SELECT count(*) FROM del_battles)                                                      AS battles_remaining,
       (SELECT count(*) FROM tgt WHERE src = 'battle')                                         AS battle_events__expect_2x_remaining,
       (SELECT count(*) FROM tgt WHERE src = 'single')                                         AS single_events,
       (SELECT count(*) FROM tgt t JOIN events e ON e.id = t.id WHERE e.status = 'live')       AS live_in_targets__expect_0,
       (SELECT count(*) FROM tgt t JOIN events e ON e.id = t.id WHERE e.status = 'paused')     AS paused_in_targets_info,
       (SELECT count(*) FROM cheer_logs c WHERE c.event_id IN (SELECT id FROM tgt) AND c.cheered_at > now() - interval '10 minutes') AS logs_last_10min__expect_0,
       (SELECT count(*) FROM tgt WHERE id IN (SELECT id FROM protected))                       AS protected_in_targets__expect_0,
       (SELECT count(*) FROM tgt t JOIN events e ON e.id = t.id WHERE e.title LIKE '実機検証%' OR e.title LIKE '【テスト】%') AS jikken_or_test_in_targets__expect_0,
       (SELECT count(*) FROM event_battles b WHERE (b.event_a_id IN (SELECT id FROM tgt) OR b.event_b_id IN (SELECT id FROM tgt))
                                                   AND b.id NOT IN (SELECT id FROM del_battles)) AS other_battles_touched__expect_0,
       (SELECT count(*) FROM events WHERE id IN (SELECT id FROM protected))                    AS protected_events_exist__expect_2,
       (SELECT count(*) FROM event_battles WHERE id = '3d909ed3-3207-4222-a6f9-a6c39980b910')                        AS permanent_battle_exists__expect_1;

\echo '=== 6. 参考：同じパターンだが今回の対象に“入らない”試合（残るもの。追加したいものがあれば、この id を指定してください） ==='
WITH protected AS (
  SELECT unnest(ARRAY['620f09c5-8ceb-45de-b35d-7bf47821950a','05efa49a-ca92-4190-94ff-eea24ec5033a']::uuid[]) AS id
), del_battles AS (
  SELECT id, event_a_id, event_b_id FROM event_battles WHERE id = ANY(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62','5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa','fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[])
), tgt AS (
  SELECT event_a_id AS id, 'battle'::text AS src FROM del_battles
  UNION SELECT event_b_id, 'battle' FROM del_battles
  UNION SELECT e.id, 'single' FROM events e
    WHERE e.title ~ '^デモ対抗戦 (EMUTTO vs J SPORTS|J SPORTS vs EMUTTO) '
      AND e.created_at::timestamp(0) >= '2026-09-28 09:17:06'
      AND e.created_at::timestamp(0) <  '2026-10-07 00:00:00'
      AND NOT EXISTS (SELECT 1 FROM event_battles b WHERE b.event_a_id = e.id OR b.event_b_id = e.id)
      AND e.id NOT IN (SELECT id FROM protected)
)
SELECT e.created_at::timestamp(0) AS created, e.status, left(e.title, 44) AS title,
       (SELECT count(*) FROM cheer_logs c WHERE c.event_id = e.id) AS cheer_logs,
       EXISTS (SELECT 1 FROM event_battles b WHERE b.event_a_id = e.id OR b.event_b_id = e.id) AS in_battle, e.id
FROM events e
WHERE e.title LIKE 'デモ対抗戦%' AND e.id NOT IN (SELECT id FROM tgt) AND e.id NOT IN (SELECT id FROM protected)
ORDER BY e.created_at;

\echo '=== 7. 削除前のベースライン（削除後に比較する） ==='
SELECT (SELECT count(*) FROM cheer_logs)                           AS cheer_logs_total,
       (SELECT count(*) FROM cheer_logs WHERE event_id IS NULL)    AS cheer_logs_event_null__must_not_change,
       (SELECT count(*) FROM events)                               AS events_total,
       (SELECT count(*) FROM event_battles)                        AS battles_total,
       (SELECT count(*) FROM ranking_snapshots)                    AS snapshots_total,
       pg_size_pretty(pg_total_relation_size('cheer_logs'))        AS cheer_logs_size;

\echo '=== 8. 参考：BLE切断ログ（ble_disconnect_logs, migration 013）。未適用のDBではこの1文だけエラーになるが無視してよい ==='
WITH protected AS (
  SELECT unnest(ARRAY['620f09c5-8ceb-45de-b35d-7bf47821950a','05efa49a-ca92-4190-94ff-eea24ec5033a']::uuid[]) AS id
), del_battles AS (
  SELECT id, event_a_id, event_b_id FROM event_battles WHERE id = ANY(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62','5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa','fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[])
), tgt AS (
  SELECT event_a_id AS id, 'battle'::text AS src FROM del_battles
  UNION SELECT event_b_id, 'battle' FROM del_battles
  UNION SELECT e.id, 'single' FROM events e
    WHERE e.title ~ '^デモ対抗戦 (EMUTTO vs J SPORTS|J SPORTS vs EMUTTO) '
      AND e.created_at::timestamp(0) >= '2026-09-28 09:17:06'
      AND e.created_at::timestamp(0) <  '2026-10-07 00:00:00'
      AND NOT EXISTS (SELECT 1 FROM event_battles b WHERE b.event_a_id = e.id OR b.event_b_id = e.id)
      AND e.id NOT IN (SELECT id FROM protected)
)
SELECT count(*) AS ble_logs_for_target_events__expect_0 FROM ble_disconnect_logs WHERE event_id IN (SELECT id FROM tgt);
```

## 付録B. 実行用SQL（2026-10-07版・書き込みあり）

> 参考資料。**そのまま実行しない。** `psql`対話モードで、`\set expect_battles` `\set expect_events` `\set expect_logs` を設定してから`\i`で読み込み、確認後に手で`COMMIT`／`ROLLBACK`する設計だった。

```sql
-- 使い捨てデモ試合の削除：実行用（★書き込みあり。ドライランの結果をご確認・ご承認の後にのみ使う）。
-- 使い方：psqlを対話モードで開き（sudo -u postgres psql -d cheerstick_production）、
--   \set expect_battles 6
--   \set expect_events <ドライランの「12＋single_events」の合計>
--   \set expect_logs <ドライランTOTALのcheer_logs>
--   \i delete-demo-exec.sql
-- を実行する。トランザクションは開いたまま終わる。出力を確認し、問題なければ COMMIT; 、想定外なら ROLLBACK;
-- （件数が想定と違うと、途中で 1/0 のエラーになり、以降は実行されない。その場合は ROLLBACK;）
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE TEMP TABLE del_events AS
WITH protected AS (
  SELECT unnest(ARRAY['620f09c5-8ceb-45de-b35d-7bf47821950a','05efa49a-ca92-4190-94ff-eea24ec5033a']::uuid[]) AS id
), del_battles AS (
  SELECT id, event_a_id, event_b_id FROM event_battles
  WHERE id = ANY(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62',
                       '5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa',
                       'fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[])
)
SELECT event_a_id AS id FROM del_battles
UNION SELECT event_b_id FROM del_battles
UNION SELECT e.id FROM events e
  WHERE e.title ~ '^デモ対抗戦 (EMUTTO vs J SPORTS|J SPORTS vs EMUTTO) '
    AND e.created_at::timestamp(0) >= '2026-09-28 09:17:06'
    AND e.created_at::timestamp(0) <  '2026-10-07 00:00:00'
    AND NOT EXISTS (SELECT 1 FROM event_battles b WHERE b.event_a_id = e.id OR b.event_b_id = e.id)
    AND e.id NOT IN (SELECT id FROM protected);

CREATE TEMP TABLE del_battles AS
SELECT id FROM event_battles
WHERE id = ANY(ARRAY['37a40fdc-3bf8-4b20-95d6-02a6e0ec8a93','0012baea-f278-409b-8d24-777f307a8d62',
                     '5be87fb9-bae7-4f1e-991b-20a96e26f4c3','d0c76975-f4e4-4cb3-a6fe-1c0fe11ff8fa',
                     'fdb9138d-b32d-4228-b592-ec502ec5684a','925142a6-684c-43bc-a5fe-909128fd6dc5']::uuid[]);

-- 0. 事前アサート（想定と違えば 1/0 でエラー → ROLLBACK）
SELECT 1 / (CASE WHEN (SELECT count(*) FROM del_battles) = :expect_battles THEN 1 ELSE 0 END) AS assert_battles;
SELECT 1 / (CASE WHEN (SELECT count(*) FROM del_events)  = :expect_events  THEN 1 ELSE 0 END) AS assert_events;
SELECT 1 / (CASE WHEN (SELECT count(*) FROM cheer_logs WHERE event_id IN (SELECT id FROM del_events)) = :expect_logs THEN 1 ELSE 0 END) AS assert_logs;
SELECT 1 / (CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE id IN (SELECT id FROM del_events)
                                    AND (status = 'live' OR id IN ('620f09c5-8ceb-45de-b35d-7bf47821950a','05efa49a-ca92-4190-94ff-eea24ec5033a'))) THEN 1 ELSE 0 END) AS assert_no_live_no_protected;
SELECT 1 / (CASE WHEN NOT EXISTS (SELECT 1 FROM event_battles b WHERE (b.event_a_id IN (SELECT id FROM del_events) OR b.event_b_id IN (SELECT id FROM del_events))
                                    AND b.id NOT IN (SELECT id FROM del_battles)) THEN 1 ELSE 0 END) AS assert_no_other_battles;

-- 対象の試合に、直近10分以内の応援ログが無いこと（終了したはずの試合へ書き込みが続いていないこと）
SELECT 1 / (CASE WHEN NOT EXISTS (SELECT 1 FROM cheer_logs WHERE event_id IN (SELECT id FROM del_events) AND cheered_at > now() - interval '10 minutes') THEN 1 ELSE 0 END) AS assert_no_recent_logs;
-- awardsはON DELETE SET NULLで孤児化するため、対象試合に紐づくawardsが0件であること
SELECT 1 / (CASE WHEN NOT EXISTS (SELECT 1 FROM awards WHERE event_id IN (SELECT id FROM del_events)) THEN 1 ELSE 0 END) AS assert_no_awards;

-- ベースライン（孤児チェック用）
SELECT count(*) AS event_null_before FROM cheer_logs WHERE event_id IS NULL \gset

-- 1. 応援ログを先に明示削除（eventsを先に消すとevent_idがNULL化して孤児になるため、必ずこれが先）
DELETE FROM cheer_logs WHERE event_id IN (SELECT id FROM del_events);
-- 2. 順位確定スナップショット（ranking_snapshot_entriesはON DELETE CASCADEで連動）
DELETE FROM ranking_snapshots WHERE event_id IN (SELECT id FROM del_events);
-- 3. 対抗戦ペア（元の試合は消えない）
DELETE FROM event_battles WHERE id IN (SELECT id FROM del_battles);
-- 4. 試合本体（event_targets・cheer_summaries・device_event_sessionsはCASCADE。awards・ble_disconnect_logsはSET NULLだが事前に0件を確認する）
DELETE FROM events WHERE id IN (SELECT id FROM del_events);

-- 5. 事後確認
SELECT 1 / (CASE WHEN (SELECT count(*) FROM cheer_logs WHERE event_id IS NULL) = :event_null_before THEN 1 ELSE 0 END) AS assert_no_orphans;
SELECT (SELECT count(*) FROM events WHERE id IN (SELECT id FROM del_events))              AS remaining_target_events__expect_0,
       (SELECT count(*) FROM cheer_logs WHERE event_id IS NULL)                           AS cheer_logs_event_null_after,
       (SELECT count(*) FROM events WHERE id IN ('620f09c5-8ceb-45de-b35d-7bf47821950a','05efa49a-ca92-4190-94ff-eea24ec5033a')) AS permanent_events_remaining__expect_2,
       (SELECT count(*) FROM event_battles WHERE id = '3d909ed3-3207-4222-a6f9-a6c39980b910') AS permanent_battle_remaining__expect_1;

\echo '*** ここまで成功。上の件数が想定どおりなら COMMIT; 、違えば ROLLBACK; を入力してください（トランザクションは開いたままです） ***'
```
