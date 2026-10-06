# 複数プロセス化（B案）の設定の下書き ＋ CLAUDE.mdの「RDS不使用」方針の確認

作成日：2026-10-06
対象コミット：`feature/reference-data`（調査開始時点のHEAD）
性質：**下書き（案）。** 読み取りと、本資料の新規作成のみ。コード・設定ファイル（`src/`、`ecosystem.config.js`、nginx、`.env`）は変更していない。
本番EC2・WebARENA・本番DBへの接続も行っていない。ローカルでの小さな確認スクリプトの実行のみ行った（3章・4章。本番ファイル・リポジトリの`.env`には触れていない。スクリプトは`scratchpad`の一時ディレクトリ）。
位置づけ：検討中資料。実装済みの仕様ではない（`docs/spec.md`とは別）。
前提：`docs/proposals/cluster-mode-investigation.md`（2026-10-06）が推奨したB案（pm2 forkを複数・ポート別＋nginx upstream）。

## 凡例

- **【事実】**：コード・docs・ローカル実行で確認できたこと（`ファイル:行`を付記）
- **【推測】**：事実からの導出、nginx/pm2/PostgreSQL/RDSの一般的な仕様に基づく見立て。前提を併記
- **【未確認】**：本番の実機・実ファイルを見ないと分からないこと

> 依頼文の本番nginx設定は**抜粋**（依頼文の記述）で、実ファイル全文は未確認。1章の差分は「依頼文に書かれた行」を基準に書いており、
> 実ファイルの他の行（`proxy_set_header`の詳細、Certbotが追記したSSL設定など）は変えない前提。**適用前に実ファイルとの`diff`確認が必要**。

---

## 0. 先に結論

| # | 結論 | 区分 |
|---|---|---|
| 1 | `.env`に`PORT=3000`があっても、**環境変数`PORT`が優先される**（ローカルで確認：`PORT=3001`を渡すと3001で待ち受け）。`src/index.js`は1行目で`dotenv.config()`を呼び、引数なし・`override`なし。**ecosystemの`env.PORT`でポートを分ければ`.env`の編集は不要** | 事実 |
| 2 | ただし`dotenv`は**カレントディレクトリの`.env`**を探す。pm2の`cwd`を誤ると`.env`が黙って読まれず（エラーなし）、`DATABASE_URL`未設定で起動する。**ecosystemに`cwd`を明記する** | 事実（ローカル確認）＋推測（pm2の挙動） |
| 3 | nginxはupstreamを2つ（`cheerstick_ws`・`cheerstick_api`）に分け、`least_conn`＋`max_fails=2 fail_timeout=10s`を案とする。**`/api/v1/admin/`は`127.0.0.1:3000`固定のまま**。`worker_connections`は**4 vCPU（worker 4）なら16384を案**（8,000接続＝約16,000本、全体で65,536枠）。`worker_rlimit_nofile 32768`は2倍で足りる | 推測（根拠は1章） |
| 4 | 切り替えは**イベント当日ではなく事前に**、m5.xlarge上で行う。接続の切断は「旧`cheerstick-server`が持っていた接続が1回切れる」のみ。**t3.micro（約909MiB）で3プロセスは載せない**（メモリ） | 推測 |
| 5 | DB接続は`N=3`で最大60／`max_connections=100`。**`DB_POOL_MAX`の環境変数化は、N=3では必須ではない。** N=4以上、または対話接続・バックアップが重なるなら先に要る。入れる場合は既定20のままなら挙動は変わらない | 事実＋推測 |
| 6 | **CLAUDE.mdの「RDS不使用」は、`2026-07-25`（コミット`840e36d`）で初めて書かれた。** 理由として追えるのは`docs/spec.md` 7章の「RDSではなく**最小コスト構成**」のみ。判断の日付・議論・意思決定者は**不明**。2026-06-09の引継ぎ書にはAWS移行先として「EC2 or ECS + RDS」の記載があり、その後7/25までの間に方針が「EC2同居」に定まったとみられる（経緯は不明） | 事実（日付・文言）／不明（経緯） |
| 7 | RDSへ移す場合に影響が大きいのは、**`assertNotConnectedToProduction`がDB名`cheerstick_production`に依存している点**、バックアップ・復元手順（`sudo -u postgres`前提）、`monitor-server.sh`のPostgreSQLプロセス数、SSL設定、`max_connections`。コード上`localhost`前提の箇所は`src/`には無い | 事実（一覧は6章） |

---

## 1. nginxの変更案（差分）

### 1-1. 前提・設計方針

【事実】現行（依頼文）：`api.cheerstick.com`は`location /api/v1/admin/`と`location /`が、`ws.cheerstick.com`は`location /cheer`が、いずれも`proxy_pass http://127.0.0.1:3000;`。
【事実】`/api/v1/admin/`の設定は`docs/runbook.md:399-409`に全文あり（`allow 49.156.217.121; deny all;`、`proxy_http_version 1.1;`、`X-Real-IP`・`X-Forwarded-For`・`X-Forwarded-Proto`・`Host`）。
【事実】WebSocket側の`location /cheer`の全文は`cheerstick-ws`の下書き（リポジトリ直下、`runbook.md:884`が「Certbot追記分を除いて本番と一致」と記録）に有り：`Upgrade`/`Connection "upgrade"`/`Host`/`X-Real-IP`/`proxy_read_timeout 86400s`/`proxy_send_timeout 86400s`。

設計方針（案）：
- upstreamを**2つ**に分ける（`cheerstick_ws`・`cheerstick_api`）。中身は同じ3台だが、将来「WebSocketだけ3000を外す」「APIにはkeepaliveを付ける」といった個別調整を可能にするため。WebSocketの`Connection "upgrade"`とupstreamの`keepalive`は同居しにくい【推測：nginx一般】ので分けておくのが無難
- `/api/v1/admin/`は**upstreamを使わず`127.0.0.1:3000`直書きのまま**（管理API・デモ・試合開始終了の固定先）
- 最初は`keepalive`を**付けない**（現行も付いていないと見られる。依頼文に記載なし）。効果測定してから検討
- 3000番のプロセスも`least_conn`の対象に含める（依頼文どおり）。3000は管理APIとデモの子プロセスも受けるため、負担を軽くしたい場合は`weight`を下げる選択肢がある（下記）

### 1-2. 差分（案）

