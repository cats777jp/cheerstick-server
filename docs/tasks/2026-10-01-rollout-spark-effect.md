# ゲージ火花演出 `fx=spark`（デモモード）本番反映 手順書

作成日：2026-10-01
対象：岩村様（TeraTermでの手動実行。本番EC2へのSSH・書き込みコマンドはすべて岩村様が行う）
関連：`20261001_cheerstick_effects.txt`（指示書）、`docs/spec.md` 9.13章、
　　　`docs/tasks/2026-09-29-rollout-gauge-and-demo-mode.md`（構成を踏襲した前回手順書。
　　　指示では`2026-10-01-rollout-gauge-and-demo-mode.md`と呼ばれていたが、実在するファイル名は左記）

---

## 0. 前提・確定事項

| 項目 | 内容 |
|---|---|
| 本番の現在のHEAD（想定） | `ea833ad`（トラックB-①マージ。2026-10-01反映・`cached`採用済み）。**STEP 0-2で実際の値を確認すること。** 以降の`34ddea3`・`64fdf00`はdocsのみ |
| 反映するコミット | `feature/reference-data` の `e573406`（コード本体は`ff56c27`、`e573406`はdocsのみ。push済み） |
| 差分（`git diff --stat ea833ad..HEAD`） | 9ファイル、+790/-8。コード：`public/battle.html`・`public/admin/events.html`・`src/controllers/adminDemoController.js`・`src/services/demoModeState.js`、確認用：`scripts/demo/local-verify-demo-mode.js`、他は`docs/` |
| `package.json`・`package-lock.json`・`migrations/` | **変更なし**（`git diff --stat`で確認済み）。`npm install`・マイグレーションは不要 |
| 再起動 | **`src/`の変更を含むため`pm2 restart`が必要。** 確立中のWebSocket接続が一度切れる。実機テストと重ならない時間帯に実施 |
| 静的ファイル | **2件とも`git pull`だけでは配信内容が変わらない。** `battle.html`→`/var/www/cheerstick-app/`、`events.html`→`/var/www/cheerstick-admin/`。いずれも既存ファイルの上書きのため`chown`/`chmod`は不要 |
| 既定の動作 | チェックボックスは常にOFF、`fx=spark`が付かない限り`battle.html`の見た目は従来と同じ。**反映しただけでは、お客様向けデモの見た目は変わらない** |
| `.env` | 追加なし。`DEMO_MODE_TEST_DURATION_MS_OVERRIDE`は本番に**絶対に設定しない**（デモが60秒固定でなくなる） |

### ローカルでの事前確認結果（Claude Codeが実施済み）

- `scripts/demo/local-verify.js` 27/27、`rate-limit/local-verify.js` 26/26、
  `demo/local-verify-demo-mode.js` 34/34（`sparkEffect`の5項目を追加）、
  `ble-disconnect/local-verify.js` 8/8、`cheer-log-write/local-verify.js` 35/35 — いずれも全PASS
- ヘッドレスChromeでの確認：強い勢いで約3秒後に発火、停止後約2〜3秒で消火、拮抗では非発火。
  `fx`単独・`gauge=recent`のみ・パラメータ無しは、変更前とレイアウト座標が完全一致

---

## 1. 禁止事項

- 本番EC2へのSSH・書き込みコマンドの実行をClaude Codeに行わせること
- 恒久デモ2試合（`EMUTTO`／`J SPORTS`）のstatus変更・削除・非表示化
- `cheer_logs`の削除
- `.env`の中身を表示・チャットへ貼り付けること
- STEPの順序の入れ替え（STEP 0のタグ・バックアップは本番へ変更を入れる前に完了させる）
- 実機（BLEデバイス）でのテストと重なる時間帯での実施
- **STEP 4・STEP 5の「デモをセット」を、本番に実イベントの試合が`live`のときに押すこと**
  （下記STEP 0-2の注意参照）

---

## STEP 0：事前確認・ロールバック用タグ・DBバックアップ

### 0-1. ロールバック用gitタグ（**ローカルPCで**実行）

**⚠️ 本番EC2のDeploy Key（読み取り専用）では`push`が失敗する。必ずローカルPCで実行すること**
（2026-09-28にEC2上でつまずいた事例あり）。タグの対象は、**0-2で確認した本番の現在のHEAD**
（下記は想定どおり`ea833ad`の場合。異なる場合はそのコミットを指定する）。

```bash
cd C:\Projects\cheerstick-server
git tag prod-before-spark-effect-20261001 ea833ad
git push origin prod-before-spark-effect-20261001
git ls-remote --tags origin prod-before-spark-effect-20261001
git rev-parse ea833ad
```

