# トラックA（レート制限）＋ゲージ「直近の勢い」本番反映 統合手順書

作成日：2026-09-28
対象：岩村様（TeraTermでの手動実行。本番EC2・WebARENAへのSSH・書き込みはすべて岩村様が行う）
関連：`cheerstick-track-a-rate-limit-20260928.md`・`cheerstick-battle-gauge-recent-20260928.md`
　　　（指示書2件）、`docs/tasks/2026-09-28-rate-limit-deploy.md`（旧手順書、本書に統合。
　　　内容の重複を避けるため、旧手順書のSTEP Bは「統合済み」に書き換えた。以後は本書を使う）、
　　　`docs/spec.md` 9.4章・12章、`docs/runbook.md`「WebARENA デモ実行環境」節

---

## 0. 前提

- ローカルで`feature/rate-limit-large-event`を`feature/reference-data`へ統合済み
  （マージコミット`42b22ad`、`docs/worklog.md`「コミット」節に統合完了を追記済み）。
  マージ後、`scripts/demo/local-verify.js`（既存27項目）・`scripts/rate-limit/local-verify.js`
  （追加26チェック）とも全PASSを確認済み
- 変更対象：
  - トラックA：`src/app.js`・`src/middleware/rateLimit.js`（新規）・
    `src/middleware/scoreCache.js`（新規）・`src/routes/`5ファイル・`.env.example`
  - ゲージ：`public/battle.html`・`scripts/demo/battle-demo.js`・
    `scripts/demo/battle-demo-prepare.js`（429ログ重複修正のみ）
- **DBのマイグレーション・スキーマ変更、`package.json`への依存追加は無い**
  （両トラックとも既存の依存のみで実装）
- `pm2 restart`で**確立中のWebSocket接続が一度切れる**（トラックAの変更どおり）。
  `public/battle.html`は静的ファイルのため、`git pull`だけでは配信内容が変わらない
  （STEP 3参照。`docs/runbook.md`「デプロイ手順」の2箇所デプロイ問題と同じ構造）

---

## 1. 全体の順序（8ステップ）

STEP 0（本番事前確認・バックアップ）→ STEP 1（WebARENAのスクリプト更新）→
STEP 2（反映前ストーム、ベースライン）→ STEP 3（本番`git pull`）→
STEP 4（`pm2 restart`、トラックA有効化）→ STEP 5（反映後ストーム、比較）→
STEP 6（`battle.html`のコピー・`diff`確認）→ STEP 7（100 vs 100テスト）→ STEP 8（後片付け）

---

## STEP 0：本番EC2の事前確認・バックアップ

```bash
ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126
```

1. 現在のHEAD
   ```bash
   git -C /home/ubuntu/cheerstick-server-new log --oneline -1
   ```
2. 確立中の接続数・pm2の再起動回数（反映前後の比較用ベースライン）
   ```bash
   ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l
   pm2 list
   ```
3. リポジトリバックアップ（gitタグ方式、`docs/runbook.md`「リポジトリバックアップ手順」参照。
   **ローカルPC側で実行**）
   ```bash
   git fetch origin
   git tag feature-reference-data-20260928ver origin/feature/reference-data
   git push origin feature-reference-data-20260928ver
   ```
4. 本番DBバックアップ（`docs/runbook.md`のpg_dump手順。**本番EC2上で実行**。
   準備スクリプトがSTEP 7で本番DBへ書き込むため必須）
   ```bash
   mkdir -p ~/backups
   FILE=~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
   sudo -u postgres pg_dump cheerstick_production > $FILE
   ls -la $FILE   # サイズが非ゼロであることを確認
   ```

**確認項目：** HEAD・接続数・pm2再起動回数を記録した、gitタグ・DBバックアップとも
成功した。
**中断の基準：** DBバックアップのサイズが0、または`pg_dump`がエラー終了した場合は、
原因を確認できるまで先へ進まない。

---

## STEP 1：WebARENAのスクリプトを更新する（バンドル）

**ローカルPC（`C:\Projects\cheerstick-server`）で実行する。**

統合後の`feature/reference-data`から、既に以下でbundleを作成済み
（本セッションで実施。保存先・サイズは本手順書と同じ報告に記載）：

```bash
git bundle create C:\Users\Iwamura\Downloads\cheerstick-demo.bundle feature/reference-data
```