`/etc/nginx/nginx.conf`（`http`ブロック内、または`sites-enabled`ファイルの`server`より前。`upstream`は`http`コンテキストに置く。`sites-enabled/*`は`http`内でincludeされるので、各ファイルの先頭に置いても有効）：

```diff
+# --- 複数プロセス（B案）：2026-10-xx 追加（理由：Node 1プロセスでは8,000接続を受けきれないため） ---
+# WebSocket用。least_conn：会場Wi-Fiが1つのIPのため、ip_hashは使えない
+upstream cheerstick_ws {
+    least_conn;
+    server 127.0.0.1:3000 max_fails=2 fail_timeout=10s;
+    server 127.0.0.1:3001 max_fails=2 fail_timeout=10s;
+    server 127.0.0.1:3002 max_fails=2 fail_timeout=10s;
+}
+# 観客向けREST API用（geturl・reference・スコア閲覧）
+upstream cheerstick_api {
+    least_conn;
+    server 127.0.0.1:3000 max_fails=2 fail_timeout=10s;
+    server 127.0.0.1:3001 max_fails=2 fail_timeout=10s;
+    server 127.0.0.1:3002 max_fails=2 fail_timeout=10s;
+}
```

`/etc/nginx/sites-enabled/cheerstick-ws`（`location /cheer`）：

```diff
     location /cheer {
-        proxy_pass http://127.0.0.1:3000;
+        proxy_pass http://cheerstick_ws;
         proxy_http_version 1.1;
         proxy_set_header Upgrade $http_upgrade;
         proxy_set_header Connection "upgrade";
         proxy_set_header Host $host;
         proxy_set_header X-Real-IP $remote_addr;
         proxy_read_timeout 86400s;
         proxy_send_timeout 86400s;
     }
```

`/etc/nginx/sites-enabled/cheerstick-api`（`location /`のみ。`location /api/v1/admin/`は**変更しない**）：

```diff
     location /api/v1/admin/ {
         allow 49.156.217.121;
         deny  all;
         client_max_body_size 5m;
         proxy_pass         http://127.0.0.1:3000;      # ← 変更しない（管理API・デモの固定先）
         ...
     }

     location / {
-        proxy_pass http://127.0.0.1:3000;
+        proxy_pass http://cheerstick_api;
         ...（既存のproxy_set_header等はそのまま）
     }
```

【事実】`proxy_pass http://<upstream名>;`にURI部分（パス）を付けない形のため、リクエストURIはそのまま渡される（現行の`http://127.0.0.1:3000;`と同じ挙動）。
【推測】`proxy_pass`の差し替え以外は変えないので、`X-Real-IP`・`X-Forwarded-For`等は現行のまま維持される（実ファイルでの確認が前提）。

3000番の負担を下げたい場合（案、初期は不要）：`server 127.0.0.1:3000 weight=1`に対し他を`weight=2`にする、など。`least_conn`では重み付きの比率で接続数を割る。**まずは同一重みで始め、7章の偏り確認で必要なら調整**。

### 1-3. `max_fails`/`fail_timeout`の値の案と、プロセスが1つ落ちたときの挙動

値の案：`max_fails=2 fail_timeout=10s`（依頼文の「付ける場合の値の案」への回答）。
- `fail_timeout`は「失敗を数える期間」と「失敗扱いにしたサーバーを外す期間」の両方を意味する【推測：nginx一般仕様】。10秒なら、落ちたプロセスは約10秒除外され、10秒後に再度試される
- `max_fails=2`：連続した接続拒否（`ECONNREFUSED`）が2回あれば除外。1回だけだと一過性のエラーで外れすぎ、大きいと落ちたプロセスへの試行が増える
- 既定は`max_fails=1 fail_timeout=10s`。**既定との差は小さい**ため、「付けない」でも大きくは変わらない【推測】

プロセスが1つ（例：3001）落ちたときの挙動【推測：nginxの一般仕様。実機未検証、7章で確認】：

| 対象 | 挙動 |
|---|---|
| **3001が持っていた既存のWebSocket接続**（約8,000÷3＝約2,700本） | TCPが切れる。クライアントは再接続（1〜3秒後から、ジッター±50%。`index.html:590-594`）。**再接続すると応援画面から完了画面に戻り、STARTの押し直しが必要**（`large-event-8000-investigation.md` D-2） |
| 再接続の振り分け | `least_conn`なので、3001が落ちている間は接続数が少ない側へ（3000・3002）。3001へ試行して`ECONNREFUSED`になった場合、`proxy_next_upstream`（既定：`error timeout`）により**同じリクエストを次のサーバーへ再試行**する（WebSocketのUpgradeリクエストは接続前の失敗なので再試行できる） |
| 負荷 | 落ちた1/3が残り2プロセスへ寄る。**各プロセスのCPUは約1.5倍**（約28%→約42%、依頼文の「8,000接続で単独約83%」を3等分して見た推測。ピーク時はさらに高い）。再接続の山（約2,700本が数秒内）が2プロセスに集中する |
| pm2の自動再起動 | pm2が数秒〜で再起動する（既定で`autorestart: true`）。復帰後は`fail_timeout`（10秒）経過後に新規接続の対象に戻る。**`least_conn`は新規接続を接続数の少ない復帰プロセスに寄せる**ので、徐々に均される。既存の接続は移動しない |
| 観客向けAPI（`location /`） | 失敗した試行は次のサーバーへ再試行（GETなど冪等なリクエスト。POSTは既定では再試行しない【推測】）。`geturl`・`reference`・スコア閲覧はGETなので影響が小さい |
| **3000が落ちた場合** | 観客向けは上記と同じ。**管理API（`/api/v1/admin/`）は固定のため`502 Bad Gateway`になる**（2章） |

### 1-4. `worker_connections`の引き上げ案

【事実】現行：`worker_processes auto`・`worker_connections 8192`・`worker_rlimit_nofile 32768`（依頼文、`runbook.md:81-82`）。
【事実】WebSocketを1本プロキシすると、クライアント側とアップストリーム側の**2接続**を消費する（9/21に実測、`runbook.md:86-88`）。8,000接続＝**約16,000本**。
【事実】`worker_processes auto`＝vCPU数。t3.micro（2 vCPU）なら2、m5.xlarge（4 vCPU）なら4。

