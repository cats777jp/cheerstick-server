# 応援合戦デモ Phase 4：段階的な実行 手順書

作成日：2026-09-28
対象：岩村様（TeraTermでの手動実行。本番EC2・WebARENA VPSへのSSH、書き込みコマンドの
実行はすべて岩村様が行う。Claude Codeの自動モード分類器が「Production Deploy」
「Credential Exploration」としてブロックするため）
関連：`cheerstick-battle-demo-phase4-20260928.md`（指示書）、
　　　`docs/runbook.md`「WebARENA デモ実行環境」節、
　　　`docs/worklog.md` 2026-09-27・2026-09-28エントリ、
　　　`scripts/demo/README.md`

---

## 0. 前提・確定事項

| 項目 | 内容 |
|---|---|
| 本番インスタンス | t3.micro（変更しない） |
| nginx | `worker_connections 8192`・`worker_rlimit_nofile 32768` 反映済み（2026-09-27） |
| 段階 | 各チーム **50台→250台→500台**（合計100→500→1,000） |
| count送信間隔 | 5秒±25%（`battle-demo.js`の既定値のまま。指定不要） |
| 終盤演出 | 既定の`close`（指定不要） |
| 恒久デモ2試合 | 「デモ対抗戦 EMUTTO」「デモ対抗戦 J SPORTS」は`paused`のまま。**削除・非表示化・status変更はしない** |
| 遅延計測 | 今回は行わない（本番DBとの突合なし） |

### Claude Codeによる事前確認結果（2026-09-28実施）

```bash
git diff --stat 55eff67..origin/feature/reference-data
```

```
 docs/runbook.md                     | 122 +++++++
 docs/spec.md                        |  27 ++
 docs/worklog.md                     | 338 +++++++++++++++++
 scripts/demo/README.md              | 145 ++++++++
 scripts/demo/battle-demo-prepare.js | 448 +++++++++++++++++++++++
 scripts/demo/battle-demo.js         | 711 ++++++++++++++++++++++++++++++++++++
 scripts/demo/local-verify.js        | 409 +++++++++++++++++++++
 7 files changed, 2200 insertions(+)
```

**差分は`docs/`・`scripts/demo/`配下のみ。** `src/`・`public/`・`migrations/`・
`package.json`・`package-lock.json`に変更なし。したがって：

- 本番では **`git pull`のみで足りる。`pm2 restart`・静的ファイルの`cp`・`npm install`は不要**
- `battle-demo-prepare.js`は`fetch`（Node組み込み、`package.json`の`"node": ">=20.0.0"`で利用可）
  のみを使用し、新規npm依存はない。本番EC2の既存`node_modules`だけで動作する

---

## 1. 禁止事項

- 本番EC2・WebARENA VPSへのSSH、書き込みコマンドの実行をClaude Codeに行わせること
  （分類器でブロックされるため、すべて岩村様がTeraTermで実行する）
- 恒久デモ2試合（EMUTTO／J SPORTS）のstatus変更・削除・非表示化
- ufwなど権限設定の変更
- `cheer_logs`の削除（扱いは全段階終了後にKMT様が判断）
- ステップの順序の入れ替え（特にSTEP Aのバックアップは、準備スクリプトが本番DBへ
  書き込む前に必ず完了させること）

---

## STEP A：本番EC2の事前確認とバックアップ

```bash
ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126
```

1. gitのHEADが想定どおりであることを確認する（`55eff67`のはず）
   ```bash
   git -C /home/ubuntu/cheerstick-server-new log --oneline -1
   ```
2. 現状のベースラインを記録する（STEP D以降の監視ログと比較するため）
   ```bash
   ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l   # 確立済み接続数
   pm2 list                                                             # 再起動回数（restart列）
   free -m                                                              # メモリ
   ```
3. 本番DBバックアップ（`docs/runbook.md`「リポジトリバックアップ手順」参照。
   準備スクリプトが本番DBへ書き込むため必須）
   ```bash
   mkdir -p ~/backups
   FILE=~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
   sudo -u postgres pg_dump cheerstick_production > $FILE
   ls -la $FILE   # サイズが非ゼロであることを確認
   ```
