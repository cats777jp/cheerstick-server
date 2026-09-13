# CheerStick Runbook（環境・接続情報・手順）

最終更新：2026-09-06（cheerstick-api削除、pm2 startup設定・reboot対応を反映）

---

## 本番環境

```
EC2インスタンス : i-04576698e7325bddb
パブリックIP    : 52.196.49.126（Elastic IP、2026-07-25割当。Nameタグ: cheerstick-production）
                  ※旧IP 18.179.62.192 は割当解除済み。再起動でもIP不変を確認済み
SSH             : ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126
```

**SSH秘密鍵（`.pem`）はリポジトリ内に置かない。** 正本は `C:\AWS\cheerstick-key\` に保管する（2026-07-27、誤ってリポジトリ直下に置かれていたため`.gitignore`に`*.pem`/`*.key`を追加）。

### GitHub連携（Deploy Key・2026-07-27対応）

**リポジトリは Private。Public へ戻さない。**

GitHubリポジトリ `cats777jp/cheerstick-server` を Private 化したことで、本番EC2からの
`git pull`（HTTPS・認証情報なし）が認証エラーになった。そのため本番EC2専用の
**Deploy Key（読み取り専用、SSH）** を発行し、これ経由で `pull` する構成にした。

```
鍵の場所（EC2上）  : ~/.ssh/github_deploy_key（秘密鍵）/ ~/.ssh/github_deploy_key.pub（公開鍵）
GitHub側の登録先   : リポジトリ Settings → Deploy keys
                     "Allow write access" は必ずオフ（読み取り専用）
リモートURL        : git@github.com:cats777jp/cheerstick-server.git（HTTPSから変更済み）
```

`~/.ssh/config`（EC2上）:

```
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/github_deploy_key
    IdentitiesOnly yes
```

**`cheerstick-key.pem`（AWS EC2接続用）とは別物。** 混同しないこと。秘密鍵の内容は
本ドキュメントに記載しない。

疎通確認：

```bash
ssh -T git@github.com   # "Hi cats777jp/cheerstick-server! ...shell access..." が出れば正常
                         # 終了コード1は仕様（shellを提供しないため）。失敗ではない
git fetch origin
```

#### 鍵を再発行する場合

1. EC2上で新しい鍵ペアを生成する（既存ファイルを上書きしないよう別名にするか、
   事前に `~/.ssh/github_deploy_key*` をバックアップする）
   ```bash
   ssh-keygen -t ed25519 -C "cheerstick-production-deploy-key" -f ~/.ssh/github_deploy_key -N ""
   ```
2. `cat ~/.ssh/github_deploy_key.pub` の内容をGitHub Deploy keysへ登録
   （新規追加でよい。旧鍵は登録解除してから削除する）
3. `~/.ssh/config` の `IdentityFile` が新しい鍵を指していることを確認
4. `ssh -T git@github.com` → `git fetch origin` で疎通確認

### 稼働プロセス

```
nginx                 80/443、api/app/ws すべてのリバースプロキシ
cheerstick-server     pm2 online、ポート3000、REST API + WebSocket 統合プロセス
                      稼働ディレクトリ: /home/ubuntu/cheerstick-server-new（git管理下）