| 構成 | worker数 | 8192の全体枠 | 8,000人の使用 | 16384の全体枠 | 8,000人の使用率 |
|---|---|---|---|---|---|
| t3.micro | 2 | 16,384 | 約16,000（**約98%**、余裕ほぼゼロ） | 32,768 | 約49% |
| m5.xlarge | 4 | 32,768 | 約16,000（約49%） | 65,536 | 約24% |

【推測】nginxは接続を各workerへ必ずしも均等に配らない（accept_mutexの既定や`reuseport`の有無による）。均等でなくても、**1ワーカーに全体の半分が寄っても8,000人で足りるか**で見ると：
- m5.xlarge・8192：1ワーカーあたり8,192枠。全体16,000本のうち、片寄りで1ワーカーが8,192本を超えたら不足。**偏りが2倍を超えると危険**（均等なら4,000本）
- m5.xlarge・16384：1ワーカーあたり16,384枠。偏りが4倍でも収まる

→ **案：`worker_connections 16384;`**。`worker_rlimit_nofile`は、1接続が1ファイル記述子を使うため`worker_connections`以上が要る。一般に2倍を見込むことが多く、**現行の32768のままで足りる**（16384×2＝32768）【推測：nginx一般の目安】。
2万人（C案、複数サーバー）では、1台あたりの接続数が減るのでこの値で足りる想定。1台に2万人（40,000本）を載せるなら、`worker_connections 16384`×4＝65,536で足りるが、nginx以外（Node・DB）が持たない。

**ephemeral port（副次的な効果）**【推測】：nginx→`127.0.0.1:300x`の接続は、「宛先IP・宛先ポート」ごとに送信元ポートが必要で、Linux既定（約28,000本）が上限になる。単一ポート3000だと8,000接続で足りるが2万人（クライアント側と別にアップストリーム側20,000本）は上限に近づく。**3ポートに分けると宛先が3つになり、実質の上限が約3倍**になる。【未確認】本番の`net.ipv4.ip_local_port_range`。

**反映**：`nginx.conf`の`events`ブロックを書き換え、`nginx -t`→`systemctl reload nginx`（`runbook.md:418-421`・2026-09-27の手順と同じ）。`reload`は既存の接続を維持する【推測：nginxの`reload`は古いworkerを既存接続が終わるまで残す。7-1で確認】。ただし**`worker_connections`の変更を反映した新workerと、旧workerが接続を分け合う期間が一時的に生じる**。

---

## 2. pm2の`ecosystem.config.js`の案

### 2-1. 案

リポジトリには置かれていない（`large-event-scaling.md` B-3：本番にもリポジトリにも無い）。**追加するならコード（リポジトリ）の変更になるため、別途承認・コミットが要る。** 以下は下書き：

```js
// ecosystem.config.js（案。リポジトリ直下 /home/ubuntu/cheerstick-server-new/ に置く想定）
// B案：同一のコードを3つのポートで起動する。.envは共通（PORTだけenvで上書きする）。
const PORTS = [3000, 3001, 3002];

module.exports = {
  apps: PORTS.map((port) => ({
    name: `cheerstick-${port}`,
    script: 'src/index.js',
    cwd: '/home/ubuntu/cheerstick-server-new', // dotenvは cwd の .env を読む（3章）。必ず明記する
    exec_mode: 'fork',
    instances: 1,
    env: {
      PORT: String(port), // .envのPORT=3000より優先される（3章で確認）
    },
    // 以下は既定値と同じ想定のため、必要になるまで書かない：autorestart: true
  })),
};
```

【事実】`PORT`は`process.env.PORT || 3000`で読まれる（`src/index.js:8`）。`adminDemoController`の自己呼び出し（`127.0.0.1:${PORT}`、`:22-23`）も同じ`PORT`を使うため、3000番のプロセスのデモは3000番自身を呼ぶ（固定先で閉じる）。
【事実】`NODE_ENV`等は`env`に書かない（`.env`の値を使う。pm2の`env`で上書きしない）。
【事実】`SIGINT`で`process.exit(0)`（`src/index.js:28-33`）。pm2の既定の停止シグナルは`SIGINT`のため、`kill_timeout`（既定1,600ms）内に終了する【推測：pm2の既定仕様】。
【推測】`script`は`cwd`からの相対でよい。`pm2 startup`（systemd）は2026-09-06に設定済みで、`pm2 save`で新構成が自動復帰の対象になる（`large-event-scaling.md` B-3、未検証）。

### 2-2. 既存の`cheerstick-server`からの切り替え手順（案）

**実施タイミング：イベント当日ではなく、事前（利用者がいない時間帯）。** 切り替えで必ず1回、既存の全接続が切れる（下記）。
前提：EC2を**m5.xlarge以上へ上げた後**に実施する（t3.micro・約909MiBに3プロセスは載せない。メモリは1プロセスあたり約150MB前後が目安【未確認：9/21〜10/1の測定からの粗い値】）。インスタンスタイプの変更は停止→起動を伴い、**サービスが数分止まる**（Elastic IPは維持される、`runbook.md`記載のとおり）。

| # | 操作 | 目的・注意 |
|---|---|---|
| 0 | バックアップ：`sudo cp -a /etc/nginx/sites-available /etc/nginx/sites-available.bak_$(date +%Y%m%d_%H%M%S)`、`/etc/nginx/nginx.conf`のバックアップ、`pm2 save`の前に`cp ~/.pm2/dump.pm2 ~/dump.pm2.bak_...`、gitタグ（`runbook.md`の標準手順） | ロールバック用 |
| 1 | `ecosystem.config.js`を配置（リポジトリへのコミット＋サーバーで`git pull`、または手置き） | 配置方法の判断は別途 |
| 2 | **新プロセス2本を先に起動**：`pm2 start ecosystem.config.js --only cheerstick-3001,cheerstick-3002` | この時点でnginxはまだ3000のみを向いており、利用者に影響しない。起動ログ（`[WS] CheerStick WebSocket server attached`、`[rate-limit] config`）と、`curl -s http://127.0.0.1:3001/health`・`:3002/health`で確認 |
| 3 | nginxのupstream・`proxy_pass`を差し替え（1章）、`sudo nginx -t`→`sudo systemctl reload nginx` | `nginx -t`が失敗したらreloadせず、バックアップから戻す。**この時点から、新規接続は3000・3001・3002へ振り分けられる**（既存の接続は旧workerと3000に残る） |
| 4 | 旧プロセスを置き換え：`pm2 delete cheerstick-server`→`pm2 start ecosystem.config.js --only cheerstick-3000` | **ここで3000が約数秒〜十数秒止まる**。3000に残っていた全接続が切れ、再接続で3つに分散。管理API（`/api/v1/admin/`）はこの間`502`。`delete`と`start`の間隔を短くする（同じコマンド行で`;`連結等） |
| 5 | `pm2 save` | 自動復帰（再起動後）に反映 |
| 6 | 確認：`pm2 list`（3本`online`）、各`/health`、`ss -tn state established '( sport = :3000 or sport = :3001 or sport = :3002 )'`で振り分け、`curl`で管理API（オフィスIPから）が通ること、スコアAPI | 7章の合格基準へ |

