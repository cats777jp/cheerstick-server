# CheerStick 案B 本番反映 実施手順書

作成日：2026-07-31
対象：Claude Code（`C:\Projects\cheerstick-server`）
関連：`docs/proposals/production-deploy-plan.md`、
　　　`docs/worklog.md` 2026-07-31エントリ（事前確認結果）

---

## 0. 確定事項（再調査不要）

事前確認（本日実施済み）で判明した事実。**これらを前提として作業する。**

| 項目 | 内容 |
|---|---|
| EC2 | `52.196.49.126`（Elastic IP） |
| 作業元IP | `49.156.217.121`（KMT様VPN経由。管理APIのallow対象と一致） |
| EC2のgit | `feature/reference-data`、origin から **11コミット遅れ**（`fc2c21b` → `4bd647b`） |
| 本番 `.env` | `ALLOW_PRODUCTION_DB` **未設定**、`ALLOWED_ORIGINS=https://app.cheerstick.com` |
| 管理画面のAPI呼び出し | **絶対URL**（`https://api.cheerstick.com/api/v1/admin`） |
| Certbot | `authenticator = nginx`、`certbot.timer` 稼働中 |
| DNS | Route53、`admin.cheerstick.com` は**未登録** |
| `/var/www/` | `cheerstick-app/` と `html/` のみ。**管理画面用は新設が必要** |

### 重要な帰結：`/api/` のプロキシは作らない

管理画面は絶対URLでAPIを呼ぶため、`admin.cheerstick.com` は
**静的HTMLを配信するだけでよい。**

**`admin.cheerstick.com` から `localhost:3000` へのプロキシ設定は作成しないこと。**
作ると、`api.cheerstick.com` 側のIP制限を迂回する経路が生まれる。
管理APIは認証が未実装であるため、これは事実上の全世界公開に相当する。

APIは従来どおり `api.cheerstick.com`（IP制限下）を通る。
CORS対応は `.env` の `ALLOWED_ORIGINS` への1ドメイン追加で行う。

---

## 1. 禁止事項

- `api.cheerstick.com` / `app.cheerstick.com` / `ws.cheerstick.com` の
  **既存nginx設定ファイルの編集**（新規ファイルの作成のみ行う）
- `admin.cheerstick.com` への `/api/` プロキシ設定の作成（上記理由）
- `sudo systemctl restart nginx`（**`reload` を使うこと**）
- DNSレコードの操作（KMT様がコンソールで実施する）
- 本番DBへの直接的な書き込み（管理画面経由の登録は PHASE 6 で行う）
- DELETE機能の実装（別途 `docs/proposals/admin-delete-endpoint.md` で管理。本日は対象外）

---

## PHASE 1：通常デプロイ（11コミットの反映）

### 1-1. `.env` の編集（**最初に行う。順序を誤ると本番が起動しなくなる**）

本番EC2の `.env` に対し、以下2点を行う。

**① `ALLOW_PRODUCTION_DB=true` を追記**

未設定のまま `git pull` → `pm2 restart` すると、`productionGuard` が
`process.exit(1)` し、**本番アプリが起動しなくなる。**

**② `ALLOWED_ORIGINS` に `https://admin.cheerstick.com` を追加**

変更前：
```
ALLOWED_ORIGINS=https://app.cheerstick.com
```

変更後：
```
ALLOWED_ORIGINS=https://app.cheerstick.com,https://admin.cheerstick.com
```

> **カンマの後にスペースを入れないこと。**
> `src/app.js` の実装は `process.env.ALLOWED_ORIGINS?.split(',')` であり、
> トリム処理がない。スペースを入れると `" https://admin..."` という
> 文字列になり、Origin照合に失敗してCORSが通らない。

編集前に `.env` のバックアップを取ること（`cp .env .env.bak_20260731`）。

### 1-2. 追記の確認

```bash
grep -n "ALLOW_PRODUCTION_DB\|ALLOWED_ORIGINS" .env
```

両方が意図通りになっていることを目視確認する。**ここで確認を飛ばさないこと。**

