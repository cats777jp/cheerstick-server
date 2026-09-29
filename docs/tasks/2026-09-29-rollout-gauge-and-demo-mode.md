# ゲージの調整＋デモモード機能 本番反映 手順書

作成日：2026-09-29
対象：岩村様（TeraTermでの手動実行。本番EC2へのSSH・書き込みはすべて岩村様が行う）
関連：`cheerstick-rollout-gauge-and-demo-mode-prep-20260929.md`（指示書）、
　　　`docs/proposals/demo-mode-admin-ui.md`（実装前調査）、
　　　`docs/spec.md` 9.12章（デモモード）・9.4章（ゲージ調整の追記部分）、
　　　`docs/tasks/2026-09-28-rollout-track-a-and-gauge.md`（構成を踏襲した前回手順書）

---

## 0. 前提

- 本番の現在のHEAD：`d043b67`（2026-09-28夜〜29朝に反映済み、トラックA＋ゲージ調整の前バージョン）
- 今回反映する範囲：`d043b67` から `30784be` まで（本書作成時点のローカル`feature/reference-data`のHEAD）
- 含まれる変更（`git diff --stat d043b67..HEAD`で確認済み、詳細は1-1参照）：
  - ゲージの調整（`1180e9a`）：`public/battle.html`のみ
  - デモモード機能（`c8d9e71`・`251ff2c`）：`src/controllers/adminDemoController.js`（新規）・
    `src/services/demoModeState.js`（新規）・`src/routes/admin.js`・`src/index.js`・
    `public/admin/events.html`・`scripts/demo/local-verify-demo-mode.js`（新規）
  - ドキュメントのみ（`76f8383`・`1e23596`・`89fd7d3`・`30784be`）：`docs/`配下
- **`package.json`・`package-lock.json`・`migrations/`に変更は無い**（1-1で確認済み）。
  本番で`npm install`・`node src/db/migrate.js`は不要
- **`src/`の変更を含むため、`pm2 restart`が必要**（トラックA反映時と同じ扱い）。
  **確立中のWebSocket接続が一度切れる。** 実機テストと重ならない時間帯に実施する
- **管理画面の静的ファイル（`public/admin/events.html`）にも変更がある。**
  `git pull`だけでは`admin.cheerstick.com`の配信内容（`/var/www/cheerstick-admin/`）は
  更新されない。**`battle.html`だけでなく`events.html`も`sudo cp`が必要**
  （見落としやすい点。下記STEP 2参照。`docs/runbook.md`「管理画面は6ファイル構成」節と
  同じ構造の問題）

---

## 1. 反映前の確認結果（Claude Codeが実施済み。読み取りのみ、本番へは未反映）

### 1-1. 差分の確認

```
$ git diff --stat d043b67..HEAD
 docs/proposals/demo-mode-admin-ui.md   | 246 ++++++++++++++++++++++
 docs/runbook.md                        |  14 ++
 docs/spec.md                           | 182 ++++++++++++++++
 docs/worklog.md                        | 194 +++++++++++++++++
 public/admin/events.html               | 125 +++++++++++
 public/battle.html                     |  59 +++++-
 scripts/demo/local-verify-demo-mode.js | 368 +++++++++++++++++++++++++++++++++
 src/controllers/adminDemoController.js | 259 +++++++++++++++++++++++
 src/index.js                           |  14 ++
 src/routes/admin.js                    |   7 +
 src/services/demoModeState.js          | 104 ++++++++++
 11 files changed, 1565 insertions(+), 7 deletions(-)
```

- `src/`：`controllers/adminDemoController.js`（新規）・`services/demoModeState.js`（新規）・
  `routes/admin.js`（デモAPI4本の追加）・`index.js`（pm2再起動時の子プロセスkill処理追加）
- `public/`：`battle.html`（ゲージの揺れ停止・range中央寄せ）・`admin/events.html`
  （デモモードカード新設）
- `scripts/`：`demo/local-verify-demo-mode.js`（新規、ローカル確認専用。本番には影響しない）
- `docs/`：`proposals/demo-mode-admin-ui.md`（新規）・`spec.md`・`runbook.md`・`worklog.md`
- **`package.json`・`package-lock.json`・`migrations/`：変更無し**（`git diff --stat`の
  出力に含まれないことで確認済み）。本番での`npm install`・マイグレーション適用は不要