**接続が切れる点**：手順4で、旧`cheerstick-server`（3000）が持っていた接続が**1回だけ**切れる。切れた利用者は再接続後に完了画面へ戻り、STARTを押し直す必要がある（現行の挙動）。手順3の時点で新規接続は既に3つへ分散しているので、手順4で切れるのは「3000に残っていた分」のみ。**どれだけ切れるかは、手順3から手順4までの時間と、その間に接続した人数による**。利用者がいない時間帯なら影響は無い。

**名前が変わることの影響**【事実】：
- `pm2 logs cheerstick-server`・`pm2 restart cheerstick-server`（`runbook.md:191, 230, 360, 607-608`等の手順）は、`cheerstick-3000`等に読み替えが要る。
- ログファイルは`~/.pm2/logs/cheerstick-3000-out.log`等、プロセスごとに分かれる。**旧`cheerstick-server`のログ（再起動回数の累積8回等）は引き継がれない**。
- `scripts/demo/monitor-server.sh`は`PM2_APP_NAME="cheerstick-server"`固定（`:21`）で、改修が要る（4章）。

代替案（名前を変えない）：3000番のプロセスだけ名前を`cheerstick-server`のままにする。`pm2 delete`が不要で、手順4は`pm2 restart`相当（`.env`・コード・ポートの更新を含むなら`--update-env`）になる。**名前を揃える（`cheerstick-3000`）か、既存の運用を保つか**は判断が要る。

ロールバック：`pm2 delete cheerstick-3000 cheerstick-3001 cheerstick-3002`→`pm2 start src/index.js --name cheerstick-server`（元の起動コマンドは【未確認】。`large-event-scaling.md` B-3に例示の形があるが、本番での実際のコマンドは確認が必要）→nginxをバックアップから戻して`reload`→`pm2 save`。

### 2-3. 管理APIとデモを受ける3000が落ちた場合の影響と、手動での切り替え案

| 項目 | 影響 |
|---|---|
| 管理API（試合の開始・終了、デバイス管理等） | `502`。**試合の開始・終了ができなくなる**（イベント中は致命的になりうる）。pm2が自動再起動するので、通常は数秒〜十数秒で復帰【推測】 |
| 観客のWebSocket・観客向けAPI | 3000が持っていた分は再接続。他の2プロセスが受けるので継続できる |
| デモ状態（`demoModeState`） | プロセスのメモリ上のため**失われる（`idle`に戻る）**。実行中のデモ子プロセスは`killRunningChildForShutdown`で終了（`index.js:28-33`）。クラッシュ（`SIGTERM`なし）の場合、子プロセスが残る可能性があるが、これは単一プロセス構成でも同じ |
| live試合キャッシュ | 他の2プロセスのキャッシュはTTL（2秒）で回復。3000の再起動時は空から始まる |
| レート制限（管理の`adminIpLimiter`） | 3000のカウンタが失われる（緩む方向のみ） |

手動での切り替え案（3000が**長時間復旧しない**場合）：

1. `sudo vi /etc/nginx/sites-available/cheerstick-api`で、`location /api/v1/admin/`の`proxy_pass`を`http://127.0.0.1:3001;`に変更
2. `sudo nginx -t`→`sudo systemctl reload nginx`
3. デモは使えなくなっている（状態が失われているため）ので、管理画面から「デモをセット」し直す（3001番のプロセスが受ける。`API_BASE`は自プロセスの`PORT`＝3001を指す）
4. 3000の復旧後、元に戻すかはその時点で判断（戻す際はデモの状態が再び失われるので、イベント中は戻さない）

【推測】管理APIは低頻度のため、**自動フェイルオーバー（`backup`指定等）は不要**。ただし`location /api/v1/admin/`を`upstream`化して`server 127.0.0.1:3000; server 127.0.0.1:3001 backup;`とすれば、3000の停止時に自動で3001へ向く。**その場合、3001に管理操作が渡っている間、キャッシュ即時破棄・デモ状態が3001側になり、3000復旧後に管理操作が3000に戻って状態が分断される**（`cluster-mode-investigation.md` 2章の問題が再発）。**手動切り替えのほうが安全**【推測】。

---

## 3. dotenvの優先順位（ローカル確認）

### 3-1. `src/index.js`の起動順序

【事実】`src/index.js:1`が`require('dotenv').config();`（引数なし）。続いて`require('./app')`（`:3`）以降が読み込まれる。つまり**`.env`は他のモジュールより先に読み込まれる**（`rateLimit.js`・`db/index.js`が`process.env`を読むのは、その後）。`PORT`の読み取りは`:8`（`process.env.PORT || 3000`）。
【事実】`dotenv`のバージョン：`16.6.1`（`node_modules`）、Node：`v24.15.0`（ローカル）。本番のNodeは`24.18.0`（`large-event-scaling.md` B-3の記録）。

### 3-2. 確認スクリプトと結果

`src/index.js`のDB接続（`assertNotConnectedToProduction`）はローカルDBが無いと失敗するため、**`dotenv.config()`と`PORT`の読み取りだけを再現した小さなスクリプト**で確認した（一時ディレクトリ`scratchpad/dotenv-test/`に、`PORT=3000`・`FOO=from_dotenv`を書いたダミー`.env`と`t.js`を作成。リポジトリの`.env`・本番ファイルには触れていない。`t.js`は`require('dotenv').config()`→`process.env.PORT || 3000`で`listen`→待ち受けポートを表示→閉じる）。

