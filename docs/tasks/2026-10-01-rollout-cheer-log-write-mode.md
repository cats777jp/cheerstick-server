# トラックB-① `CHEER_LOG_WRITE_MODE`：本番反映・負荷試験（legacy vs cached）手順書

作成日：2026-10-01
対象：岩村様（TeraTermでの手動実行。本番EC2・WebARENA VPSへのSSH、書き込みコマンドの
実行はすべて岩村様が行う）
関連：`cheerstick-rollout-cheer-log-write-mode-prep-20261001.md`（指示書）、
　　　`docs/spec.md` 12.6章、`docs/tasks/2026-09-30-cheer-log-write-measurement-plan.md`（元の計画メモ。
　　　本書がそれを実行可能な形に仕上げたもの）、`docs/tasks/2026-09-28-battle-demo-phase4.md`
　　　（デモ実行の基本手順）、`scripts/demo/README.md`

---

## 0. 前提・確定事項

| 項目 | 内容 |
|---|---|
| 本番の現在のHEAD | `28dc9c3`（2026-09-30、バックアップの記録を反映済み） |
| 反映するコミット | `feature/reference-data` の `ea833ad`（`feature/scale-cheer-log-write`のマージコミット。push済み） |
| 差分の中身 | `src/websocket/index.js`・`src/db/cheerstickQueries.js`・`.env.example`・`scripts/cheer-log-write/local-verify.js`・`docs/`。**`package.json`・`package-lock.json`・`migrations/`の変更なし**（`npm install`・DB変更は不要） |
| 再起動 | **`src/`の変更を含むため`pm2 restart`が必要。** 静的ファイル（`public/`）の変更は無いので`cp`は不要 |
| 既定の動作 | `CHEER_LOG_WRITE_MODE`は既定`legacy`。**`.env`に何も設定しなければ、反映後も本番の動作は従来と変わらない**（STEP 2はこの状態で行う） |
| モードの意味 | `legacy`＝countごとにDB 3往復（従来）／`cached`＝デバイス情報を接続ごとに60秒、live試合を組織ごとに2秒キャッシュし、live試合あり＝1往復・なし＝0往復 |
| 本番インスタンス | t3.micro（変更しない） |
| デモ環境 | `docs/runbook.md`「WebARENA デモ実行環境」（`161.34.35.70`、`cheerdemo`ユーザー） |
| 恒久デモ2試合 | 「デモ対抗戦 EMUTTO」「デモ対抗戦 J SPORTS」は`paused`のまま。**削除・非表示化・status変更はしない** |

### ローカルでの事前確認結果（Claude Codeが実施済み・2026-10-01）

- マージ（`--no-ff`）：**コンフリクトなし**
- ローカルテスト全PASS：`scripts/demo/local-verify.js` 27/27、`scripts/rate-limit/local-verify.js` 26/26、
  `scripts/demo/local-verify-demo-mode.js` 29/29、`scripts/ble-disconnect/local-verify.js` 8/8、
  `scripts/cheer-log-write/local-verify.js` 35/35（いずれも`CHEER_LOG_WRITE_MODE`未指定＝`legacy`）

### 比較の前提（重要・結果の読み方）

1. **比較の基準は、STEP 3（今日の`legacy`）の結果。** 付録Aの2026-09-28の結果は**参考値**に留める。
   9/28以降に別機能（トラックAのレート制限、ゲージ、デモモード、BLE切断記録）が反映されており、
   コードが同一ではないため
2. **9/28の段階1は各50台だったが、今回は各100台**（指示書どおり）。100台の段階に9/28の対応値は無い
3. t3.micro（バースト型）は`cpu_steal`が周期的に出る（9/28で最大37%）。**CPUクレジット残高と`cpu_steal`も
   併せて記録し、`cached`の結果が悪化・好転して見えても、その影響を切り分けられるようにする**
4. 実行順序は`legacy`→`cached`の2回のみ（指示書どおり）。順序の影響（後の試験が不利になる：
   クレジット減少など）を見るため、**結果が微妙なときは`legacy`を再実行する**（STEP 6参照）

---

## 1. 禁止事項