- `ls-remote`が1行返り、ハッシュが`git rev-parse`の結果と一致すること

### 0-2. 本番EC2の現状確認

```bash
ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126
```

```bash
git -C /home/ubuntu/cheerstick-server-new log --oneline -1          # ea833ad のはず
ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l   # 確立中接続数
pm2 list                                                             # restart列の回数を控える（反映後は+1）
```

- **HEADが想定と違う場合は、0-1のタグを作り直す（または報告する）。** 確立中接続数が想定外
  （実機が接続中など）の場合は、時間帯を変えるか報告する
- **注意（実イベント中の確認）：** デモの「デモをセット」は、内部で`--pause-other-live`を使い、
  **他の`live`の試合を`paused`にする**（9/29実装、`docs/spec.md` 9.12章）。STEP 4・5で本番の
  「デモをセット」を押す前に、管理画面（`admin.cheerstick.com`）で**実イベントの`live`試合が
  無いこと**を確認する

### 0-3. 本番DBバックアップ（本番EC2上）

「デモをセット」が本番DBへ試合・対抗戦ペアを書き込む（STEP 4）ため必須。

```bash
mkdir -p ~/backups
FILE=~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
sudo -u postgres pg_dump cheerstick_production > $FILE
ls -la $FILE   # サイズが非ゼロ（直近の目安は13.7MB以上）
```

**中断基準：** 0-1〜0-3のいずれかが失敗・想定外（バックアップのサイズ0、`pg_dump`のエラー、
タグのハッシュ不一致）の場合は、原因を確認できるまでSTEP 1へ進まない。

---

## STEP 1：本番へ`git pull`（本番EC2上）

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
git log --oneline -3          # 先頭が e573406 であること
git status                    # コンフリクト・意図しないローカル変更が無いこと
git diff --stat ea833ad..HEAD -- package.json package-lock.json migrations   # 出力が空であること
```

- 出力に`Fast-forward`が含まれること
- **中断基準：** コンフリクト、`Fast-forward`以外（マージコミットが作られた）、`package.json`等の
  差分が空でない場合は、STEP 2へ進まず報告する

---

## STEP 2：静的ファイル2件のコピーと`diff`確認（本番EC2上）

**⚠️ 両方が必須。** どちらか片方でも漏れると、チェックボックスだけ出て火花が出ない、
または火花の仕組みだけあって操作できない、という中途半端な状態になる。

```bash
cd /home/ubuntu/cheerstick-server-new

# (a) 対抗戦画面（app.cheerstick.com）
sudo cp public/battle.html /var/www/cheerstick-app/battle.html
diff /var/www/cheerstick-app/battle.html /home/ubuntu/cheerstick-server-new/public/battle.html && echo "battle.html: OK"