| ケース | 実行 | 結果 |
|---|---|---|
| A | `.env`のみ（環境変数なし）、cwd=`.env`のあるディレクトリ | `PORT=3000`で待ち受け（`.env`の値） |
| **B** | `.env`に`PORT=3000`、**`PORT=3001`を環境変数で渡す** | **`3001`で待ち受け**（環境変数が優先） |
| C | `PORT=3001 FOO=from_env`（`.env`に`FOO=from_dotenv`） | `PORT=3001`、`FOO=from_env`（**`.env`の値は、既存の環境変数を上書きしない**） |
| D | cwdが`.env`の無い別ディレクトリ、`PORT=3002` | `3002`で待ち受け。`FOO`は`undefined`（**`.env`が見つからなくてもエラーにならず、黙って読まれない**） |
| E | cwd別・環境変数なし | `3000`（コードの既定値）。`.env`が読まれていないことに気付けない |

【事実】結論：**`.env`に`PORT=3000`がある状態で環境変数`PORT=3001`を渡して起動した場合、3001で待ち受ける**（`dotenv`は既定で、既に設定済みの環境変数を上書きしない）。
【事実】注意点：`dotenv`は**プロセスのカレントディレクトリ**の`.env`を探す（`config()`に`path`を渡していないため）。`.env`が見つからなくてもエラーにならない（ケースD）。
【推測】pm2の`env`は、子プロセスの環境変数として渡される（`process.env.PORT`として見える）ため、ローカルの`PORT=3001 node ...`と同じ挙動になる。**pm2経由での実機確認は未実施**。**ecosystemの`cwd`が誤っていると`DATABASE_URL`が空のまま起動し、DB接続エラーで落ちる**（気付きやすい失敗ではあるが、`NODE_ENV`等が黙って既定値になる項目もある）。
【未確認】本番`.env`の`PORT`の位置（依頼文：3行目）以外の内容。`.env`の編集は不要という結論は、**環境変数が優先される**ことに依存している。

---

## 4. `monitor-server.sh`の複数プロセス対応（方針案・実装はしない）

### 4-1. 現状

【事実】`scripts/demo/monitor-server.sh:70-74`：`pm2 jlist`の出力に対し`grep -o '"cpu":[0-9.]*' | head -1`のように**最初の1件だけ**を拾う（`cpu`・`memory`・`restart_time`）。`PM2_APP_NAME="cheerstick-server"`固定（`:21`）で、出力の列名にもそれを使う（`:84`）。
【事実】ポート3000の確立済み接続数も`sport = :3000`固定（`:68`）。`pg_processes`は`ps -C postgres`でPostgreSQLのプロセス数（ローカル同居前提、6章）。
【推測】現行の`head -1`は、**pm2に他のアプリがあれば、それを拾う**可能性がある（`jlist`の並び順次第）。複数プロセスでは「3プロセスのうち先頭だけ」を記録し、**残りが見えない**。

### 4-2. 改修方針（案）

1. **`pm2 jlist`をNodeで解析する**（サーバーにNodeは入っている。`jq`の有無は【未確認】）。`name`が`^cheerstick-`にマッチする全プロセスについて、`name`・`pm2_env.status`・`pm2_env.restart_time`・`monit.cpu`・`monit.memory`を取り出す
2. **出力の形**：プロセスごとに`pm2_<name>_cpu=...% pm2_<name>_rss=...MB pm2_<name>_restarts=... pm2_<name>_status=...`、さらに合計`pm2_total_cpu`・`pm2_total_rss`・`pm2_total_restarts`・`pm2_procs`（稼働数）。**`pm2_procs`が3を下回ったらプロセス落ち**の検知に使える
3. **ポート別の接続数**：`ws_conns_3000=... ws_conns_3001=... ws_conns_3002=...`。`least_conn`の偏りの確認（7章）に使う。ポート一覧は環境変数（例：`MONITOR_PORTS="3000 3001 3002"`、既定`3000`）で渡す
4. **nginx側の接続数**（`ss -tn state established '( sport = :443 )'`）も1行加える（クライアント側の総接続数。アップストリーム側との比が約1:1）
5. **後方互換**：プロセス名を`cheerstick-server`のままにする場合は、従来の列名（`pm2_cheerstick-server_*`）がそのまま出る。名前を変えた場合は、**過去のログとの列名の差**が出る（比較時に注意）
6. `monit.cpu`はpm2が計算した**1コアに対する%**（100%＝1コア）【推測：pm2の仕様】。複数プロセスの合計がサーバー全体のCPUと対応する

### 4-3. ローカルでの確認（ダミーJSONで集計ロジックのみ）

`pm2 jlist`の想定形（`name`・`pm2_env.status`・`pm2_env.restart_time`・`monit.cpu`・`monit.memory`）を模したダミーJSONで、上記1・2の集計をする小さなNodeスクリプト（`scratchpad`、リポジトリ外）を実行した：

| 入力 | 出力（要約） |
|---|---|
| 無関係な`other`＋`cheerstick-3000`・`cheerstick-3001` | `other`を除外し、2プロセスの個別値と`pm2_total_cpu=58.5%`・`pm2_procs=2`を出力 |
| 従来名の`cheerstick-server`1件 | `pm2_cheerstick-server_*`＋`pm2_procs=1`（従来名でも動く） |
| 不正なJSON | `pm2_parse=NG`を出力（監視ループを止めない） |

【未確認】実際の`pm2 jlist`のJSON構造（キー名の位置）は、**本番のpm2では未確認**（ダミーは記憶・一般形に基づく）。実装時は、一時インスタンスの`pm2 jlist`を保存して構造を確認してからテストする。

---

## 5. 複数プロセス時のDB接続数

【事実】`pg.Pool`：`max:20`・`idleTimeoutMillis:30000`・`connectionTimeoutMillis:5000`（`src/db/index.js:3-9`）。**環境変数化されていない**。
【事実】`max_connections=100`（2026-09-28確認、`large-event-scaling.md` 0章）。`superuser_reserved_connections`は既定3として、一般接続は実質97。

| プロセス数N | `max:20`での最大合計 | 対話接続・`pg_dump`等を足す前の余裕（97に対し） |
|---|---|---|
| 1 | 20 | 77 |
| **3（今回）** | **60** | **37** |
| 4 | 80 | 17 |
| 5 | 100 | 超過 |

【事実】`Pool`は必要になったときにだけ接続を増やし、アイドル30秒で閉じる。**常時60本張られるわけではない。**
【事実】他の接続元：`psql`（対話）、`pg_dump`（バックアップ、`runbook.md:721`：1接続）、`node src/db/migrate.js`（1接続）。デモの子プロセスはDBに接続しない（WebSocket経由）。
【推測】N=3では最大60＋対話・バックアップ数本＝65前後で、97に収まる。**N=3なら`DB_POOL_MAX`の環境変数化は必須ではない。**