### 1-3. git pull

```bash
cd /home/ubuntu/cheerstick-server-new
git pull origin feature/reference-data
git log --oneline -3
git status
```

`4bd647b` まで到達していること、および `public/admin/index.html` が
存在することを確認する。

### 1-4. 依存関係の確認

11コミット分の反映であるため、`package.json` に変更があった可能性がある。

```bash
git diff fc2c21b..HEAD --stat -- package.json package-lock.json
```

**差分があれば `npm ci` を実行する。** 差分がなければ不要。

### 1-5. pm2 restart

```bash
pm2 restart cheerstick-server
pm2 logs cheerstick-server --lines 40 --nostream
```

**確認すること：**
- `productionGuard` によるブロックが出ていないこと
- サーバーの起動メッセージが出ていること
- `pm2 list` で `online`、再起動回数が異常な値になっていないこと

> **起動に失敗した場合：** 直ちに5章のロールバック手順へ移り、
> ログ全文を添えて報告すること。復旧を優先し、原因追及は後回しでよい。

### 1-6. 一般APIの疎通確認（**必須。飛ばさないこと**）

Vanstone様のアプリが使用する経路であり、ストア審査にも関わる。

```bash
curl -sI "https://api.cheerstick.com/api/v1/webview/geturl?id=<テスト用MAC>"
curl -sI "https://app.cheerstick.com/index.html"
```

WebSocket（`wss://ws.cheerstick.com`）についても、接続が確立するか確認する。

### ■ 停止ポイント①

**PHASE 1の結果を報告し、KMT様の指示を待つこと。** ここまでで本番は
「管理画面を除いて」正常稼働している状態になる。

---

## PHASE 2：DNSレコードの追加（**KMT様が実施**）

Claude Code は操作しない。KMT様がRoute53コンソールで以下を追加する。

```
レコード名：admin.cheerstick.com
タイプ　　：A
値　　　　：52.196.49.126
TTL　　　 ：300
ルーティング：シンプル
```

追加後、伝播を確認する。

```bash
dig A admin.cheerstick.com +short
```

`52.196.49.126` が返ってから PHASE 3 へ進む。
**返らないうちにCertbotを実行すると、証明書の発行に失敗する。**

---

## PHASE 3：管理画面の静的ファイル配置

```bash
sudo mkdir -p /var/www/cheerstick-admin
sudo cp /home/ubuntu/cheerstick-server-new/public/admin/index.html /var/www/cheerstick-admin/
sudo chown -R www-data:www-data /var/www/cheerstick-admin
ls -la /var/www/cheerstick-admin/
```

既存の `/var/www/cheerstick-app/` と同じ所有者・パーミッションに揃えること
（異なる場合は `cheerstick-app` 側に合わせ、その旨を報告する）。

> **注意：** これにより「静的ファイル2箇所問題」（`docs/spec.md` 既知の課題7）が
> 管理画面にも適用される。今後 `public/admin/index.html` を変更した際は、
> **`/var/www/cheerstick-admin/` への再コピーが必要。**
> この点を `docs/runbook.md` に追記すること。

---

## PHASE 4：nginx serverブロックの新設

### 4-1. 新規ファイルを作成する

```
/etc/nginx/sites-available/cheerstick-admin
```

**既存の3ファイルは編集しないこと。**

内容（HTTPのみ。SSLは PHASE 5 でCertbotが追記する）：

```nginx
server {
    listen 80;
    server_name admin.cheerstick.com;

    root /var/www/cheerstick-admin;
    index index.html;

    location / {
        allow 49.156.217.121;
        deny all;
        try_files $uri $uri/ =404;
    }
}
```

### 4-2. 【重要】IP制限を `location /` の内側に書く理由

**`allow` / `deny` を server ブロック直下に書いてはならない。**

Certbotの `nginx` プラグインは、証明書の取得・更新時に
serverブロック内へ**一時的なlocationを挿入**してHTTP-01チャレンジに応答する。