- 本番EC2・WebARENA VPSへのSSH、書き込みコマンドの実行をClaude Codeに行わせること
- 恒久デモ2試合のstatus変更・削除・非表示化
- `cheer_logs`の削除（扱いは全段階終了後にKMT様が判断）
- **`.env`の中身を`cat`等で表示・チャットへ貼り付けること**（パスワード等を含むため。確認は`grep CHEER_LOG_WRITE_MODE .env`のように対象行のみ）
- STEPの順序の入れ替え（特にSTEP 0のバックアップとタグは、本番へ変更を入れる前に必ず完了させる）
- 実機（BLEデバイス）でのテストと重なる時間帯での実施（`pm2 restart`は接続中のWebSocketを一度切る）

---

## STEP 0：本番の事前確認とバックアップ

### 0-1. ロールバック用gitタグ（ローカルPC）

```bash
cd C:\Projects\cheerstick-server
git tag prod-before-cheer-log-write-mode-20261001 28dc9c3
git push origin prod-before-cheer-log-write-mode-20261001
git ls-remote --tags origin prod-before-cheer-log-write-mode-20261001
```

- `ls-remote`が1行返り、ハッシュが`git rev-parse 28dc9c3`と一致すること
  （既存タグ：`prod-before-track-a-20260928`等と同じ命名）

### 0-2. 本番EC2の現状確認

```bash
ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126
```

```bash
git -C /home/ubuntu/cheerstick-server-new log --oneline -1          # 28dc9c3 のはず
ss -tn state established '( sport = :3000 )' | tail -n +2 | wc -l   # 確立中接続数（実機・他の接続が無いこと）
pm2 list                                                             # restart列＝11のはず
free -m
grep -c '^CHEER_LOG_WRITE_MODE=' /home/ubuntu/cheerstick-server-new/.env   # 0 のはず（未設定）
```

- **HEADが`28dc9c3`でない、再起動回数が11でない、確立中接続数が想定外（実機が接続中など）、
  `CHEER_LOG_WRITE_MODE`が既に設定されている場合は、先へ進まず報告する**
- AWSコンソール（EC2 → 対象インスタンス → モニタリング）で**`CPUCreditBalance`を控える**
  （STEP 3開始前・STEP 5開始前にも同様に控える）

### 0-3. 本番DBバックアップ・`.env`のバックアップ

```bash
mkdir -p ~/backups
FILE=~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
sudo -u postgres pg_dump cheerstick_production > $FILE
ls -la $FILE   # サイズが非ゼロ（直近の目安は13.7MB以上）

cp /home/ubuntu/cheerstick-server-new/.env /home/ubuntu/cheerstick-server-new/.env.bak_20261001
```

**この時点の記録（0-2・0-3の結果）をClaude Codeとの共有時に貼り付けること。**

**中断基準：** 0-1〜0-3のいずれかが失敗・想定外の場合は、STEP 1へ進まない。

---

## STEP 1：本番へ`git pull`

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
git log --oneline -3    # 先頭が ea833ad（Merge branch 'feature/scale-cheer-log-write' ...）であること
```

- 出力に **`Fast-forward`** が含まれること（本番ブランチに本番独自のコミットが無いため、通常はFast-forwardになる）
- `git diff --stat 28dc9c3..HEAD -- package.json package-lock.json migrations` の出力が空であること
- **中断基準：** コンフリクト・`Fast-forward`以外のマージ（マージコミットが作られた場合）が起きたら、
  それ以上進まず報告する（`git merge --abort`が必要な状態なら実行してよい）

---

## STEP 2：`pm2 restart --update-env`（`.env`は変更しない＝`legacy`のまま）

```bash
pm2 restart cheerstick-server --update-env
sleep 5
pm2 list                                                       # restart列が1増えて12になっていること、status=online
pm2 logs cheerstick-server --lines 80 --nostream               # 起動ログを目視
pm2 logs cheerstick-server --lines 80 --nostream | grep 'cheer-log-write config'
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/health   # 200
```

確認項目：

- [ ] 再起動回数が11→12
- [ ] 起動ログに `[WS] cheer-log-write config: mode=legacy device_cache_ttl_ms=60000 live_event_cache_ttl_ms=2000` が出ている
      （**この行は`CHEER_LOG_WRITE_MODE`を設定していなくても常に出力される設計**。ここで出ない場合は報告）
- [ ] 起動ログに新しいエラー（スタックトレース、`ECONNREFUSED`、`production guard`による終了等）が無い
- [ ] `/health`が200

**中断基準：** `pm2 restart`後のエラー、`mode=legacy`の行が出ない、`online`にならない場合は、
次のSTEPへ進まず報告する。復旧が必要な場合は末尾「ロールバック」参照。

---

## STEP 3：legacyモードでの負荷試験（ベースライン）

### 3-1. 準備

ステージ名は`legacy-100`・`legacy-250`・`legacy-500`とする。`CPUCreditBalance`を控える。

```bash
# 本番EC2：試合・対抗戦ペアを作る（9/28のSTEP Cと同じ。デバイスは既に登録済みなので created=0 が正常）
cd /home/ubuntu/cheerstick-server-new
node scripts/demo/battle-demo-prepare.js --pause-other-live          # dry run。内容を確認
node scripts/demo/battle-demo-prepare.js --pause-other-live --yes
```

- 出力の`battle_id`・`org_a`・`org_b`、および「後片付け」コマンド（`--restore=...`付きの場合あり）を控える
- 対抗戦画面を**1タブのみ**開いて0:0を確認：`https://app.cheerstick.com/battle.html?battle_id=<battle_id>`
  （同一IPから複数タブを開くと429になりうる）