```

> 2026-09-06、`cheerstick-api`（pm2 stopped、7/21作成の旧プロトタイプ）を削除。
> `.envなし・DBアクセスなし・依存関係なし`を確認の上、`pm2 delete` → `pm2 save`、
> `/home/ubuntu/cheerstick-api`ディレクトリごと削除した（コード変更なし、サーバー側作業のみ）。

### ドメイン・SSL

| ドメイン | 状態 | 証明書有効期限 |
|---|---|---|
| api.cheerstick.com | 稼働中 | 2026-10-19 |
| app.cheerstick.com | 稼働中 | 2026-10-19 |
| ws.cheerstick.com | 稼働中 | 2026-10-19 |
| admin.cheerstick.com | **稼働中（2026-07-31、案B本番反映により新設）** | 2026-10-29 |

> 2026-07-31、`admin.cheerstick.com`を「未設定（Grafana等用、優先度低）」から更新。
> 管理画面（試合管理）配信用として本番反映されたため（旧記述のGrafana用途とは異なる）。
> 詳細は下記「管理画面 admin.cheerstick.com（案B）」節を参照。

Route53 Aレコードは4本とも上記パブリックIPを直接指す。TTL 300。

### データベース

```
PostgreSQL（EC2上に直接インストール、RDS不使用）
DB   : cheerstick_production
User : cheerstick
```

### 環境変数（.env）

```
ALLOWED_ORIGINS=https://app.cheerstick.com,https://admin.cheerstick.com
                                              # 2026-07-31、admin.cheerstick.com追加
                                              # （案B本番反映。ワイルドカード許可は解消済み）
ENABLE_REFERENCE_TOKEN=false                 # 署名付きトークン、現在無効化中
ALLOW_PRODUCTION_DB=true                     # 2026-07-31追加。本番誤接続ガード
                                              # （src/db/productionGuard.js）が要求する変数。
                                              # 未設定のまま起動するとprocess.exit(1)する
```

編集前のバックアップ：`.env.bak_20260731`（EC2上、`/home/ubuntu/cheerstick-server-new/`）

---

## ローカル環境（Windows 11 Pro）

```
作業フォルダ     : C:\Projects\cheerstick-server
Node.js          : v26.3.0
SSH鍵            : C:\AWS\cheerstick-key\cheerstick-key.pem
Claude Code起動  : cd C:\Projects\cheerstick-server → claude
リポジトリ       : cats777jp/cheerstick-server（Private）
ブランチ         : feature/reference-data
```

---

## デプロイ手順

### ⚠️ 静的ファイルは2箇所ある（2026-07-31、管理画面にも適用されることを確認）

```
/home/ubuntu/cheerstick-server-new/public/index.html         （git管理下）
/var/www/cheerstick-app/index.html                            （nginxが実際に配信）

/home/ubuntu/cheerstick-server-new/public/admin/index.html    （git管理下）
/var/www/cheerstick-admin/index.html                           （nginxが実際に配信、2026-07-31新設）
```

**`git checkout` だけでは後者に反映されない。** 過去にこの見落としでデプロイ漏れ発生済み。
2026-07-31の案B本番反映で管理画面用ディレクトリ（`/var/www/cheerstick-admin/`）を新設したため、
**同じ問題が管理画面にも当てはまる。** 今後 `public/admin/index.html` を変更した際は、
`/var/www/cheerstick-admin/` への再コピーを忘れないこと。

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
sudo cp public/index.html /var/www/cheerstick-app/index.html   # ← 忘れやすい
sudo cp public/admin/index.html /var/www/cheerstick-admin/     # ← 2026-07-31追加。同様に忘れやすい
pm2 restart cheerstick-server
```

**恒久対応（未実施）**：nginx の root を `cheerstick-server-new/public/` に統一するか、
デプロイスクリプトでコピーを自動化する。

### ⚠️ 管理画面は5ファイル構成になった（2026-09-13追記・未反映）