- serverレベルに `deny all` を置くと → 挿入されたlocationにも継承され、
  **初回発行も90日ごとの自動更新も失敗する**
- `location /` の内側に置くと → 兄弟locationには継承されず、**影響しない**

自動更新の失敗は**無言で起きる**ため、リリース後しばらくしてから
「管理画面が突然HTTPSエラーになる」形で表面化する。ここは必ず守ること。

### 4-3. 有効化と反映

```bash
sudo ln -s /etc/nginx/sites-available/cheerstick-admin /etc/nginx/sites-enabled/
sudo nginx -t
```

**`nginx -t` が通らない限り、絶対に次へ進まないこと。**

```bash
sudo systemctl reload nginx
```

> `restart` は使わない。api / app / ws が一瞬落ちる。
> `reload` は設定エラー時に既存設定を維持したまま失敗するため安全側に倒れる。

### 4-4. HTTPでの疎通確認

```bash
curl -sI http://admin.cheerstick.com/
```

VPN接続中のKMT様の環境から `200` が返ることを確認する。

### ■ 停止ポイント②

**PHASE 4の結果を報告すること。** 証明書取得は不可逆な操作
（Let's Encryptにレート制限がある）ため、ここで一度確認を取る。

---

## PHASE 5：SSL証明書の取得

```bash
sudo certbot --nginx -d admin.cheerstick.com
```

既存3ドメインと同じ `nginx` プラグイン方式で揃える。
**既存の証明書に統合しようとしないこと**（`--expand` 等は使わない）。
`admin` 単独の証明書として新規取得する。

### 5-1. 取得後に必ず確認すること

Certbotは `cheerstick-admin` ファイルを自動で書き換える。以下を確認する。

```bash
sudo cat /etc/nginx/sites-available/cheerstick-admin
```

- `listen 443 ssl` のブロックが追加されていること
- **その443ブロック内の `location /` に `allow` / `deny` が保持されていること**
  （消えていた場合は手動で書き戻し、`nginx -t` → `reload`）
- 80→443のリダイレクトブロックが追加されていること

```bash
sudo certbot certificates
```

`admin.cheerstick.com` が一覧に追加され、有効期限が約90日後になっていること。

---

## PHASE 6：動作確認

### 6-1. HTTPS疎通

```bash
curl -sI https://admin.cheerstick.com/
```

`200` が返ること。

### 6-2. IP制限が効いていることの確認

**VPNを切断した状態、またはスマートフォンのテザリング等、別経路から**
`https://admin.cheerstick.com/` へアクセスし、**403** が返ることを確認する。

> これはKMT様に実施いただく項目。**確認できるまでは、管理画面のURLを
> 誰にも共有しないこと。** 認証がないため、IP制限が唯一の防御である。

### 6-3. 【最重要】CORSの確認

VPN接続下のブラウザで `https://admin.cheerstick.com/` を開き、
**開発者ツールのConsoleとNetworkタブを開いた状態で**確認する。

- 試合一覧・団体一覧が表示されること
- ConsoleにCORSエラー（`blocked by CORS policy` 等）が出ていないこと
- Networkタブで `api.cheerstick.com` へのリクエストが `200` であること

> **CORSエラーが出た場合：** `.env` の `ALLOWED_ORIGINS` を再確認する
> （カンマ後のスペース混入が最も疑わしい）。修正後は `pm2 restart` が必要。

### 6-4. 一般APIの再確認

管理画面の追加が既存経路に影響していないことを、**もう一度**確認する。

```bash
curl -sI "https://api.cheerstick.com/api/v1/webview/geturl?id=<テスト用MAC>"
curl -sI "https://app.cheerstick.com/index.html"
```

`app.cheerstick.com` については、**VPNを切った状態でも**ブラウザで
表示できることをKMT様に確認いただく（エンドユーザーと同じ経路での確認）。

### 6-5. 管理画面の書き込み動作確認

> **テストデータを作らないこと。** 現在DELETEエンドポイントが存在せず、
> 登録した試合は画面から削除できない（`docs/spec.md` 既知の課題6）。