### 3-2. 各段階の実行（100台 → 250台 → 500台）

**各段階で下記を繰り返す。** `<N>`と`<ステージ名>`だけ変える。ramp-upは9/28と揃える
（500台は60秒、250台は30秒。100台は`battle-demo.js`の自動値のまま）。

(a) 実行前に、cheer_logsの現在値を控える（読み取りのみ）：

```bash
sudo -u postgres psql -d cheerstick_production -At -c "SELECT count(*) FROM cheer_logs c JOIN event_battles b ON c.event_id IN (b.event_a_id, b.event_b_id) WHERE b.id = '<battle_id>';"
```

(b) 本番EC2の**別のTeraTermウィンドウ**で監視を開始：

```bash
cd /home/ubuntu/cheerstick-server-new
./scripts/demo/monitor-server.sh ~/demo-monitor-<ステージ名>.log
```

(c) WebARENA VPS（`161.34.35.70`）で実行：

```bash
ssh ubuntu@161.34.35.70
sudo -iu cheerdemo
cd /home/cheerdemo/cheerstick-demo
node scripts/demo/battle-demo.js \
  --battle-id=<battle_id> --org-a=<org_a> --org-b=<org_b> \
  --devices-per-team=<N> \
  --duration-ms=180000 \
  [--ramp-up-ms=30000（250台のとき） / --ramp-up-ms=60000（500台のとき）] \
  --metrics-log-path=./demo-metrics-<ステージ名>.jsonl
```

- **duration（180秒）・count間隔（既定5秒±25%）・終盤演出（既定`close`）は、STEP 3とSTEP 5で完全に同じにする**
  （9/28の段階2・3は`--duration-ms=180000`）

(d) 終了後に記録する：

- `battle-demo.js`の終了時 `[battle-demo] summary: ...` 行（送信成功・失敗・サーバーエラー）
- 監視ログの集計（本番EC2で、下の`summ`関数を使う）
- `pm2 list`の再起動回数（STEP 2直後の12から増えていないこと）
- cheer_logsの増加分（(a)と同じSQLを再実行し、差を取る）。**差が`total_send_success`とほぼ一致すること**
  （一致しなければ取りこぼしの疑い。`legacy`でも確認することで、`cached`時の比較基準にする）

(e) 監視を`Ctrl+C`で止める。次の段階へ進む前に、サーバーが落ち着くまで1〜2分あける。

監視ログの集計（本番EC2。どちらのSTEPでも同じものを使う）：

```bash
summ() { awk '{for(i=1;i<=NF;i++){split($i,a,"=");k=a[1];v=a[2]+0;
  if(k=="cpu_user"||k=="load1"||k=="cpu_steal"||k=="pm2_cheerstick-server_cpu"){n[k]++;s[k]+=v;if(v>m[k])m[k]=v}
  if(k=="mem_available"){if(!(k in m)||v<m[k])m[k]=v}}}
  END{for(k in n)printf "%s max=%.2f avg=%.2f\n",k,m[k],s[k]/n[k]; print "mem_available_min="m["mem_available"]}' "$1"; }
summ ~/demo-monitor-legacy-500.log
```

- 平均値には、開始前後のアイドル行も混ざる。**STEP 3とSTEP 5で、監視の開始・停止のタイミングを揃える**
  （「`battle-demo.js`を起動する直前に監視開始、終了直後に停止」）こと。揃っていれば比較は成立する