`DB_POOL_MAX`環境変数化の要否：

| 観点 | 判断 |
|---|---|
| N=3（今回） | **不要**（収まる） |
| N=4以上 | **要る**（9/28の試算：N=4なら15へ引き下げ。`large-event-scaling.md` B-2-1） |
| 入れておく利点 | 既定`20`のままなら**挙動は変わらない**（1行の変更）。イベント直前に、コード変更・デプロイなしで`.env`＋再起動のみで調整できるようになる。ただし**再起動は全接続を切る**ため、結局イベント前に済ませる必要がある |
| 注意 | プロセスを増やして`max`を下げすぎると、登録・再接続のバーストで待ち行列が`Pool`側で5秒を超えやすい（`large-event-8000-investigation.md` B-2）。`connectionTimeoutMillis`も併せて検討が要る |
| 実際のCPU | m5.xlarge（4 vCPU）では、同時に走れるSQLは実質コア数程度【推測】。`Pool`を増やして書き込みが速くなるわけではない |

→ **推奨：N=3は変更なしで進められる。環境変数化は、N=4以上にする判断が出た時点で実施**（コード変更・デプロイが要るため、その時点での承認が必要）。
【未確認】`pg_stat_activity`での現状の接続数（本番DBへの接続操作のため未実施）。

---

## 6. CLAUDE.mdの「RDSを使わない」方針

### 6-1. 記載の場所と文言（事実）

| 場所 | 文言 |
|---|---|
| `CLAUDE.md:8`（「このプロジェクトについて」） | 「本番: AWS EC2（自社管理）／ nginx + pm2 + PostgreSQL（EC2同居、RDS不使用）」 |
| `docs/spec.md:290`（7章 データベース） | 「PostgreSQL、EC2上に直接インストール（**RDSではなく最小コスト構成**）。」 |
| `docs/runbook.md:117`（データベース） | 「PostgreSQL（EC2上に直接インストール、RDS不使用）」 |
| `docs/proposals/large-event-scaling.md:354`（B-5） | 「本プロジェクトはRDS不使用の方針（`CLAUDE.md`）」 |

### 6-2. 記載された日付と理由（コミット履歴・worklog・docsから追えるもの）

【事実】
- **CLAUDE.mdに「RDS不使用」が初めて入ったのは、2026-07-25のコミット`840e36d`**（`docs: 引継ぎドキュメント体制を整備（spec/runbook/worklog分割）`）。`git log -S"RDS" -- CLAUDE.md`で、このコミットが唯一の追加。CLAUDE.md自体がこのコミットで新規作成された（65行）
- `docs/spec.md`の「RDSではなく最小コスト構成」も同じ`840e36d`で入った（spec.mdの分割作成時）。**spec.mdの記述は、分割前の引継ぎ書（`handover.md`等）から移したものとみられる**【推測】
- **理由として記録があるのは「最小コスト構成」の1語のみ**（`docs/spec.md:290`）。それ以上の詳細（RDSの費用試算、検討した代替案、決定者・決定日）は、`docs/`・`worklog.md`・コミットメッセージのいずれにも**見当たらない**
- 前史：**2026-06-09のコミット`d85552c`（`handover.md`）に「次: AWS移行（2026年7月末週目安）／AWS環境設計・構築（EC2 or ECS + RDS）／Render.comからAWSへデータ移行」とある**。つまり6月時点の計画はRDSを含む案だった。`src/db/index.js`の初版（`e3b1477`、2026-05-28）のコメント「Render無料プランの上限に合わせて調整」は、移行前のRender.com環境の名残（`large-event-scaling.md` B-2）
- 6/9（RDSを含む計画）から7/25（RDS不使用と明記）の間に、**方針がEC2同居へ変わった**ことになる。**変更の経緯・日付・理由は不明**

【不明】：RDS不使用を決めた日付、決定者（KMT様か否か）、費用以外の理由（運用の単純さ、同一リージョン内の遅延、等）。
【推測】「最小コスト構成」の文言から、費用が主な理由とみられる。商用リリース（2026年8月）までの短期間での構築と、利用規模（当時は2,000本想定）から、初期費用を抑える判断だった可能性がある（**根拠となる記録は無いため、推測**）。

### 6-3. RDSに移す場合に影響を受ける箇所（一覧・変更はしない）