**KMT様が、本番用の初回試合データを実際に登録する**ことをもって
書き込み動作の確認とする。KMT様の判断（2026-07-31）。

登録後、以下を確認する。

- 一覧に反映されること
- `status` の切替（`live` → `paused` → `live` → `finished`）が動作すること
- 日時が正しく往復すること（`datetime-local` ⇔ `TIMESTAMPTZ`、JSTのずれ）
- 2件目を `live` にしようとすると409で拒否され、内容がアラート表示されること

> **WebSocketによる自動更新は起きない。** `broadcast()` は定義済みだが
> 呼び出し箇所がゼロである。画面が自動更新されなくても不具合ではない。
> **これをバグとして報告しないこと。**

---

## PHASE 7：記録

`/handover` を実行し、以下を反映する。

1. `docs/worklog.md` — 本日の作業結果（PHASE 1〜6の実施内容と結果）
2. `docs/runbook.md` — 以下を追記
   - `admin.cheerstick.com` の構成（配信元 `/var/www/cheerstick-admin/`、
     IP制限は `location /` 内、証明書はCertbot nginx プラグイン）
   - **静的ファイル2箇所問題が管理画面にも適用される旨**
     （`public/admin/index.html` 変更時は再コピーが必要）
   - `.env` に `ALLOW_PRODUCTION_DB` と `ALLOWED_ORIGINS` の記述がある旨
3. `docs/spec.md` — 既知の課題7（静的ファイル2箇所問題）に管理画面を追記
4. `docs/proposals/production-deploy-plan.md` — 実施済みである旨を追記
5. `docs/tasks/2026-07-31-planB-deploy.md`（本ファイル）— 末尾に実施結果を追記
6. コミット・**push まで行う**（未pushのまま終わらない）

---

## 5. ロールバック手順

### PHASE 1で失敗した場合（本番が起動しない等）

```bash
cd /home/ubuntu/cheerstick-server-new
git log --oneline -3          # 現在位置の確認
git reset --hard fc2c21b      # 反映前のコミットへ戻す
pm2 restart cheerstick-server
pm2 logs cheerstick-server --lines 40 --nostream
```

`.env` に追記した `ALLOW_PRODUCTION_DB=true` と `ALLOWED_ORIGINS` の変更は、
**戻さなくてよい。** ガードのコードが無い状態では単に無視される環境変数となる。

復旧後、一般API（geturl / app / ws）の疎通を確認すること。

### PHASE 4・5で失敗した場合

管理画面の設定のみを無効化する。既存3ドメインには影響しない。

```bash
sudo rm /etc/nginx/sites-enabled/cheerstick-admin
sudo nginx -t
sudo systemctl reload nginx
```

`/var/www/cheerstick-admin/` は残しておいてよい（配信されなくなるだけ）。

### バックアップの所在（本日取得済み）

```
~/backups/cheerstick_production_20260731.sql       本番DB
~/backups/cheerstick-app_20260731/                 /var/www/cheerstick-app/
```

---

## 6. 想定所要時間と、詰まりやすい箇所

| PHASE | 目安 | 詰まりやすい点 |
|---|---|---|
| 1 | 15分 | `.env` の順序ミス、`npm ci` の要否 |
| 2 | 5〜10分 | DNS伝播待ち |
| 3 | 5分 | パーミッション |
| 4 | 10分 | **IP制限の記述位置**（4-2参照） |
| 5 | 5分 | DNS未伝播での実行失敗 |
| 6 | 20分 | **CORS**（`ALLOWED_ORIGINS` のスペース混入） |

最も失敗しやすいのは PHASE 6 のCORSだが、原因はほぼ `.env` の記述に限られる。
`pm2 restart` を伴う修正になる点だけ留意すること。

---

## 実施結果（2026-07-31、Claude Code実施）