### 3-3. 後片付け（STEP 3の試合を終了）

```bash
node scripts/demo/battle-demo-prepare.js --finish-run=<battle_id> --yes
# --pause-other-liveで変更した試合があれば、3-1の出力にある --restore= 付きコマンドをそのまま使う
```

### 3-4. 結果の記録

付録Aの形式（9/28の表）に揃えて、`legacy-100/250/500`を記録する（STEP 6の比較表の元になる）。

**中断基準：**
- `battle-demo.js`の緊急停止が発動した、または送信失敗＋サーバーエラーが区間の送信試行の5%を超えた
- 監視で`mem_available`が150MB未満、`pm2_cheerstick-server_restarts`が増えた、`load1`が5以上の状態が1分以上続いた
- 対抗戦画面・`app.cheerstick.com`が表示できなくなった

→ `battle-demo.js`を`Ctrl+C`で止め、3-3の後片付けをしてから報告する（`.env`は未変更なのでSTEP 4の戻しは不要）。

---

## STEP 4：`.env`を`cached`に切り替え、再起動

**実行前に宣言：** 本番EC2の`.env`に`CHEER_LOG_WRITE_MODE=cached`を1行追加し、`pm2 restart`する。
接続中のWebSocketは一度切れる。実機テストが無いことを確認してから行う。

```bash
cd /home/ubuntu/cheerstick-server-new
printf '\nCHEER_LOG_WRITE_MODE=cached\n' >> .env
grep -n '^CHEER_LOG_WRITE_MODE=' .env          # 1行だけ、cachedであること（他の行は表示しない）
pm2 restart cheerstick-server --update-env
sleep 5
pm2 list                                       # restart列が13、status=online
pm2 logs cheerstick-server --lines 80 --nostream | grep 'cheer-log-write config'
pm2 logs cheerstick-server --lines 80 --nostream
```

確認項目：

- [ ] 起動ログに `[WS] cheer-log-write config: mode=cached ...` が出ている（`mode=legacy`のままなら`.env`の記述・`--update-env`を確認して報告）
- [ ] 新しいエラーが無い
- [ ] 再起動回数が12→13

### 4-1. 動作確認（疎通：`connect`〜`count`、cheer_logsへの記録）

STEP 3と同様に新しい試合・対抗戦ペアを作り（`battle-demo-prepare.js --pause-other-live` → dry run → `--yes`）、
`battle_id`・`org_a`・`org_b`を控える（**STEP 5はこの試合をそのまま使う**）。
続いて、WebARENAから5台×2・30秒の短い実行で、`cached`モードで一連の流れが動くことを確認する：

```bash
# 実行前に、3-2(a)と同じSQLでcheer_logsの件数を控える
node scripts/demo/battle-demo.js \
  --battle-id=<battle_id> --org-a=<org_a> --org-b=<org_b> \
  --devices-per-team=5 --duration-ms=30000 \
  --metrics-log-path=./demo-metrics-cached-smoke.jsonl
# 実行後に同じSQLで件数を再取得
```

- [ ] `summary`の送信失敗・サーバーエラーが0
- [ ] cheer_logsの増加分が`total_send_success`とほぼ一致（`cached`でも記録される）
- [ ] `pm2 logs cheerstick-server --lines 80 --nostream`に新しいエラーが無い
- [ ] 対抗戦画面（1タブ）でスコアが増える

**中断基準：** `cached`モードでの明らかな不具合（送信失敗の急増、エラーログの大量発生、
cheer_logsが増えない、スコアが動かない）があれば、STEP 5へ進まず、**下記「`.env`を`legacy`へ戻す」を実行して**
`mode=legacy`を確認し、試合を`--finish-run`で終了して報告する。

---

## STEP 5：cachedモードでの負荷試験

STEP 3と**まったく同じ条件**（各100・250・500台、duration・ramp-up・count間隔・終盤演出・
監視の開始停止タイミング）で、STEP 4-1で作った試合に対して`battle-demo.js`を実行する。

- ステージ名は`cached-100`・`cached-250`・`cached-500`
- 手順は3-2の(a)〜(e)と同じ（`battle_id`はSTEP 4-1のもの。cheer_logsの前後取得、`summ`での集計、
  `CPUCreditBalance`の記録を含む）