| # | 箇所 | 内容 | 影響の見立て |
|---|---|---|---|
| 1 | `src/db/productionGuard.js`（`assertNotConnectedToProduction`、`src/index.js:11`で起動時に実行） | **`current_database()`が`cheerstick_production`のときだけ、`ALLOW_PRODUCTION_DB=true`を要求する。ホスト名・接続先は見ていない** | 【事実】DB名で判定するので、**RDSでも本番DB名が`cheerstick_production`のままなら動作は変わらない**。**RDS側のDB名を変えると（例：`cheerstick`）、ガードが黙って効かなくなる**（開発環境から本番RDSへ誤接続しても起動できてしまう）。RDSは開発端末から到達できるかが設定次第で、誤接続の危険の性質が変わる【推測】。ローカル・stagingのDB名も`cheerstick_staging`等のまま（`runbook.md:526`） |
| 2 | `migrations/001_initial_schema.sql:8`：`CREATE EXTENSION IF NOT EXISTS pgcrypto;` | UUID生成（`gen_random_uuid()`）に使用。全テーブルの主キーのDEFAULT | 【推測】RDSは`pgcrypto`をサポート（一般仕様）。拡張の作成にはDB所有者または`rds_superuser`権限が要る（PostgreSQL 13以降は`pgcrypto`が「trusted」で、`CREATE`権限があれば可）。**本番のPostgreSQLバージョンは【未確認】**。既に作成済みのDBをダンプ・リストアで移すなら、実行不要 |
| 3 | `migrations/`全体の`GRANT`・`CREATE ROLE`・`SUPERUSER`依存 | 全マイグレーションを`grep`したが、`GRANT`・ロール作成・`SUPERUSER`の記述は**無い**（`pgcrypto`のみ）。`gen_random_uuid()`は拡張依存 | 【事実】スーパーユーザー権限や特殊な拡張への依存は、`pgcrypto`以外に見当たらない |
| 4 | テーブル所有者・権限 | アプリは`cheerstick`ユーザーで接続。`runbook.md:500-535`：stagingでテーブル所有者が違うと`ALTER TABLE`が失敗した（`must be owner of table`） | 【事実】RDSでも、マイグレーション実行ユーザー＝テーブル所有者にする必要がある（移行時のダンプ・リストアで所有者がどうなるかに注意）。RDSのマスターユーザーは`superuser`ではなく`rds_superuser`で、`ALTER ... OWNER TO`のできる範囲が異なる【推測】 |
| 5 | `src/db/index.js:5`：`ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false` | **本番（`NODE_ENV=production`）はSSL有効（証明書検証なし）** | 【事実】RDSへの接続でSSLは通常必須／推奨。`rejectUnauthorized: false`なので、RDSのCA証明書を設定しなくても接続はできるが、**証明書検証を行わない**（中間者攻撃への耐性が低い）。RDSのCAバンドルを使う形に直すのが望ましい【推測】。**現在の本番（EC2同居）でこの`ssl`設定がどう動いているか**（ローカルのPostgreSQLがSSLを有効にしているか、`NODE_ENV`が`production`か）は**【未確認】** |
| 6 | `DATABASE_URL`（`.env`、`src/db/index.js:4`） | `connectionString`で接続先を指定 | 【事実】ホスト名を変えるだけで切り替えられる。`src/`に`localhost`・`127.0.0.1`をDB接続先として決め打ちしている箇所は**無い**（`localhost`が出るのは`UPLOAD_URL_BASE`の既定値（`uploadController.js:42`）と`.env.example`のサンプルのみ） |
| 7 | バックアップ・復元手順 | `runbook.md:713-721`・`docs/tasks/2026-09-30-backup-checkpoint.md:76, 158`：`sudo -u postgres pg_dump cheerstick_production > $FILE`（EC2上のOSユーザー`postgres`で実行） | 【事実】**RDSでは`sudo -u postgres`が使えない**。`pg_dump -h <RDSエンドポイント> -U <ユーザー> ...`の形（パスワードは`PGPASSFILE`等）に直す。RDSの自動スナップショット（保持期間・Point-in-Time Recovery）で代替・併用できる【推測】 |
| 8 | 運用手順の`psql`コマンド | `runbook.md:526, 530, 615`等：`sudo -u postgres psql -d ...`、`psql -U cheerstick -d cheerstick_production` | 【事実】ホスト指定（`-h`）の追加が要る。`sudo -u postgres`はRDSでは使えない |
| 9 | `scripts/demo/monitor-server.sh:82`：`pg_procs=$(ps -C postgres --no-headers ... \| wc -l)` | EC2上のPostgreSQLプロセス数で接続数を代用 | 【事実】**RDSでは同一ホストにpostgresプロセスが無く、常に0になる**。接続数の確認は`pg_stat_activity`（DBへの接続が要る）かCloudWatch（`DatabaseConnections`）に変わる |
| 10 | CPU・メモリの計測（`monitor-server.sh`の`load`・`cpu_*`・`mem_*`） | 同居のPostgreSQLを含むサーバー全体の値として読む | 【事実】RDSに分離すると、サーバー側の値はNode・nginxのみになり、**DB側の負荷はCloudWatchで見る**。複数プロセス化の検証（7章）の合格基準の読み方が変わる |
| 11 | `scripts/load-test/db.js`・`seed-dummy-devices.js`ほか（負荷試験の専用DB`cheerstick_loadtest`） | `DATABASE_URL`で接続（`scripts/load-test/db.js:15-19`） | 【事実】接続先は`DATABASE_URL`。専用DB・一時インスタンスの方式（9/21）は、RDSでは「一時RDSの作成」か別DBの作成になる |
| 12 | ネットワーク・レイテンシ | 現状はループバック（同一ホスト）。`count`の`cached`モードで1往復／件 | 【推測】RDSは同一VPC・同一AZでも1ms前後のネットワーク往復が加わる。`cheer_logs`のINSERT（約1,600件/秒）はプール内で並行するため、スループットへの影響は小さいが、**登録・再接続の約20往復・6往復の経路（`large-event-8000-investigation.md` B-1, D-3）の応答は遅くなる**。同一AZに置く、接続数の上限（`max_connections`はインスタンスサイズ依存）を確認する、が要る |
| 13 | `max_connections` | 現状100（既定、変更なし） | 【推測】RDSは既定値がインスタンスサイズ（メモリ）依存で、パラメータグループで変更できる。N×20の接続数の前提（5章）を引き継ぐ |
| 14 | セキュリティ・ネットワーク | DBはEC2内に閉じている（外部からの接続は想定されない）。`.env`に`PGPASSFILE`（ローカルの`.env`には存在、本番は【未確認】） | 【推測】RDSはセキュリティグループでEC2からのみ許可する設計になる。2026-07-27の秘密情報の取り扱い規則（`CLAUDE.md`）はそのまま適用 |
| 15 | コスト | 「最小コスト構成」（`spec.md:290`）が方針の理由 | 【推測】RDS（例：db.m5.large）の費用が加わる。**単発イベントのため、イベント期間のみRDSを起動する運用も考えられるが、データ移行の手間が大きい**（要検討） |

【事実】**コードのうち、DB接続先に依存する箇所は`src/db/index.js`（`DATABASE_URL`・`ssl`）と`src/db/productionGuard.js`（DB名）のみ。** マイグレーション（`src/db/migrate.js`）は`db.query`のみで接続先に依存しない。
【事実】`.env`に`PGPASSFILE`がある（ローカルで存在を確認、値は見ていない）のは、`psql`・`pg_dump`用のパスワードファイル指定とみられる。

---

## 7. 切り替えのリハーサルと試験の観点（一時インスタンス）

前提：本番AMIの複製による一時インスタンス（m5.xlarge）。専用DB・本番から切り離した`.env`（9/21の方式、`large-event-scaling.md` B-6）。負荷の発生元はWebARENA VPS（`battle-demo.js`・`scripts/load-test/load-test.js`）。**本番DBには接続しない。**

### 7-1. nginxの`reload`中の接続維持