### 1-2. 既存テストの最終確認（現在のHEAD、`30784be`で実施）

| スクリプト | 結果 |
|---|---|
| `scripts/demo/local-verify.js` | PASS=27 FAIL=0 |
| `scripts/rate-limit/local-verify.js` | PASS=26 FAIL=0 |
| `scripts/demo/local-verify-demo-mode.js` | PASS=29 FAIL=0 |

いずれも全PASS（回帰無し）。

---

## 2. 全体の順序（6ステップ）

STEP 0（本番事前確認・バックアップ）→ STEP 1（本番`git pull`）→
STEP 2（静的ファイル2件のコピー・`diff`確認）→ STEP 3（`pm2 restart --update-env`）→
STEP 4（デモモードの疎通確認）→ STEP 5（後片付け）

---

## STEP 0：本番の事前確認とバックアップ

```bash
ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126
```

1. 現在のHEAD（`d043b67`のはず）
   ```bash
   git -C /home/ubuntu/cheerstick-server-new log --oneline -1
   ```
2. 確立中の接続数・pm2の再起動回数（現在9のはず、反映後は10になる想定）
   ```bash
   ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l
   pm2 list
   ```
3. ロールバック用のgitタグを**ローカルPCで**作成する。

   **⚠️ 本番EC2のDeploy Key（読み取り専用）では`push`が失敗する。
   必ずローカルPC（`C:\Projects\cheerstick-server`）で実行すること**
   （9/28の反映時に、本番EC2上でタグをpushしようとして一度つまずいた事例あり。
   `docs/worklog.md`2026-09-28エントリ参照）。

   ```bash
   git tag prod-before-gauge-and-demo-mode-20260929 d043b67
   git push origin prod-before-gauge-and-demo-mode-20260929
   ```
4. 本番DBバックアップ（`pg_dump`。**本番EC2上で実行**。デモモードの`setup`が、
   本番DBへ試合・対抗戦ペアの書き込みを行うため必須）
   ```bash
   mkdir -p ~/backups
   FILE=~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
   sudo -u postgres pg_dump cheerstick_production > $FILE
   ls -la $FILE   # サイズが非ゼロであることを確認
   ```

**確認項目：** HEAD・接続数・pm2再起動回数（9）を記録した、gitタグ・DBバックアップとも
成功した。
**中断の基準：** DBバックアップのサイズが0、または`pg_dump`がエラー終了した場合は、
原因を確認できるまで先へ進まない。

---

## STEP 1：本番へ`git pull`

**本番EC2上で実行する。**

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
git log --oneline -1   # 30784be（またはその時点の最新）に到達していることを確認
git status             # コンフリクトが無いこと、意図しないローカル変更が無いことを確認
```

`Fast-forward`で完了するはず（本番側に独自コミットが無ければコンフリクトは起きない）。

`src/`のみでマイグレーション・`package.json`の変更は無いため、
`node src/db/migrate.js`・`npm install`は不要（1-1で確認済み）。

**確認項目：** `git log`のHEADが`30784be`（想定コミット）に一致すること。`git status`が
コンフリクト・意図しない差分無しであること。
**中断の基準：** `git pull`がコンフリクト等で失敗した場合、原因を確認できるまで
STEP 2へ進まない。

---

## STEP 2：静的ファイル2件のコピーと`diff`確認

**⚠️ 今回は`battle.html`だけでなく`events.html`も対象。** どちらも`git pull`だけでは
配信内容が変わらない（`docs/runbook.md`「デプロイ手順」「管理画面は6ファイル構成」節と
同じ構造の問題）。

**本番EC2上で実行する。**

```bash
cd /home/ubuntu/cheerstick-server-new

# (a) 対抗戦画面（app.cheerstick.com）
sudo cp public/battle.html /var/www/cheerstick-app/battle.html
diff /var/www/cheerstick-app/battle.html /home/ubuntu/cheerstick-server-new/public/battle.html && echo "battle.html: OK"