4. AWSコンソール（EC2 → 対象インスタンス → モニタリング）で、CPUクレジットの仕様
   （standard／unlimited）と現在の`CPUCreditBalance`を確認し、メモに控える
   （t3.microはバースト型のため、クレジット枯渇時の性能低下を切り分ける材料にする）

**この時点の記録（1〜4の結果）を、Claude Codeとの共有時に貼り付けること。**

---

## STEP B：本番EC2へのスクリプト反映

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
git log --oneline -1   # 1526b22（またはそれ以降の最新）に到達していること
```

**`pm2 restart`・`cp`（静的ファイル）・`npm install`は行わない。** STEP Aの差分確認
（`scripts/`・`docs/`のみ）どおり、コードの反映は`git pull`だけで完結する。

---

## STEP C：準備スクリプト（1回目：段階1・2用）

```bash
cd /home/ubuntu/cheerstick-server-new

# dry run（何が起きるか確認するだけ。書き込みなし）
node scripts/demo/battle-demo-prepare.js --pause-other-live
```

出力を確認する：

- category「デモ用」・team A「EMUTTO」・team B「J SPORTS」が見つかること
- 作成予定のデバイス数（team A 500台・team B 500台＝合計1,000台。段階1・2で使う分を
  最初にまとめて登録する）
- 他のlive試合が無い、またはpause対象がないこと（恒久デモ2試合は`paused`のため対象外）

問題なければ実行する：

```bash
node scripts/demo/battle-demo-prepare.js --pause-other-live --yes
```

出力される `summary` 欄から、以下を控える（STEP D・Eで使う）：

- `battle_id`
- `org_a` / `org_b` のID
- 「WebARENA VPS上で実行するコマンド例」の行（STEP D・Eのベースになる）
- 「後片付け」の行（STEP Gで使う）

最後に、対抗戦画面をブラウザで開き、0:0で表示されることを確認する：

```
https://app.cheerstick.com/battle.html?battle_id=<battle_id>
```

---

## STEP D：段階1（各50台、2分）

1. 本番EC2の**別のTeraTermウィンドウ**で監視を開始する
   ```bash
   cd /home/ubuntu/cheerstick-server-new
   ./scripts/demo/monitor-server.sh ~/demo-monitor-stage1.log
   ```
2. WebARENA VPS（`161.34.35.70`）へSSHし、`cheerdemo`ユーザーで実行する
   ```bash
   ssh ubuntu@161.34.35.70
   sudo -iu cheerdemo
   cd /home/cheerdemo/cheerstick-demo
   node scripts/demo/battle-demo.js \
     --battle-id=<STEP Cのbattle_id> \
     --org-a=<STEP Cのorg_a> \
     --org-b=<STEP Cのorg_b> \
     --devices-per-team=50 \
     --duration-ms=120000 \
     --metrics-log-path=./demo-metrics-stage1.jsonl
   ```
3. 対抗戦画面（STEP Cで開いたURL）で、スコアの増加とゲージの動きを目視確認する
4. 終了後、以下を控える：
   - `battle-demo.js`の終了時`[battle-demo] summary: ...`行
   - `demo-metrics-stage1.jsonl`の最後の数行
   - 監視ログ（`~/demo-monitor-stage1.log`）の最大値（load・`cpu_steal`・
     メモリ（`mem_available`の最小値）・`ws_conns_3000`の最大値）
   - `pm2 list`の再起動回数（STEP Aのベースラインとの差分）
5. 監視スクリプトをCtrl+Cで停止する

**停止ポイント：** 上記の結果をClaude（チャット）とClaude Codeへ共有し、次へ進んでよいか
判断する。

---

## STEP E：段階2（各250台、3分）

STEP Dと**同じbattle_id**のまま実行する。

```bash
# 本番EC2側（別ウィンドウ）
./scripts/demo/monitor-server.sh ~/demo-monitor-stage2.log
```

```bash
# WebARENA側（cheerdemoユーザー）
node scripts/demo/battle-demo.js \
  --battle-id=<STEP Cのbattle_id> \
  --org-a=<STEP Cのorg_a> \
  --org-b=<STEP Cのorg_b> \
  --devices-per-team=250 \
  --duration-ms=180000 \
  --metrics-log-path=./demo-metrics-stage2.jsonl