| 項目 | 内容 |
|---|---|
| 手順 | ①WebSocket接続を約4,000本張った状態で、1章の差分（upstream追加）を適用し`nginx -t`→`systemctl reload nginx`。②`worker_connections`を8192→16384に変えて、もう一度`reload`。各回で接続数（`ss`）・切断数（負荷側のclose件数）・`nginx`のworkerプロセス（`ps`）を記録 |
| 見る点 | 既存接続が切れないこと。旧workerが既存接続を持ち続け、新workerが新規を受けること（`ps`で`worker process is shutting down`の旧workerが残るのを確認）。`reload`中のレイテンシ・エラー |
| 合格基準（案） | `reload`による**切断が0**。`reload`後の新規接続が成功し、新旧のworkerを合わせて合計が`worker_connections`の枠内に収まる。**旧workerが1つも残らなくなるまでの時間**（既存接続が終わるまで残る）を記録（長時間接続のため、旧workerは長く残る見込み） |

### 7-2. 1プロセス停止時の再接続

| 項目 | 内容 |
|---|---|
| 手順 | 8,000接続（またはその相当）の定常状態で、`pm2 stop cheerstick-3001`（または`kill -9`）。接続の再分散・CPU・エラーを観察。続けて`pm2 start`で復帰 |
| 見る点 | 約1/3の接続が切れ、残り2プロセスへ再接続（1〜15秒、ジッターあり）。`least_conn`により、復帰プロセスへ新規接続が寄ること。`ECONNREFUSED`時の`proxy_next_upstream`再試行が働くこと（`error.log`の`upstream timed out`・`connect() failed`の件数） |
| 合格基準（案） | 再接続が**30秒以内に9割以上**完了（負荷スクリプトが自動でSTART相当を再送する前提。現行クライアントはSTART待ちになる点は別課題）。残り2プロセスの**CPUが100%に張り付かない**（ピーク約80%以下）。`internal server error`・`connect`失敗が許容範囲内（0に近い）。DB接続数が`max_connections`に収まる。復帰後、**新規接続が復帰プロセスに入る**（接続数が増える） |

### 7-3. `least_conn`の偏り

| 項目 | 内容 |
|---|---|
| 手順 | 8,000接続を**短時間で一斉に**張る（再接続の山を再現）。その後、定常状態で`ss -tn state established '( sport = :3000 or sport = :3001 or sport = :3002 )'`をポート別に集計（4章の`ws_conns_<port>`）。併せて、全員が同じIPから来る条件（WebARENA 1台から）で行う |
| 見る点 | 3プロセスの接続数の差。一斉接続の瞬間に`least_conn`が正しく働くか（nginxが数えるのはnginx自身が持つアクティブな接続数。一斉接続中は集計が遅れて偏る可能性）。**3000番は管理APIも受ける**ので、接続数が同じでもCPUが高くなる点 |
| 合格基準（案） | 3プロセスの接続数の最大／最小が**1.2倍以内**（定常時）。**各プロセスのCPUのピークが約70%以下**、3プロセス間の差が2倍以内。極端に偏る場合は、`weight`で3000の比率を下げる、`hash $arg_id consistent`（クライアントの`?id=`追加）を再検討 |

### 7-4. 管理API固定の確認

| 項目 | 内容 |
|---|---|
| 手順 | 負荷中に、オフィスIP相当から①`GET /api/v1/admin/demo/status`を20回連続、②デモの`setup`→`start`→`status`→`stop`、③`PATCH /api/v1/admin/events/:id/status`（開始・終了）を発行 |
| 見る点 | `/api/v1/admin/`のリクエストが**常に3000番に届くこと**（`pm2 logs cheerstick-3000`のアクセスログ（`morgan`）にのみ現れ、3001・3002には出ない）。`status`の応答が毎回同じ状態（`idle`↔`set`の入れ替わりが無い）。試合の終了後、**3000番のプロセスのcountは即時に止まり、3001・3002は最大2秒遅れる**ことの実測（`cluster-mode-investigation.md` 1-3） |
| 合格基準（案） | 管理APIの全リクエストが3000に到達（3001・3002のログに0件）。デモの`setup`→`start`→`stop`が**100%成功**。デモ状態の入れ替わり0。試合終了後の旧`event_id`への記録が**最大2秒、かつ他プロセスのみ**。オフィスIP以外からの`/api/v1/admin/`が`403` |

### 7-5. 追加で確認したい項目

- **切り替え手順（2-2）の予行演習**：手順3〜4で、実際に何本の接続が切れ、何秒で復旧するか（負荷スクリプトのclose件数と再接続の完了時間）
- **ロールバック（2-2）**：旧構成へ戻す手順の所要時間
- **3000の停止時の手動切り替え（2-3）**：管理APIの`proxy_pass`を3001へ変更→`reload`→デモの再セットアップ
- **DB接続数の実測**：負荷中の`pg_stat_activity`の件数（N=3で最大60に収まるか）
- **メモリ**：3プロセスの`RSS`と`mem_available`（m5.xlargeで十分か）
- **登録バースト**（`large-event-8000-investigation.md` B-2）：既存の負荷試験スクリプトに無いため、別途スクリプトが必要

---

## 確認依頼リスト（読み取り専用・岩村様の実施を想定。今回Claude Codeは実行していない）

| 確認したいこと | コマンド（案） | 関連 |
|---|---|---|
| nginxの実ファイル全文（差分の前提の確認） | `sudo cat /etc/nginx/sites-enabled/cheerstick-api /etc/nginx/sites-enabled/cheerstick-ws` | 1章 |
| `.env`の`NODE_ENV`の値（値のみ。他の行は出さない） | `grep -n "^NODE_ENV" /home/ubuntu/cheerstick-server-new/.env` | 6章 #5 |
| PostgreSQLのバージョン・SSL設定 | `sudo -u postgres psql -c "SHOW server_version; SHOW ssl;"` | 6章 #2, #5 |
| ephemeral port・somaxconn | `sysctl net.ipv4.ip_local_port_range net.core.somaxconn` | 1-4 |
| `pm2`の現在の起動コマンド（ロールバック用） | `pm2 show cheerstick-server`（`script path`・`exec cwd`・`args`・`node args`） | 2-2 |
| `jq`の有無・`pm2 jlist`のJSON構造 | `which jq`、`pm2 jlist \| head -c 2000`（環境変数が含まれる場合があるため、**出力を共有する前に値を確認**） | 4章 |
| 一時インスタンス用のAMI複製・インスタンスタイプの選定 | （設計判断） | 7章 |

---

## 変更履歴

- 2026-10-06：初版作成（読み取り＋ローカルでの小さな確認スクリプト実行のみ。依頼文1〜7に基づく）