# (b) 管理画面（admin.cheerstick.com） ※デモモードカードの表示に必要
sudo cp public/admin/events.html /var/www/cheerstick-admin/events.html
diff /var/www/cheerstick-admin/events.html /home/ubuntu/cheerstick-server-new/public/admin/events.html && echo "events.html: OK"
```

いずれも**既存ファイルへの上書きコピー**のため（新規ファイルではない）、
`chown`/`chmod`は不要＝所有者・パーミッションは既存のまま引き継がれる
（`docs/runbook.md`「新規ファイルをコピーした場合は所有者も確認する」節の対象外）。

**確認項目：** 2件とも`diff`が差分無しで終了すること。
**中断の基準：** `diff`に差分が出た場合、反映は完了していない。原因を確認してから
先へ進む。

---

## STEP 3：`pm2 restart --update-env`

**確立中のWebSocket接続が一度切れる。** STEP 0で確認した接続数・時間帯を踏まえ、
実機テストと重ならないタイミングで実施する。実施直前に、もう一度接続数を確認しておく。

```bash
ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l   # 最終確認
pm2 restart cheerstick-server --update-env
pm2 logs cheerstick-server --lines 50 --nostream
```

**確認項目：**
- 新しいエラーが無いこと
- `[rate-limit] config: ...`の行が引き続き出力されること（既存のトラックA設定が
  変わっていないことの確認）
- `pm2 list`の再起動回数が9→10（+1のみ）になっていること

**中断の基準：** 起動ログにエラーが出る、または`pm2 list`が`errored`表示になった場合、
STEP 4へ進まずロールバック（本書末尾）を検討する。

---

## STEP 4：デモモードの疎通確認

**本番EC2上（`curl`部分）・ブラウザ（KMT様のPC等、`admin.cheerstick.com`にIP制限経由で
アクセス可能な環境）の両方を使う。**

1. 初期状態の確認
   ```bash
   curl http://127.0.0.1:3000/api/v1/admin/demo/status
   # {"status":"idle","battleId":null,"screenUrl":null,"elapsedMs":null,"remainingMs":null}
   ```
2. `admin.cheerstick.com/events.html`をブラウザでハードリロードして開き、
   「デモモード」カードが表示されることを確認する（状態: 未セット）
3. 「①デモをセット」を押す
   - `curl`で`GET /admin/demo/status`を再実行し、`status:"set"`・`battleId`・
     `screenUrl`（`/battle.html?battle_id=...&gauge=recent&poll=1000`）が
     返ることを確認する
   - 画面上も「セット済み」に変わることを確認する
   - 対象チームは、「デモ用」カテゴリーの既存チームのうち作成日時が最も古い2件
     （通常は`EMUTTO`・`J SPORTS`のはず）が自動的に選ばれる。指示書とは異なり
     チーム名はハードコードしていないため、**もしチーム名が変わっていても
     そのまま動く**（`docs/spec.md` 9.12章の2026-09-29追記参照）
4. 「③表示画面を開く」を押す
   - 対抗戦画面が新しいタブで開き、**0:0**で表示されることを確認する
5. 「②デモを開始」を押す
   - ボタンが「デモを停止」に変わり、カウントダウン表示が始まることを確認する
   - 対抗戦画面のタブで、スコア・ゲージが実際に動くことを確認する（60秒間）
   - **60秒〜70秒程度**で自動的に「セット済み」（①の状態）に戻ることを確認する
     （`battle-demo.js`の自動終了判定は10秒間隔の定期チェックのため、
     ちょうど60秒ではなく最大70秒程度かかる場合がある。`docs/spec.md` 9.12章参照。
     これは想定内の挙動であり、70秒を明確に超えて`running`のままの場合のみ異常とみなす）
   - `pm2 logs cheerstick-server --lines 100 --nostream`で、`[demo-child]`
     プレフィックス付きのログ（`battle-demo.js`の標準出力）が出力されていることを確認する
6. 「②デモを開始」をもう一度押し、実行中に「デモを停止」を押す
   - **10秒以内**に「セット済み」へ戻ることを確認する
7. ページをリロードする
   - 状態（`set`）・`battleId`・`screenUrl`が復元され、ボタンの活性/非活性も
     正しく戻ることを確認する

**確認項目：** 上記1〜7すべてが想定どおりであること。
**中断の基準：** いずれかの確認項目が失敗した場合、次のSTEPへ進まず、STEP 5の
後片付け（可能な範囲）を行ってから報告する。

---

## STEP 5：後片付け

- 「①デモをセット」をもう一度押して、STEP 4で作成したデモ試合を終了させる
  （次に実際のお客様デモを行うときのための、クリーンな状態にする）
- 確認に使ったブラウザのタブ（管理画面・対抗戦画面）を閉じる
- **恒久デモの2試合（`EMUTTO`／`J SPORTS`、`docs/spec.md` 8.4章の
  `PERMANENT_DEMO_BATTLE_ID`）は`paused`のまま触らない**（今回のSTEP 4で作成される試合は、
  常に新規のイベントであり、恒久デモの試合そのものではない）
- `cheer_logs`は削除しない

---

## 中断の基準（再掲）

- STEP 1：`git pull`のコンフリクト
- STEP 2：`diff`の差分残り
- STEP 3：`pm2 restart`後のエラー・再起動回数の異常な増加
- STEP 4：いずれかの確認項目の失敗

いずれかに該当した場合、次のSTEPへ進まず報告する。

---

## ロールバック

本書の対象コミットに、マージコミットは含まれない（すべて通常のコミット）ため、
9/28手順書にあった「`git revert -m 1`の対象範囲の誤り」のような問題は起きない。
**ただし、`docs/`配下の変更（`76f8383`・`1e23596`・`89fd7d3`・`30784be`）は
`revert`しないこと。** `docs/spec.md`・`docs/worklog.md`は追記のみで過去記述を
削除しない運用のため（`CLAUDE.md`）、`revert`で機械的に戻すと過去の作業記録が
消えてしまう。ロールバックした場合は、その旨を`docs/worklog.md`へ**新しいエントリとして**
追記すること。

### ゲージの調整のみ戻す場合

```bash
# ローカルPCで
git revert 1180e9a
git push origin feature/reference-data
```

```bash
# 本番EC2上
cd /home/ubuntu/cheerstick-server-new
git pull
sudo cp public/battle.html /var/www/cheerstick-app/battle.html
diff /var/www/cheerstick-app/battle.html /home/ubuntu/cheerstick-server-new/public/battle.html && echo "OK"
```

`public/battle.html`のみの変更のため**`pm2 restart`は不要**（静的ファイルの配信は
nginxが行うため）。ただし`sudo cp`し直さない限り配信内容は変わらない点に注意。

### デモモードのみ戻す場合

`251ff2c`（対象チーム取得の改善）は`c8d9e71`（デモモード本体）が追加した
ファイルを変更しているため、**新しい方から順に**revertする。

```bash
# ローカルPCで（この順序を守ること）
git revert 251ff2c
git revert c8d9e71
git push origin feature/reference-data
```

```bash
# 本番EC2上
cd /home/ubuntu/cheerstick-server-new
git pull
sudo cp public/admin/events.html /var/www/cheerstick-admin/events.html
diff /var/www/cheerstick-admin/events.html /home/ubuntu/cheerstick-server-new/public/admin/events.html && echo "OK"
pm2 restart cheerstick-server --update-env   # src/の変更を戻すため必須
```

`src/controllers/adminDemoController.js`・`src/services/demoModeState.js`・
`src/routes/admin.js`・`src/index.js`が対象のため、**`pm2 restart`が必要。**
`revert`の時点でデモが`running`中だった場合、子プロセスが残る可能性があるため、
`revert`前に管理画面で「デモを停止」を押しておくこと。

### 両方戻す場合

```bash
# ローカルPCで（新しい方から順に）
git revert 251ff2c
git revert c8d9e71
git revert 1180e9a
git push origin feature/reference-data
```

本番側は、上記2つの手順（`battle.html`・`events.html`双方の`cp`＋`diff`、
`pm2 restart --update-env`）をまとめて実施する。

**`battle.html`・`events.html`への影響：** これらは静的ファイルのため、`revert`で
git管理下のソースを戻しても、**`sudo cp`し直さない限り配信内容（nginxが実際に
返す内容）は変わらない。** コード側を`revert`した場合は、必ず該当する`cp`を
実施すること（忘れると「gitのHEADは戻っているのに画面は新しいまま」という
STEP 2と同じ落とし穴になる）。

---

## 環境変数について

**今回、`.env`への追加は不要。** デモモードのdurationMs短縮用環境変数
`DEMO_MODE_TEST_DURATION_MS_OVERRIDE`はローカル確認専用であり、
**本番の`.env`には絶対に設定しないこと**（設定すると、デモの実行時間が
60秒固定でなくなる）。