以降は`docs/runbook.md`「WebARENA デモ実行環境」節の手順どおり：

```bash
# 1. bundleを事前に作成済み（上記）。再作成する場合は同じコマンドを使う

# 2. scpでWebARENA VPSのubuntuユーザーのホームへ転送
scp -i <鍵ファイル> C:\Users\Iwamura\Downloads\cheerstick-demo.bundle ubuntu@161.34.35.70:~/

# 3. 配置場所を置き換え、所有者をcheerdemoに変更
ssh -i <鍵ファイル> ubuntu@161.34.35.70
sudo mv ~/cheerstick-demo.bundle /home/cheerdemo/cheerstick-demo.bundle
sudo chown cheerdemo:cheerdemo /home/cheerdemo/cheerstick-demo.bundle

# 4. cheerdemoユーザーでfetch・ff-onlyでmerge
sudo -iu cheerdemo git -C /home/cheerdemo/cheerstick-demo fetch origin
sudo -iu cheerdemo git -C /home/cheerdemo/cheerstick-demo merge --ff-only origin/feature/reference-data

# 5. npm ci の要否：不要
#    トラックA・ゲージともpackage.jsonへの依存追加は無い（既存のexpress-rate-limit・ws等のみ使用）。
#    package.json・package-lock.jsonに変更が無いことをdiffで確認してから省略してよい。
git -C /home/cheerdemo/cheerstick-demo diff --stat origin/feature/reference-data~1 -- package.json package-lock.json
#    ↑ 出力が空であることを確認できれば npm ci は不要
```

**確認項目：** `fetch`・`merge --ff-only`がエラーなく完了し、
`git -C /home/cheerdemo/cheerstick-demo log --oneline -1`がローカルのマージコミット
（`42b22ad`以降）と一致すること。`package.json`/`package-lock.json`に差分が無いこと。
**中断の基準：** `merge --ff-only`が失敗する（cheerdemo側で独自コミットが入っている等）
場合は、原因を確認できるまでSTEP 2以降へ進まない。

---

## STEP 2：反映前の`geturl-storm`実行（ベースライン）

**WebARENA VPS、`cheerdemo`ユーザーで実行する。**

```bash
sudo -iu cheerdemo
cd /home/cheerdemo/cheerstick-demo
node scripts/demo/geturl-storm.js --count=1000 --duration-sec=60 --concurrency=20
```

旧仕様（IPごとに15分500回）のため、**500回付近で429になり始める想定。**
`=== summary ===`の内容（200/429の件数、`RateLimit-*`ヘッダー）を記録しておく。

**次のstormまで15分空けること。** WebARENAのIPも同じレート制限の枠を消費するため、
間隔が短いと反映後の結果に前回分の残り枠が影響する。**この待機時間を使って
STEP 3・4（本番反映）を進めてよい**（15分以上あれば十分収まる想定）。

---

## STEP 3：本番へ`git pull`