- 実行前に`pm2 logs ... | grep 'cheer-log-write config'`の最新行が`mode=cached`であることを再確認する
- 終了後、STEP 3-3と同様に`--finish-run`で試合を終了する（STEP 7でもよいが、STEP 6の判断前に必ず終了しておく）

**中断基準：** STEP 3と同じ。加えて、`cached`で送信失敗が`legacy`の同じ段階より明確に増えた、
またはcheer_logsの増加分が`total_send_success`より明らかに少ない（取りこぼし）場合も中断する。
中断時は`.env`を`legacy`へ戻して（下記）報告する。

---

## STEP 6：比較と判断

### 6-1. 比較表（STEP 3とSTEP 5の結果を記入）

| 段階 | モード | 送信成功（失敗） | サーバーエラー | cheer_logs増加 | cpu_user 最大／平均 | pm2 cpu 最大／平均 | load1 最大 | mem_available 最小 | cpu_steal 最大 | CPUクレジット（開始時） | pm2再起動 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 100台 | legacy | | | | | | | | | | |
| 100台 | cached | | | | | | | | | | |
| 250台 | legacy | | | | | | | | | | |
| 250台 | cached | | | | | | | | | | |
| 500台 | legacy | | | | | | | | | | |
| 500台 | cached | | | | | | | | | | |

### 6-2. 判断の目安

**指示書の基準：** `cached`で`cpu_user`または`load1`が**明確に下がっていれば効果あり**。
ほとんど変化が無ければ効果なし。

**数値の目安（案・Claude Code提案。岩村様・KMT様の判断で調整可）：**

- **主たる比較は250台・500台の段階の「平均」値。** 最大値は`cpu_steal`・TLS接続の立ち上げ（開始直後のスパイク）の
  影響を受けやすいため参考扱いにする。100台はCPU自体が低く差が見えにくいため、判断材料にしない
- 500台（および250台）で、`cpu_user`平均または`pm2_cheerstick-server_cpu`平均が、
  `legacy`比で**相対約20%以上低下**していれば「効果あり」の候補
- **±10%以内**なら「効果なし」の候補。**その間（10〜20%）や、`cpu_steal`・`CPUクレジット`が両者で大きく違う場合は
  判断せず、`legacy`を同条件で再実行**（`.env`から行を削除→再起動→STEP 3-2を500台のみ）して、順序・
  クレジットの影響を確認する
- 送信失敗・サーバーエラーが`legacy`より増えている、またはcheer_logsの取りこぼしがある場合は、
  CPUが下がっていても「効果あり」とは判断しない（`cached`は不採用）

### 6-3. 判断後にやること

**効果あり：** `.env`の`CHEER_LOG_WRITE_MODE=cached`を**そのまま残す**。本番は`cached`で運用を続ける。
追加の再起動は不要（既に`cached`で稼働中）。起動ログで`mode=cached`が出ていることだけ最後に確認する。

**効果なし：** `.env`から`CHEER_LOG_WRITE_MODE=cached`の行を削除し、`legacy`へ戻す
（下記「`.env`を`legacy`へ戻す」）。**コード自体は戻さなくてよい**（`legacy`が既定のため）。
INSERTが1メッセージ1回で残ることがボトルネックと見られる場合は、案2（INSERTのバッチ化、
`docs/proposals/large-event-scaling.md`）の検討へ進む。

**どちらの場合も**、判断結果と比較表を`docs/worklog.md`・`docs/spec.md` 12.6章へ記録する
（Claude Codeへ結果を共有すること）。

---

## STEP 7：後片付け

- [ ] STEP 3・STEP 5・STEP 4-1で作った試合・対抗戦ペアをすべて`--finish-run`で`finished`にした
      （`--restore=`が表示されていた場合は、そのコマンドで元のstatusへ戻した）
- [ ] 恒久デモ2試合（EMUTTO／J SPORTS）が`paused`のままであることを管理画面で確認
- [ ] `cheer_logs`は削除していない
- [ ] 監視スクリプト・`battle-demo.js`が止まっている（`ps`で確認）
- [ ] 対抗戦画面など、確認に使ったブラウザのタブを閉じた
- [ ] ログの保管場所を控えた（WebARENA：`/home/cheerdemo/cheerstick-demo/demo-metrics-*.jsonl`、
      EC2：`~/demo-monitor-*.log`）。必要ならTeraTermのSCPで手元へ取得（リポジトリには含めない）