**PHASE 1〜6のうち、6-5のみ未実施。** 各PHASEの停止ポイントでユーザー（KMT様）へ
報告し、指示を得てから次PHASEへ進む形で実施した。詳細は`docs/worklog.md`
2026-07-31エントリ「案B本番反映（PHASE 1〜6、6-5を除く）」を参照。

### 実施済み

- **PHASE 1**：`.env`編集（`ALLOW_PRODUCTION_DB=true`追記、`ALLOWED_ORIGINS`に
  `https://admin.cheerstick.com`追加）→ 確認 → `git pull`（`fc2c21b`→`70683f4`）→
  `npm ci`不要と判断 → `pm2 restart`（`online`、`productionGuard`ブロック無し）→
  一般API疎通確認（api/app 200、ws 101）。すべて想定通り
- **PHASE 2**：DNS伝播確認のみ実施（レコード追加はKMT様がRoute53で実施済み）。
  `dig A admin.cheerstick.com +short`→`52.196.49.126`を確認
- **PHASE 3**：`/var/www/cheerstick-admin/`新設、`index.html`配置。**所有者は
  手順書指定の`www-data:www-data`ではなく`ubuntu:ubuntu`を採用**（既存
  `/var/www/cheerstick-app/`の実際の所有者に合わせた。手順書4章の分岐指示どおり）
- **PHASE 4**：`/etc/nginx/sites-available/cheerstick-admin`新規作成、IP制限を
  `location /`内側に配置、`nginx -t`→`reload`。ローカル(VPN)から200、EC2自身から
  403を確認しIP制限の実効性を実証
- **PHASE 5**：`sudo certbot --nginx -d admin.cheerstick.com --non-interactive`で
  単独証明書を新規取得（`--expand`未使用）。5-1確認：443 sslブロック追加・
  IP制限保持・80→443リダイレクト追加、いずれも手動修正不要で想定通り。
  有効期限2026-10-29
- **PHASE 6**：6-1（HTTPS疎通200 OK）・6-4（一般API再確認、影響なし）を実施。
  6-2はPHASE 4で実証済みとしてスキップ。6-3（CORS、ブラウザでのConsole確認）は
  KMT様が別途実施する方針とし未実施（代わりにCORSプリフライトを`curl`の
  `OPTIONS`メソッドでPOST/PATCH双方確認し、`204`・許可ヘッダともに正常と確認済み）

### 未実施：PHASE 6-5（管理画面の書き込み動作確認）

手順書は「KMT様が本番用の初回試合データを実際に登録することをもって書き込み動作の
確認とする」としていたが、実施の直前に以下のリスクが判明したため見送った。

- 試合の`status`を`finished`にすると、管理画面の操作ボタンが消えて元に戻せない
  （`actionButtonsFor()`の実装上、`finished`からの遷移先ボタンが存在しない）
- 現時点でDELETEエンドポイントが未実装（`docs/proposals/admin-delete-endpoint.md`、
  `docs/spec.md`既知の課題11.3）であり、一度登録・進行させた試合データを
  本番から除去する手段が無い
- 上記2点により、本番用の初回試合データを誤って操作した場合、**8/9当日まで
  復旧不能な状態で一覧に残り続けるリスクがある**と判断

**決定（KMT様判断、2026-07-31）：** 8/9に向けた本番用試合データの登録は、
DELETE機能の実装・本番反映が完了するまで行わない。DELETE機能は`docs/spec.md`
既知の課題11.3の追記のとおり、「余裕があれば対応する」改善項目ではなく、
**8/9試合に向けた前提条件**に格上げされた。

### 次に必要な作業

1. DELETE機能の実装（`docs/proposals/admin-delete-endpoint.md`）
   - 着手前に`cheer_logs`→`events`の外部キー制約`confdeltype`をstaging環境で確認
   - staging環境で実装・検証後、単独デプロイとして本番反映
2. DELETE機能の本番反映後、PHASE 6-5相当の書き込み動作確認
   （本番用初回試合データの登録、status遷移、日時往復、409競合表示）を改めて実施
3. PHASE 6-3（CORSのブラウザ実地確認）はKMT様の実施結果待ち