**理由：** `public/admin/index.html`（試合管理・チーム管理・デバイス管理が同居する
単一ファイル）を、ランチャー方式（index.html／events.html／masters.html／common.css／
common.js の5ファイル）へ再構成した（`docs/spec.md` 9.5章参照）。**本項目は
2026-09-13時点でローカル確認のみであり、本番デプロイは未実施。** 実際にデプロイする際は、
上記の単一ファイルcp（`sudo cp public/admin/index.html /var/www/cheerstick-admin/`）では
新設した4ファイルがコピーされず、旧デプロイ漏れ事故と同じ問題が再発する。デプロイ時は
以下の5ファイルすべてを対象にすること。

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
sudo cp public/admin/index.html    /var/www/cheerstick-admin/
sudo cp public/admin/events.html   /var/www/cheerstick-admin/
sudo cp public/admin/masters.html  /var/www/cheerstick-admin/
sudo cp public/admin/common.css    /var/www/cheerstick-admin/
sudo cp public/admin/common.js     /var/www/cheerstick-admin/
pm2 restart cheerstick-server
```

反映確認は下記「★必須：コピー後は『反映されたこと』をdiffで確認する」の方針に倣い、
5ファイルすべてに対して`diff`を実行してから完了とすること。

### ★必須：コピー後は「反映されたこと」を diff で確認する（2026-08-18追記）

**理由：** 上記の`cp`手順自体は以前から存在していたが、2026-07-31の管理画面DELETE機能
（削除ボタン）の本番反映時にこの`cp`が実施されず、`public/admin/index.html`を
`/var/www/cheerstick-admin/`へコピーする工程が丸ごと欠落した。同様に、2026-07-28の
`public/index.html`（ネイティブアプリ向けJSブリッジ実装）も`/var/www/cheerstick-app/`へ
未反映のまま21日間放置されていた。いずれも2026-08-18の調査で発覚し、同日中に手動で反映した
（`docs/worklog.md`2026-08-18エントリ参照）。**「`cp`コマンドを手順書に書く」だけでは
再発する**（今回も手順自体は既に書かれていたのに実行されなかった）。「反映したこと」ではなく
**「反映されたこと」を毎回確認する行**を手順に加える。

```bash
# cp の直後に必ず実行し、両方とも「差分なし」であることを確認する
diff /var/www/cheerstick-admin/index.html /home/ubuntu/cheerstick-server-new/public/admin/index.html && echo "admin: OK"
diff /var/www/cheerstick-app/index.html   /home/ubuntu/cheerstick-server-new/public/index.html        && echo "app: OK"
```

**差分が出た場合、反映は完了していない。** コード変更を伴うデプロイでは、`pm2 restart`の
前後どちらでもよいが、必ず`cp`の直後にこの`diff`を実行すること。

### 画像・素材の反映（2026-07-27対応：assets/images/ 新設に伴う追加）

**`assets/images/` が正本。** 配信先 `/var/www/cheerstick-app/images/` へは
必ずここからコピーすること。**直接 `scp` 等で配信先へ配置しないこと。**
（正本を経由しない配置を続けると、`assets/images/` との内容乖離が発生し、
`git pull` しても配信内容が更新されない状態に陥る）

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
sudo cp -r assets/images/. /var/www/cheerstick-app/images/
```

新しい画像を追加する場合も同様に、まずローカルで `assets/images/` 配下へ
配置してコミット・pushし、本番では上記コマンドで反映する。

### 環境変数を変更した場合

```bash
pm2 restart cheerstick-server --update-env
```

---

## Elastic IP 割当（対応済み・2026-07-25）

```
1. EC2コンソールで Elastic IP 52.196.49.126 を新規割当
2. インスタンス i-04576698e7325bddb へ関連付け（Nameタグ: cheerstick-production）
3. Route53 の api / app / ws レコードを新IPへ更新（admin は未設定のため対象外）
4. DNS反映後、疎通確認
5. インスタンス再起動テストでIP不変を確認、pm2の自動復帰も確認
   （このタイミングでカーネルが 6.17.0-1017-aws → 6.17.0-1019-aws に更新された）
```

> **2026-09-06追記（矛盾の記録）：** 上記5.の「pm2の自動復帰も確認」について、
> 2026-09-06のカーネル更新対応（1009→1012）の際に**`pm2 startup`（systemd登録）が
> 未設定であることが判明し、reboot前に初めて設定した。** つまり2026-07-25時点では
> systemd経由の自動復帰は構成されていなかったはずで、上記5.の記載と矛盾する。
> 7/25時点で実際に何が起きていたか（手動での`pm2 resurrect`／`pm2 start`だったのか、
> 確認自体が誤りだったのか）は今回追跡していない。**2026-09-06以降はsystemd経由の
> 自動復帰が正しく構成されている**（reboot実施・`cheerstick-server`自動復帰・
> admin.cheerstick.com正常表示を確認済み）。