**本番EC2上で実行する。**

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
git log --oneline -1   # STEP 1で作成したマージコミット（42b22ad以降）に到達していることを確認
```

**重要：`public/battle.html`はこの時点ではまだ配信内容が変わらない。** nginxは
`/var/www/cheerstick-app/`から静的ファイルを直接配信しており（`docs/runbook.md`
「デプロイ手順」参照）、`git pull`は`/home/ubuntu/cheerstick-server-new/`配下の
git管理下ファイルを更新するだけで、配信先ディレクトリへは自動反映されない。
**`battle.html`の反映はSTEP 6（`sudo cp`）で別途行う。** ここで`git pull`しただけの
状態では、対抗戦画面は旧デザイン・旧パラメータ非対応のまま表示され続ける
（`src/`側〔トラックA〕は`pm2 restart`後のSTEP 4で有効になる点と混同しないこと）。

`src/`のみでマイグレーション・`package.json`の変更は無いため、
`node src/db/migrate.js`・`npm install`は不要。

**確認項目：** `git log`のHEADが想定コミットに一致すること。
**中断の基準：** `git pull`がコンフリクト等で失敗した場合、原因を確認できるまで
STEP 4へ進まない（本番の`git status`を確認し、意図しないローカル変更が
無いか確認する）。

---

## STEP 4：`pm2 restart --update-env`（トラックA有効化）

**確立中のWebSocket接続が一度切れる。** STEP 0で確認した接続数・時間帯を踏まえ、
実機テストと重ならないタイミングで実施する。

```bash
pm2 restart cheerstick-server --update-env
pm2 logs cheerstick-server --lines 50 --nostream
```

**確認項目：**
- 起動ログに`[rate-limit] config: ...`の行が出力され、値が既定値どおり
  （`.env`を変更していなければ`RL_AUDIENCE_IP_MAX=50000`等）であること
- 新規エラーが無いこと
- `pm2 list`の再起動回数がSTEP 0の記録値から+1のみ増えていること（想定外の
  再起動ループが起きていないか）

**中断の基準：** 起動ログにエラーが出る、または`pm2 list`が`errored`表示になった場合、
STEP 5以降へ進まずロールバック（本書末尾）を検討する。

---

## STEP 5：反映後の`geturl-storm`実行（比較）

**WebARENA VPS、`cheerdemo`ユーザーで、STEP 2と同じ条件で実行する。**
STEP 2の実行から**15分以上経過していること**を確認してから実行する。

```bash
node scripts/demo/geturl-storm.js --count=1000 --duration-sec=60 --concurrency=20
```

新仕様（IPごとに15分50,000回・デバイスごとに15分60回、既定値のまま）のため、
**`--count=1000`であればすべて200になる想定**（デバイスごとの上限60回に対し
1回ずつしか呼ばないため、デバイス側にも掛からない）。

**比較表（記録用）：**

| 項目 | STEP 2（反映前） | STEP 5（反映後） |
|---|---|---|
| 200件数 | | |
| 429件数 | | |
| その他 | | |
| レイテンシ中央値/最大 | | |
| 最後のRateLimit-Policy | | |

**確認項目：** 反映後は429が（ほぼ）0件になっていること。
**中断の基準：** 反映後も429が大量に出る場合、`.env`の設定漏れ・`pm2 restart`の
未反映を疑い、STEP 4の確認項目を再確認する。

---

## STEP 6：`battle.html`のコピーと`diff`確認

**本番EC2上で実行する。**

```bash
cd /home/ubuntu/cheerstick-server-new
sudo cp public/battle.html /var/www/cheerstick-app/battle.html
diff /var/www/cheerstick-app/battle.html /home/ubuntu/cheerstick-server-new/public/battle.html && echo "battle.html: OK"
```

（`docs/runbook.md`「★必須：コピー後は『反映されたこと』をdiffで確認する」節の方針に
従う。既存ファイルへの上書きコピーのため、`chown`/`chmod`は不要＝所有者・パーミッションは
既存のまま引き継がれる。）

**確認項目：** `diff`が差分無しで終了すること。ブラウザで恒久デモのURL
（`https://app.cheerstick.com/battle.html?battle_id=<恒久デモのbattle_id>`）を開き、
表示が壊れていないことを目視確認する。
**中断の基準：** `diff`に差分が出た場合、反映は完了していない。原因を確認してから
先へ進む。

---

## STEP 7：100 vs 100のテスト

**KMT様確定事項（お客様デモは各100台＝100 vs 100、終盤演出は既定の`close`）に基づく。**

1. **本番EC2上**で準備スクリプトを実行する（デバイスは段階1〜3・過去のデモで
   既に登録済みのため、`created=0`が想定される）
   ```bash
   cd /home/ubuntu/cheerstick-server-new
   node scripts/demo/battle-demo-prepare.js --devices-per-team=100 --pause-other-live
   # dry runの内容を確認後
   node scripts/demo/battle-demo-prepare.js --devices-per-team=100 --pause-other-live --yes
   ```
   出力された`battle_id`・`org_a`・`org_b`を控える。
2. **対抗戦画面**をブラウザで開く（ゲージ「直近の勢い」・1秒ポーリングを試す）
   ```
   https://app.cheerstick.com/battle.html?battle_id=<battle_id>&gauge=recent&poll=1000
   ```
   **同じ回線から2タブ以上開かない**（`RL_SCORE_IP_MAX`は既定6,000/15分あり、
   1秒間隔1タブなら900回/15分で十分収まるが、複数タブ・複数端末で同時に見る場合は
   合算される点に注意。`scripts/demo/README.md`参照）。
