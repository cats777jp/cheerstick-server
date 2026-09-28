# レート制限再設計（トラックA）本番反映 手順書

> **2026-09-28追記：本番反映は`docs/tasks/2026-09-28-rollout-track-a-and-gauge.md`
> （ゲージ「直近の勢い」表示との統合版）を使用すること。** 本書はSTEP B（ブランチ統合）
> 完了時点の記録として残す（STEP C以降は当時案として履歴保存、内容は統合版に引き継ぎ済み）。

作成日：2026-09-28
対象：岩村様（TeraTermでの手動実行。本番EC2へのSSH・書き込みはすべて岩村様が行う）
関連：`cheerstick-track-a-rate-limit-20260928.md`（指示書）、
　　　`docs/proposals/large-event-scaling.md`、`docs/spec.md`「大規模イベント対応」節、
　　　ブランチ`feature/rate-limit-large-event`

---

## 0. 前提

- 変更対象：`src/app.js`・`src/middleware/rateLimit.js`（新規）・
  `src/middleware/scoreCache.js`（新規）・`src/routes/webview.js`・
  `src/routes/admin.js`・`src/routes/eventBattles.js`・`src/routes/targetScores.js`・
  `src/routes/rankingSnapshots.js`・`.env.example`
- **DBのマイグレーション・スキーマ変更は無い。`package.json`への依存追加も無い**
  （`express-rate-limit`は既存の依存をそのまま使用）
- 既定値のままなら`.env`への追記は不要（未設定でも動く設計）
- WebSocket接続には影響しない変更だが、`pm2 restart`自体で**確立中のWebSocket接続が
  一度切れる**（再接続はクライアント側の自動再接続で回復する）

---

## STEP A：事前準備

1. 本番EC2へSSH
   ```bash
   ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126
   ```
2. 現在のHEADを確認する
   ```bash
   git -C /home/ubuntu/cheerstick-server-new log --oneline -1
   ```
3. リポジトリバックアップ（gitタグ方式、`docs/runbook.md`「リポジトリバックアップ手順」参照）
   ```bash
   # ローカルPC側（C:\Projects\cheerstick-server）で実行
   git fetch origin
   git tag feature-reference-data-20260928ver origin/feature/reference-data
   git push origin feature-reference-data-20260928ver
   ```
4. 本番DBバックアップ（`docs/runbook.md`のpg_dump手順）
   ```bash
   # 本番EC2上
   mkdir -p ~/backups
   FILE=~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
   sudo -u postgres pg_dump cheerstick_production > $FILE
   ls -la $FILE   # サイズが非ゼロであることを確認
   ```
5. 確立中のWebSocket接続数を確認し、実機テストと重ならない時間帯であることを確認する
   ```bash
   ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l
   ```

---

## STEP B：ブランチの統合（**統合済み**）

> **2026-09-28追記：本STEPは完了済み。** `feature/rate-limit-large-event`
> （コード`8ed487f`・docs`9fbec8e`）を`feature/reference-data`へマージした
> （マージコミット`42b22ad`）。`docs/worklog.md`の衝突（両ブランチとも同日エントリを
> 追記していたため）は、両方の記述を残す形で解決した。マージ後、
> `scripts/demo/local-verify.js`（既存27項目）・`scripts/rate-limit/local-verify.js`
> （追加26チェック）とも全PASSを確認した。**以降の本番反映は、本書ではなく統合版の
> `docs/tasks/2026-09-28-rollout-track-a-and-gauge.md`を使うこと**（ゲージ
> 「直近の勢い」表示・猛攻演出との反映順序を合わせて手順化してある）。

---

## STEP C：`.env`（必要な場合のみ）

**既定値のままでよい場合、このSTEPは不要。** 値を変更する場合のみ実施する。

```bash
# 本番EC2上
cp /home/ubuntu/cheerstick-server-new/.env /home/ubuntu/cheerstick-server-new/.env.bak_20260928
vi /home/ubuntu/cheerstick-server-new/.env
# 例：RL_AUDIENCE_IP_MAX=50000 などを追記
```