---

## 管理API アクセス制限（nginx IPアドレス制限・2026-07-25対応）

`PATCH /api/v1/admin/events/:id/status` はアプリケーションレベルの認証を持たないため、
nginx側で `/api/v1/admin/` パスへのアクセス元IPを制限している。

```
設定ファイル : /etc/nginx/sites-available/cheerstick-api（api.cheerstick.com）
設定箇所     : server { ... } 内、location / より前の location /api/v1/admin/ ブロック
許可IP       : 49.156.217.121（KMT様オフィス固定IP。VPN経由時も同一IPで到達する構成）
```

```nginx
location /api/v1/admin/ {
    allow 49.156.217.121;
    deny  all;

    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}
```

`/api/v1/webview/`・WebSocket・`app.cheerstick.com` には一切影響しない
（`location /api/v1/admin/` のみに限定されるため）。

### オフィスのIPアドレスが変わった場合

```bash
sudo cp -a /etc/nginx/sites-available /etc/nginx/sites-available.bak_$(date +%Y%m%d_%H%M%S)
sudo vi /etc/nginx/sites-available/cheerstick-api   # allow 行のIPを書き換え
sudo nginx -t                                        # 必ず成功を確認
sudo systemctl reload nginx
```

`nginx -t` が失敗した場合は reload せず、バックアップから復旧すること。

### 運用上の注意

- 現在の運用者はKMT様お一人のみを前提とした暫定対応。複数人での運用や
  外部からの操作が必要になった時点で、Basic認証や正式なログイン機構への
  移行を検討する（`docs/spec.md` 8章参照）
- 動作確認時、EC2上のcurlは許可IPに含まれないため `403` が返るのが正常。
  実際の疎通確認はKMT様のオフィス（またはVPN経由）から行うこと

---

## 管理画面 admin.cheerstick.com（案B、2026-07-31本番反映）

`docs/tasks/2026-07-31-planB-deploy.md`（PHASE 1〜6）に従い本番反映済み。

```
配信元       : /var/www/cheerstick-admin/（新設。git管理下の原本は public/admin/index.html）
               ※2026-09-13、原本をindex.html／events.html／masters.html／common.css／
               common.jsの5ファイルへ再構成（上記「管理画面は5ファイル構成になった」参照）。
               本項の所有者・nginx設定・IP制限の記載自体（ディレクトリ単位の設定）は
               ファイル分割の影響を受けないため変更していない
所有者       : ubuntu:ubuntu（手順書は www-data:www-data を想定していたが、
               既存の /var/www/cheerstick-app/ が ubuntu:ubuntu だったため、
               それに合わせた。ディレクトリ755、index.html 664）
nginx設定    : /etc/nginx/sites-available/cheerstick-admin（新規ファイル。
               既存の cheerstick-api / cheerstick-app / cheerstick-ws は無変更）
IP制限       : location / の内側に allow 49.156.217.121; deny all;
               （serverブロック直下に書くと、Certbotのnginxプラグインが
               証明書更新時に挿入する一時locationにも継承され、
               初回発行・90日ごとの自動更新の両方が失敗するため）
証明書       : Certbot nginxプラグイン方式（既存3ドメインと同じ）。
               admin.cheerstick.com単独の証明書として新規取得（--expand未使用）。
               有効期限 2026-10-29（他3ドメインとは取得日が異なるため個別）
API呼び出し  : 絶対URL方式（https://api.cheerstick.com/api/v1/admin）。
               admin.cheerstick.com自体は静的HTMLの配信のみで、
               api.cheerstick.comへのプロキシは作成していない
               （作ると api.cheerstick.com 側のIP制限を迂回する経路になるため）
```