- [ ] `pm2 list`で`cheerstick-server`が`online`、最終的な`CHEER_LOG_WRITE_MODE`の値と起動ログの`mode=`が一致している

---

## `.env`を`legacy`へ戻す方法（中断時・効果なし判断時の共通手順）

```bash
cd /home/ubuntu/cheerstick-server-new
sed -i '/^CHEER_LOG_WRITE_MODE=/d' .env
grep -c '^CHEER_LOG_WRITE_MODE=' .env        # 0 になること
pm2 restart cheerstick-server --update-env
sleep 5
pm2 logs cheerstick-server --lines 50 --nostream | grep 'cheer-log-write config'   # mode=legacy
pm2 list                                     # status=online
```

（`.env`自体を戻したい場合：`cp .env.bak_20261001 .env`。STEP 0-3で取得済み）

## コードのロールバック（`legacy`では不要。`legacy`でもエラーが出る等、コード自体に問題があった場合のみ）

`cached`でなければ新コードの追加経路は`legacy`と同一のため、通常は`.env`を戻すだけでよい。
コードも戻す場合：

```bash
# ローカルPC（feature/reference-data上）。コード変更の本体コミットだけを打ち消す（docsは残る）
git revert e5913f1
git push origin feature/reference-data
```

```bash
# 本番EC2
cd /home/ubuntu/cheerstick-server-new
git pull
pm2 restart cheerstick-server --update-env
```

- 対象コミット：`e5913f1`（`feat: 応援ログ書き込みのDB往復削減（CHEER_LOG_WRITE_MODE=cached）を実装`）。
  後続の`f39f796`・`654ede4`は`docs/`のみ、`ea833ad`はマージコミット（`-m 1`でのrevertは`docs/`も戻すため非推奨）
- 緊急時の最終手段（コードを`28dc9c3`の状態へ）：ロールバック用タグ`prod-before-cheer-log-write-mode-20261001`が
  `28dc9c3`を指している。ただし本番ブランチを巻き戻す操作（`git reset --hard`等）は、実行前にKMT様と
  相談すること

---

## 付録A：2026-09-28 Phase 4（段階1〜3）の結果（参考値・転記）

出典：`docs/worklog.md` 2026-09-28エントリ「Phase 4（段階1〜3）の結果」。
環境：本番t3.micro（unlimited、CPUクレジット残高約289）、nginx `worker_connections 8192`、
WebARENAから`wss://ws.cheerstick.com/cheer`経由、count間隔5秒±25%、実行時間は2〜3分。
**今回の`legacy`（STEP 3）はこの時点よりコードが新しく（トラックA等が反映済み）、段階1が50台だったのに対し今回は100台のため、直接比較はしない。**

| 段階 | 接続 | 送信（失敗） | サーバーエラー | スコアAPI応答 | load最大 | cpu_user最大 | mem_available最小 | pm2再起動 | pm2メモリ |
|---|---|---|---|---|---|---|---|---|---|
| 1（各50台） | 成功100/失敗0 | 2,789件（0） | 0 | 7〜9ms | 0.11 | 約5% | 388MB（開始454MB→ベースライン427MB） | 8のまま | ― |
| 2（各250台、ramp-up 30秒） | 成功500/失敗0 | 20,476件（0） | 0 | 11ms（最後の1回のみ69ms） | 1.01 | 最大15.5% | 328MB | 8のまま | 69.7→98.4MB |
| 3（各500台、ramp-up 60秒） | 成功1,000/失敗0、想定外の切断0 | 43,911件（0） | 0 | 23〜25ms | 1.67 | 最大23.4% | 274MB | 8のまま | 107.4MB（デモ側プロセス208MB） |

- 段階3の最終スコア：1,009,843 : 1,031,171（差約2%）
- `cpu_steal`：約1分おきに単発〜2行連続で出現。最大は段階1が12.3%、段階2が25.7%、段階3が37.1%
  （段階3の最大は開始直後のTLS接続の立ち上げ）

## 付録B：反映後の再起動回数の見込み

| 時点 | pm2の`restart`列 |
|---|---|
| STEP 0（反映前） | 11 |
| STEP 2後（`legacy`のまま新コード） | 12 |
| STEP 4後（`cached`） | 13 |
| STEP 6で`legacy`へ戻した場合 | 14 |