---

## STEP D：本番へのコード反映

```bash
# 本番EC2上
cd /home/ubuntu/cheerstick-server-new
git pull
git log --oneline -1   # STEP Bでpushしたマージコミットに到達していることを確認
```

`src/`のみの変更で、静的ファイル（`public/`）・マイグレーションの変更は無いため、
`cp`（静的ファイルのデプロイ）・`node src/db/migrate.js`は不要。

---

## STEP E：pm2再起動

**確立中のWebSocket接続が一度切れる。** STEP A-5で確認した接続数・時間帯を踏まえ、
実施タイミングを判断すること。

```bash
pm2 restart cheerstick-server --update-env
pm2 logs cheerstick-server --lines 50 --nostream
```

起動ログに`[rate-limit] config: ...`の行が出力され、値が意図どおり（`.env`を変更した
場合はその値、変更していない場合は既定値）であることを確認する。エラーが無いことを
確認する。

---

## STEP F：反映後の確認

1. `geturl`のレスポンスヘッダーで、新しい上限になっていることを確認する
   ```bash
   curl -sD - "https://api.cheerstick.com/api/v1/webview/geturl?id=AA:BB:CC:DD:EE:FF" -o /dev/null | grep -i ratelimit
   # RateLimit-Policy: 50000;w=900 のような値になっていることを確認（.envで変更していなければ既定値）
   ```
2. `pm2 logs`にエラーが無いこと
3. 対抗戦画面（`https://app.cheerstick.com/battle.html?battle_id=<恒久デモのbattle_id>`）が
   引き続き更新されることを確認する（スコアキャッシュ導入後も表示が壊れていないこと）
4. 管理画面から`GET /admin/events`等、通常の管理操作が引き続きできることを確認する
   （管理APIが別枠になったことで問題が起きていないか）

---

## STEP G：反映前後のストーム比較

**WebARENA VPS（`161.34.35.70`、`docs/runbook.md`「WebARENA デモ実行環境」参照）で
実行する。** `cheerdemo`ユーザーで、`/home/cheerdemo/cheerstick-demo`に本ブランチの
コードを反映してから実行する（`docs/runbook.md`のgit bundle手順を使う）。

1. **反映前**（STEP D・Eを行う前に、あらかじめ実行しておく）：
   ```bash
   node scripts/demo/geturl-storm.js --count=1000 --duration-sec=60 --concurrency=20
   ```
   旧仕様（IPごとに15分500回）のため、**500回付近で429になり始める想定。**
2. **反映後**（STEP F完了後）：**旧実行から15分以上空けてから**同じ条件で実行する
   （WebARENAのIPも枠を持つため。空けないと旧実行分の残り枠が影響する）
   ```bash
   node scripts/demo/geturl-storm.js --count=1000 --duration-sec=60 --concurrency=20
   ```
   新仕様（IPごとに15分50,000回・デバイスごとに15分60回、既定値のまま）のため、
   **`--count=1000`（デバイスごとの上限60回に対し1回ずつ・IPごとの上限に対しても
   十分小さい）であれば、すべて200になる想定。**
3. 2回の実行結果（`=== summary ===`の内容）を比較し、429の発生状況が想定どおり
   変化したことを記録する。

---

## 巻き戻し

問題が発生した場合：

```bash
# ローカルPCで、マージコミットを打ち消すrevertを作成してpush
git revert -m 1 <マージコミットのハッシュ>
git push origin feature/reference-data
```

```bash
# 本番EC2上
cd /home/ubuntu/cheerstick-server-new
git pull
pm2 restart cheerstick-server --update-env
```

`git reset`で本番のHEADを直接戻す方法も使えるが、**originの履歴と本番の履歴が
食い違う状態になる**ため、他の変更と混ざっていないか特に注意すること
（`docs/worklog.md` 2026-09-21エントリで実際に発生した「本番のgit historyが
originと単純比較できない状態」と同じ問題を避けるため、通常は`revert`を推奨する）。