CORS対応：本番`.env`の`ALLOWED_ORIGINS`に`https://admin.cheerstick.com`を追加済み
（上記「環境変数（.env）」参照）。2026-07-31、`OPTIONS`によるCORSプリフライトを
POST/PATCHの両方で確認済み（`204`、`Access-Control-Allow-Origin: https://admin.cheerstick.com`、
`Access-Control-Allow-Methods`に`POST`/`PATCH`/`DELETE`含む）。ブラウザでの実地確認
（Consoleエラー無し等）はKMT様が別途実施。

---

## デバイス所有者リセット手順（2026-07-25対応：TOFU方式の上書き防止に伴う追加）

`register`（WebSocket）は2026-07-25よりTOFU方式に変更され、一度所有者が設定された
デバイスは別ユーザーが登録できない（`DEVICE_ALREADY_REGISTERED` エラーで拒否）。
以下のケースでは所有者を手動でリセットする必要がある。

- 出荷検査時に誤って登録してしまった場合
- 中古・譲渡でデバイスの持ち主が変わる場合
- ユーザーがメールアドレスを変更した場合

**本番DBを直接変更するため、必ず対象をSELECTで確認してから実行すること。**

```sql
-- 1. 対象デバイスの現在の所有者を確認（本人確認とセットで）
SELECT d.mac_address, d.owner_user_id, u.email, u.display_name, d.registered_at
FROM devices d
LEFT JOIN users u ON u.id = d.owner_user_id
WHERE d.mac_address = '<MACアドレス>';

-- 2. 確認後、所有者をリセット（本人確認のうえ、手動で実行すること）
UPDATE devices SET owner_user_id = NULL, registered_at = NULL
 WHERE mac_address = '<MACアドレス>';
```

リセット後は当該デバイスが`register`時に「未登録」として扱われ、次に`register`した
ユーザーが新たな所有者として確定する。

---

## staging環境（cheerstick_staging）マイグレーション適用時の注意（2026-07-31追加）

理由：`migrations/010_add_events_hidden_at.sql`の適用時に発生した問題と対処法を、
本番マイグレーション時の再発に備えて記録する。

staging構築時（2026-07-30）、`cheerstick_staging`内の全テーブルの所有者が
`cheerstick_stg`ではなく`cheerstick`のままになっている（構築時はGRANTのみ実施し、
所有権の移譲はしていなかったため）。このため、アプリのDB接続ロール
（`cheerstick_stg`、`.env`の`DATABASE_URL`が使用）で`node src/db/migrate.js`を実行し、
既存テーブルに`ALTER TABLE`を伴うマイグレーション（列追加等）を適用しようとすると、
以下のエラーで失敗する。**PostgreSQLの`GRANT`は`ALTER TABLE`のようなDDL権限を
付与できず、テーブル所有権（またはスーパーユーザー権限）が必要なため。**

```
Migration failed: Failed on 0NN_xxx.sql: must be owner of table <table>
```

### 対処法

対象テーブルの所有者を`cheerstick_stg`へ変更してからマイグレーションを再実行する。
**対象テーブルのみを指定すること（全テーブル一括の所有者変更は行わない）。**

```bash
# 実行前に必ずDB名を確認する（本番へ誤実行しないため）
ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126 \
  "sudo -u postgres psql -d cheerstick_staging -c 'SELECT current_database();'"

# cheerstick_staging であることを確認したうえで実行
ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126 \
  "sudo -u postgres psql -d cheerstick_staging -c 'ALTER TABLE <対象テーブル> OWNER TO cheerstick_stg;'"
```

その後、ローカルから`node src/db/migrate.js`（`.env`が`cheerstick_staging`を
指している状態）を再実行する。