```

記録項目・停止ポイントはSTEP Dと同じ。

---

## STEP F：準備スクリプト（2回目：段階3用）と段階3（各500台、3〜5分）

1. 段階1・2で使った試合を終了する（STEP Cの出力に表示された「後片付け」コマンドを使う）
   ```bash
   node scripts/demo/battle-demo-prepare.js --finish-run=<STEP Cのbattle_id> --yes
   ```
2. 新しい試合・対抗戦ペアを作る（0:0から始めるため）。手順はSTEP Cと同じ
   （dry run→内容確認→`--yes`）。デバイスは既に登録済みのため`created=0`・`skipped`表示
   になるのが正常
   ```bash
   node scripts/demo/battle-demo-prepare.js --pause-other-live
   node scripts/demo/battle-demo-prepare.js --pause-other-live --yes
   ```
   出力された新しい`battle_id`を控え、対抗戦画面で0:0を確認する
3. 段階3を実行する
   ```bash
   # 本番EC2側（別ウィンドウ）
   ./scripts/demo/monitor-server.sh ~/demo-monitor-stage3.log
   ```
   ```bash
   # WebARENA側（cheerdemoユーザー）
   node scripts/demo/battle-demo.js \
     --battle-id=<STEP Fの新しいbattle_id> \
     --org-a=<org_a> \
     --org-b=<org_b> \
     --devices-per-team=500 \
     --duration-ms=180000 \
     --metrics-log-path=./demo-metrics-stage3.jsonl
   ```
   問題なければ`--duration-ms=300000`（5分）で再実行してもよい。

記録項目はSTEP Dと同じ。

---

## STEP G：後片付け

1. 段階3の試合を`--finish-run`で`finished`にする
   ```bash
   node scripts/demo/battle-demo-prepare.js --finish-run=<STEP Fのbattle_id> --yes
   ```
2. 恒久デモの2試合（EMUTTO／J SPORTS）は`paused`のまま触らない
3. デモで記録された`cheer_logs`は削除しない（扱いは全段階の結果を見てKMT様が判断）
4. 各ログファイルの保管場所を控える
   - WebARENA側：`/home/cheerdemo/cheerstick-demo/demo-metrics-stage{1,2,3}.jsonl`
   - EC2側：`~/demo-monitor-stage{1,2,3}.log`

---

## 各段階共通：中断基準（岩村様が監視中に判断する）

以下のいずれかに該当したら、WebARENA側の`battle-demo.js`を**Ctrl+Cで止める**。

- `battle-demo.js`の緊急停止（自動）が発動した（標準出力に停止理由が表示される）
- 監視ログ（`monitor-server.sh`）で次のいずれかを確認した
  - `mem_available`が150MB未満
  - `swap_used`が急増している
  - `pm2_cheerstick-server_restarts`がSTEP Aのベースラインから増えた
  - `load1`が5以上の状態が1分（監視ログ6行分）以上続いた
- 対抗戦画面・`app.cheerstick.com`が表示できなくなった

**中断した場合、次の段階には進まず、STEP Gの後片付けを行ってから報告すること。**

---

## ロールバック・復旧

- 準備スクリプトで作った試合は、いつでも以下で終了できる
  ```bash
  node scripts/demo/battle-demo-prepare.js --finish-run=<battle_id> --yes
  ```
- pm2が落ちた場合の確認・復旧
  ```bash
  pm2 list
  pm2 logs cheerstick-server --lines 50 --nostream
  pm2 restart cheerstick-server   # 岩村様の判断で実行
  ```

---

## ログの受け渡し

- TeraTermのSCP機能（ファイル→SSH SCP送信）で、WebARENA側の`.jsonl`とEC2側の
  監視ログ（`.log`）を手元PCへ取得する
- 少量であれば、各ファイルの`tail -n 20`等の出力をそのままチャットに貼り付けてもよい
- 取得したファイルは`C:\Projects\screenshots`ではなく、作業用の任意フォルダに保存し、
  リポジトリには含めない（デモ実行結果のログはgit管理対象外）