3. **本番EC2の別TeraTermウィンドウ**で監視を開始する
   ```bash
   ./scripts/demo/monitor-server.sh ~/demo-monitor-100v100.log
   ```
4. **WebARENA VPS**（`cheerdemo`ユーザー）でデモ本体を実行する
   ```bash
   node scripts/demo/battle-demo.js \
     --battle-id=<battle_id> --org-a=<org_a> --org-b=<org_b> \
     --devices-per-team=100 --burst --target-range=0.35-0.65 --duration-ms=180000
   ```
5. 対抗戦画面で、猛攻時のスコア差拡大・リーダー交代時のゲージの動き・
   残り30秒（終盤演出ウィンドウ）以降は猛攻が入らず`close`の接戦挙動になることを
   目視確認する。監視ログ（load・`cpu_steal`・`mem_available`・`ws_conns_3000`・
   pm2再起動回数）をSTEP 0のベースラインと比較する。

**確認項目：** 接続成功100/100×2、送信失敗0、サーバーエラー0、対抗戦画面が
`gauge=recent`・`poll=1000`で正しく表示・更新されること、監視ログに異常が無いこと。
**中断の基準（`docs/tasks/2026-09-28-battle-demo-phase4.md`と同じ基準を踏襲）：**
- `battle-demo.js`の緊急停止（自動）が発動した
- 監視で「利用可能メモリ150MB未満」「スワップ使用急増」「pm2再起動回数の増加」
  「load averageが5以上1分以上継続」のいずれか
- 対抗戦画面・`app.cheerstick.com`が表示できなくなった
  （429による「更新待機中（アクセス制限）」表示は、複数タブを開いていないか確認する）

中断した場合、次のステップに進まず、STEP 8の後片付けを行ってから報告する。

---

## STEP 8：後片付け

```bash
# 本番EC2上
node scripts/demo/battle-demo-prepare.js --finish-run=<battle_id> --yes
# --pause-other-liveで他の試合を変更していた場合、実行時に出力される
# --restore= 付きのコマンド例をそのまま使う
```

- 恒久デモの2試合（EMUTTO／J SPORTS）は`paused`のまま触らない
- `cheer_logs`は削除しない（扱いは結果を見てKMT様が判断）
- 各ログの保管場所を控える：WebARENA側のメトリクスJSONL・`geturl-storm`のstorm結果、
  EC2側の監視ログ（`~/demo-monitor-100v100.log`）

---

## ロールバック

### トラックA・ゲージの反映を戻す場合

```bash
# ローカルPCで、マージコミットを打ち消すrevertを作成してpush
git revert -m 1 42b22ad
git push origin feature/reference-data
```

```bash
# 本番EC2上
cd /home/ubuntu/cheerstick-server-new
git pull
pm2 restart cheerstick-server --update-env
```

`git reset`で本番のHEADを直接戻す方法もあるが、**originの履歴と本番の履歴が
食い違う状態になる**ため、`docs/worklog.md` 2026-09-21エントリと同じ問題を避けるため
`revert`を推奨する。

**`battle.html`・デモスクリプトへの影響：** トラックA（レート制限・スコアキャッシュ、
`src/`配下）を`revert`で戻しても、`public/battle.html`・`scripts/demo/battle-demo.js`
（ゲージ・猛攻演出、STEP 6で別途配信先にコピー済みのファイル）には**影響しない**
（`revert`は`git`管理下のファイル全体を対象の1コミット分だけ巻き戻すため、
トラックAとゲージ・デモスクリプトが別コミットである以上、`git revert`の対象コミットを
選べばどちらか一方だけを戻すことも可能。ただし本書のマージコミット`42b22ad`を丸ごと
`revert`する場合は**両方**が対象になる点に注意。片方だけ戻したい場合は、該当コミット
（トラックA：`8ed487f`・`9fbec8e`、ゲージ：`415eb67`・`029ca7b`）を個別に指定して
`git revert`すること）。`public/battle.html`は`sudo cp`で配信先へコピーするまで
本番の表示に反映されないため、**コード側を`revert`した場合も、配信先
（`/var/www/cheerstick-app/battle.html`）へ旧版を改めて`cp`しない限り、画面表示は
新パラメータ対応のまま残る**点に注意（`src/`側〔トラックA〕の`pm2 restart`反映とは
独立している）。