### 2026-07-31の実施内容（`migrations/010_add_events_hidden_at.sql`適用時）

- 実行したSQL：`ALTER TABLE events OWNER TO cheerstick_stg;`
- 変更前の所有者：`cheerstick`
- 変更後の所有者：`cheerstick_stg`
- 対象：**`events`テーブルのみ。** 他13テーブル（`awards`／`categories`／`cheer_logs`／
  `cheer_summaries`／`device_event_sessions`／`devices`／`organizations`／
  `schema_migrations`／`targets`／`user_target_follows`／`users`／`venues`）は
  所有者を変更していない（すべて`cheerstick`のまま）。2026-07-31、
  `SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public'`で
  全14テーブルを確認し、`events`以外に変更が無いことを確認済み

### 今後の再発について

この問題は、`ALTER TABLE`を伴う新しいマイグレーションを既存テーブルに適用する
たびに再発する可能性が高い（対象テーブルの所有者をその都度変更する必要がある）。
恒久対応（staging構築時に全テーブルの所有者を`cheerstick_stg`へ揃える、または
`GRANT`ではなく所有権ごと移譲する運用に変更する等）は**未実施。** 次に発生した場合、
都度上記の個別`ALTER TABLE ... OWNER TO`で対応するか、恒久対応に切り替えるかは
KMT様と相談のうえ判断する。

**本番環境（`cheerstick_production`）には無関係。** 本番の`cheerstick`ロールは
元々全テーブルの所有者であり、この問題は発生しない。

---

## デモ用デバイスの登録（審査・デモンストレーション用、is_demo方式・未実行）

`migrations/009_add_device_is_demo.sql`（2026-07-27作成、本番未適用）で`devices.is_demo`列を
追加した後、以下のSQLでデモ用デバイスを1件投入する想定。デモ用デバイスも本番デバイスと
同様に通常どおりDBへ状態を保持し、書き込み処理は本番デバイスと同一。`is_demo`は応援量の
集計・ランキング・ダッシュボードから除外するための目印としてのみ使う（`docs/spec.md`参照）。

category_idは本番の`categories`テーブルから確認済み（2026-07-27、SELECTのみ実行）。

```sql
-- category_id確認（実行済み）
SELECT id, name FROM categories ORDER BY name;
--                  id                  |  name
-- --------------------------------------+---------
--  10000000-0000-0000-0000-000000000001 | Jリーグ

-- デモ用デバイス登録（2026-07-27時点で未実行。009適用後に実行すること）
-- MACアドレスは2026-07-27にDE:M0:00:00:00:01からDE:AD:BE:EF:00:01へ変更済み
-- （"M0"は16進数として不正なため、MAC形式バリデーションで弾かれる懸念を回避。
-- DE:AD:BE:EF:00:01はローカル管理アドレスで実機と衝突しない）
INSERT INTO devices (mac_address, category_id, is_demo, owner_user_id)
VALUES (
  'DE:AD:BE:EF:00:01',
  '10000000-0000-0000-0000-000000000001',  -- categories.id = Jリーグ
  true,
  NULL
);
```

---

## 確認コマンド集

```bash
# プロセス状態
pm2 list
pm2 logs cheerstick-server --lines 50

# nginx
sudo nginx -t
sudo systemctl status nginx

# DB接続
psql -U cheerstick -d cheerstick_production

# git整合（ローカル・GitHub・本番の3者が一致していること）
git log --oneline -1
```

---

## 未確認・保留中のファイル

- `cheerstick-ws`：**2026-07-31、内容確認済み。** nginx設定の下書きであることを確認した。
  EC2上の`/etc/nginx/sites-enabled/cheerstick-ws`とdiffを取ったところ、Certbot自動追記分
  （443 ssl設定・80→443リダイレクトブロック）を除いて内容が一致。ローカル側は
  Certbot適用前の下書きとして残置されたものと判断できる（実害なし、削除も不要）。