# (b) 管理画面（admin.cheerstick.com）
sudo cp public/admin/events.html /var/www/cheerstick-admin/events.html
diff /var/www/cheerstick-admin/events.html /home/ubuntu/cheerstick-server-new/public/admin/events.html && echo "events.html: OK"
```

**確認項目：** 2件とも`OK`が出ること（`diff`の差分なし）。
**中断基準：** 差分が出た場合、反映は完了していない。原因を確認してから進む。

---

## STEP 3：`pm2 restart --update-env`（本番EC2上）

`adminDemoController.js`・`demoModeState.js`の変更を反映するために必要。
**確立中のWebSocket接続が一度切れる。** 直前にもう一度接続数を確認する。

```bash
ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l   # 最終確認
pm2 restart cheerstick-server --update-env
pm2 logs cheerstick-server --lines 50 --nostream
pm2 list
```

**確認項目：**
- 起動ログに新しいエラーが無いこと
- `[rate-limit] config: ...`・`[WS] cheer-log-write config: mode=cached ...`の行が引き続き出ること
  （既存設定が変わっていないことの確認）
- `pm2 list`の再起動回数が0-2で控えた値+1のみで、`online`であること

**中断基準：** 起動ログにエラー、または`errored`表示の場合は、STEP 4へ進まずロールバック（後述）を検討する。

---

## STEP 4：疎通確認（チェックボックスのON/OFFと`screenUrl`）

**本番EC2上（`curl`）と、`admin.cheerstick.com`にアクセスできるPC（IP制限内）のブラウザの両方を使う。**
**ここでは「デモを開始」は押さない**（`screenUrl`の確認のみ。`cheer_logs`への書き込み・負荷は発生させない）。

1. 初期状態の確認
   ```bash
   curl http://127.0.0.1:3000/api/v1/admin/demo/status
   # idleのとき：{"status":"idle","battleId":null,"screenUrl":null,"sparkEffect":false,"elapsedMs":null,"remainingMs":null}
   # 以前のデモがsetのままなら、status:"set"・既存のscreenUrlが返る（その場合は`sparkEffect`も含まれること）
   ```
   `sparkEffect`のキーが応答に含まれること（新コードが動いている証拠）
2. `admin.cheerstick.com/events.html`を**ハードリロード**（Ctrl+Shift+R）して開き、
   「デモモード」枠の「表示画面を開く」の**右**にチェックボックス「ゲージ演出（火花）」が出ること、
   **未チェック**であること。もう一度通常のリロード（F5）しても**未チェックに戻る**こと
3. **OFFでセット：** チェックを外したまま「デモをセット」→ `curl`で`/admin/demo/status`を再取得
   - `screenUrl`が`/battle.html?battle_id=...&gauge=recent&poll=1000`（**`fx=spark`を含まない**）
   - `"sparkEffect":false`
4. **ONでセット：** チェックを入れて「デモをセット」→ `curl`で再取得
   - `screenUrl`が`...&gauge=recent&poll=1000&fx=spark`（**末尾に`&fx=spark`が付く**）
   - `"sparkEffect":true`
   - 「表示画面を開く」を押し、新しいタブのURLに`&fx=spark`が付いていること、画面が**0:0**で、
     ゲージのバー色が**赤（左）→薄いオレンジ／薄い水色→濃紺（右）のグラデーション**になっていること
     （火花はまだ出ない。応援が無いため）
5. **後から変えても既存に影響しないこと：** ONでセットした直後、チェックだけ外し、「デモをセット」は
   押さずに`curl`で再取得 → `screenUrl`は**4.のまま**（`&fx=spark`付き）であること
6. **OFFで再セット（クリーンな状態に戻す）：** チェックを外した状態でもう一度「デモをセット」→
   `screenUrl`に`fx=spark`が付かないこと
7. 既存の対抗戦画面への影響が無いこと：パラメータ無しの`battle.html?battle_id=<任意の既存ペア>`
   （例：恒久デモ）が従来どおり表示される（バーが従来の単色、火花の要素が出ない）

**確認項目：** 上記1〜7すべてが想定どおり。
**中断基準：** いずれかが失敗した場合、次のSTEPへ進まず、STEP 6の後片付け（可能な範囲）を行ってから報告する。

---

## STEP 5：実機確認（100 vs 100デモ・しきい値の妥当性）— **手順のみ記載。本番では今回実行しない**

目的：しきい値`SPARK_INTENSITY_THRESHOLD = 0.20`（リーダー側が70%以上で発火）が妥当か、
実際に火花・光・揺れが見えるかを、実際のデモの動きで確認する。**別途KMT様・岩村様の判断で実施する。**

前提：STEP 0〜4が完了し、本番に実イベントの`live`試合が無く、実機（BLEデバイス）テストと
重ならない時間帯であること。**応援ログ（`cheer_logs`）が本番DBに書き込まれる**ため、
実行前に0-3のバックアップが取れていること。

1. 管理画面でチェックを**ON**にして「デモをセット」（`screenUrl`に`&fx=spark`が付くこと）
2. 「表示画面を開く」で対抗戦画面を大きめのウィンドウ／スクリーンで開く。
   **開発者ツールのコンソール**で`window.__battleDebug.sparkOn`を確認できる状態にしておく
3. 「デモを開始」（60秒、100 vs 100、`--burst`等9/28〜29のテスト設定）
4. 観察項目：
   - 一方が優勢になりゲージが約70%を超えたとき、拮抗点（赤と青の境目）に光が出て、
     火花が飛び、バーが揺れる（`sparkOn`が`true`）
   - 接戦の時間帯（ゲージが60%前後）では出ない／出すぎない
   - 発火のオン・オフがちらつかない（数秒おきの点滅にならない）。**ちらつく場合はしきい値付近で
     リーダーの勢いが上下している**可能性があり、ヒステリシスの導入または値の調整を検討する
   - 火花・光がテーマ画像・カウンター等に被って見づらくないか
   - デモ終盤30秒（接戦演出）で動きが落ち着くこと、**終了後（応援停止後）に数秒で消える**こと
5. 判断：
   - 出なさすぎる → `SPARK_INTENSITY_THRESHOLD`を下げる（例：0.15＝リーダー65%以上）
   - 出すぎる／ちらつく → 上げる（例：0.25）またはヒステリシス
   - 調整する場合は`public/battle.html`の定数1か所のみの変更。**`src/`の変更は無いので`pm2 restart`は不要**
     （ローカルで変更→コミット→push→本番`git pull`→STEP 2(a)の`cp`と`diff`のみ）
6. 後片付けはSTEP 6に従う

---

## STEP 6：後片付け

- 「デモをセット」をチェックOFFのまま押し直し、STEP 4・5で作成したデモ試合を終了させる
  （次のお客様デモ用のクリーンな状態にする。`screenUrl`に`fx=spark`が付かない状態）
- 確認に使ったブラウザのタブを閉じる
- 恒久デモの2試合（`EMUTTO`／`J SPORTS`）は`paused`のまま触らない
- `cheer_logs`は削除しない
- 反映の記録（HEAD・pm2再起動回数・確認結果）を`docs/worklog.md`へ追記する
  （Claude Codeに結果を共有すれば、追記はClaude Codeが行う）

---

## 中断の基準（再掲）

- STEP 0：タグのハッシュ不一致、バックアップの失敗（サイズ0・エラー）、HEADや接続数が想定外
- STEP 1：`git pull`のコンフリクト、Fast-forward以外、`package.json`・`migrations/`の差分
- STEP 2：`diff`の差分残り
- STEP 3：`pm2 restart`後のエラー・`errored`・再起動回数の異常な増加
- STEP 4：いずれかの確認項目の失敗

いずれかに該当した場合、次のSTEPへ進まず報告する。

---

## ロールバック

本書の対象は、コードの変更が`ff56c27`の1コミットのみ（マージコミットを含まない）。
**`docs/`の変更（`e573406`等）は`revert`しないこと。** `docs/spec.md`・`docs/worklog.md`は
追記のみで過去記述を削除しない運用のため（`CLAUDE.md`）。ロールバックした場合は、その旨を
`docs/worklog.md`へ**新しいエントリとして**追記する。

### 方法A：`git revert`で戻す（通常はこちら。履歴を残す）

```bash
# ローカルPCで
git revert ff56c27
git push origin feature/reference-data
```

```bash
# 本番EC2上
cd /home/ubuntu/cheerstick-server-new
git pull
sudo cp public/battle.html /var/www/cheerstick-app/battle.html
sudo cp public/admin/events.html /var/www/cheerstick-admin/events.html
diff /var/www/cheerstick-app/battle.html public/battle.html && echo "battle.html: OK"
diff /var/www/cheerstick-admin/events.html public/admin/events.html && echo "events.html: OK"
pm2 restart cheerstick-server --update-env   # src/の変更を戻すため必須
```

**⚠️ 静的ファイル（`battle.html`・`events.html`）は、`revert`してgit管理下のソースを戻しても、
`sudo cp`し直さない限り配信内容は変わらない**（gitのHEADは戻っているのに画面は新しいまま、
という落とし穴）。`pm2 restart`の前に、デモが`running`中であれば管理画面で「デモを停止」を押しておく
（子プロセスが残る可能性があるため）。

### 方法B：緊急時、ロールバックタグの状態へ戻す

`revert`のpushを待たずに、本番を直接、反映前の状態へ戻したい場合（デモ当日の障害など）。

```bash
# 本番EC2上
cd /home/ubuntu/cheerstick-server-new
git checkout prod-before-spark-effect-20261001 -- src/controllers/adminDemoController.js src/services/demoModeState.js public/battle.html public/admin/events.html
sudo cp public/battle.html /var/www/cheerstick-app/battle.html
sudo cp public/admin/events.html /var/www/cheerstick-admin/events.html
pm2 restart cheerstick-server --update-env
```

作業ツリーに差分（`git status`）が残るため、落ち着いてから方法Aで正式にrevertし、
`git checkout HEAD -- <同じ4ファイル>`等で作業ツリーを整える。

### 見た目だけ戻したい場合（火花が不具合・不評だが、機能は残したい）

- チェックを**OFFのまま**「デモをセット」すれば、`fx=spark`は付かず、従来と全く同じ見た目になる
  （コード・静的ファイルの変更は不要。最も手軽な対応）
- 完全に戻す場合は上記のとおり

---

## 環境変数・DBについて

- `.env`の追加・変更は不要。**DBスキーマ変更・マイグレーションも無い**
  （`sparkEffect`はサーバーのメモリ上の`demoModeState`にのみ保持し、永続化しない。
  pm2再起動後は`idle`から始まり、チェックの状態も含め引き継がれない）
