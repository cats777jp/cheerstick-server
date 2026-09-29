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

### nginx本体設定（`/etc/nginx/nginx.conf`、2026-09-27変更）

```
worker_connections 768;   → worker_connections 8192;      （eventsブロック内）
（未設定）                 → worker_rlimit_nofile 32768;   （mainコンテキスト、worker_processesの直後に追加）
```

- **変更日**：2026-09-27
- **理由**：2026-09-21の負荷試験で、既定値`worker_connections 768;`では約764接続で
  頭打ちになることが判明した（WebSocketのプロキシは1クライアントにつきクライアント側・
  アップストリーム側の2ソケットを消費するため）。同試験でm5.large・`8192`/`32768`の
  組み合わせにより4,000接続まで動作確認済みの値を、そのまま本番へ適用した。
  応援合戦デモ環境（WebARENA VPSから`wss://ws.cheerstick.com/cheer`経由、各500台×2＝1,000接続）
  への対応が直接のきっかけ。v16から持ち越しだった「nginx worker_connectionsの本番反映」課題の解消。
- **本番インスタンスタイプ（t3.micro）・`sites-available`/`sites-enabled`配下の各サイト設定
  （cheerstick-api／-app／-ws／-admin）は変更していない。** `nginx.conf`本体の2点のみが対象。
- **バックアップ**：`/etc/nginx/nginx.conf.bak_20260927_014832`（EC2上）
- 反映方法は`systemctl reload`（`restart`は未使用。既存接続を切断しない）
- 反映確認：nginx worker open files上限が32768になったこと、`nginx -t`成功、
  `app.cheerstick.com`・`api.cheerstick.com`双方への疎通が200であることを確認済み

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

### レート制限関連の環境変数（大規模イベント対応トラックA、2026-09-28新設）

`docs/spec.md` 12章参照。**いずれも未設定で動作する（下記が既定値）。** イベント直前に
値を変えたい場合のみ`.env`へ追記し、`pm2 restart --update-env`で反映する。

```
RL_WINDOW_MS=900000          # 全リミッター共通の時間枠（ミリ秒、15分）
RL_AUDIENCE_IP_MAX=50000     # 観客の入口（geturl/reference）：IPごとの上限
RL_DEVICE_MAX=60             # 観客の入口：デバイス（MAC）ごとの上限
RL_SCORE_IP_MAX=6000         # スコア・閲覧系（会場スクリーン用API）：IPごとの上限
RL_ADMIN_IP_MAX=20000        # 管理API：IPごとの上限（暴走検知用。nginxのIP制限は別途有効）
RL_DEFAULT_IP_MAX=500        # それ以外の/api/v1と/health：IPごとの上限（従来どおり）
SCORE_CACHE_TTL_MS=1000      # スコア・閲覧系のサーバー側キャッシュ有効期間（ミリ秒）。0で無効
```

数値でない・負の値を設定した場合、該当項目のみ既定値に戻り、起動ログに警告が出る
（他の項目には影響しない）。反映確認は`pm2 logs`の`[rate-limit] config: ...`行で行う。

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

**追記（2026-09-13、public直下の公開ページが増えたことに伴う注記）：** `public/`直下には
`index.html`の他に`battle.html`（2026-09-11新設）・`target-report.html`（2026-09-13新設）が
あり、いずれも`/var/www/cheerstick-app/`配下へ個別に`cp`する必要がある
（`docs/spec.md` 9.4・9.7章参照）。上記の基本コマンド例は`index.html`のみだが、これらの
ページに変更・新規追加があった場合は同様に`sudo cp public/<ファイル名>
/var/www/cheerstick-app/`を追加すること。

**追記（2026-09-24、順位確定機能Phase 4本番反映）：** `ranking-user.html`・
`ranking-target.html`（`public/`直下）を同様に`/var/www/cheerstick-app/`へ追加した。
あわせて`public/admin/ranking-control.html`を`/var/www/cheerstick-admin/`へ追加した
（`docs/spec.md` 9.11章参照）。理由：この3ファイルは新規ファイルのため、上記
「★必須：新規ファイルをコピーした場合は所有者も確認する」の`chown ubuntu:ubuntu`・
`chmod 664`をあわせて実施した。

**恒久対応（未実施）**：nginx の root を `cheerstick-server-new/public/` に統一するか、
デプロイスクリプトでコピーを自動化する。

### ⚠️ 管理画面は6ファイル構成になった（2026-09-13追記・同日本番反映済み）

**理由：** `public/admin/index.html`（試合管理・チーム管理・デバイス管理が同居する
単一ファイル）を、ランチャー方式（index.html／events.html／masters.html／common.css／
common.js の5ファイル）へ再構成した（`docs/spec.md` 9.5章参照）。同日中に選手・推し対象
管理画面`targets.html`（`docs/spec.md` 9.6章）を追加し、6ファイル構成になった。
単一ファイルcp（`sudo cp public/admin/index.html /var/www/cheerstick-admin/`）だけでは
新設した5ファイルがコピーされず、旧デプロイ漏れ事故と同じ問題が再発するため、
デプロイ時は以下の6ファイルすべてを対象にすること。

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
sudo cp public/admin/index.html    /var/www/cheerstick-admin/
sudo cp public/admin/events.html   /var/www/cheerstick-admin/
sudo cp public/admin/masters.html  /var/www/cheerstick-admin/
sudo cp public/admin/targets.html  /var/www/cheerstick-admin/
sudo cp public/admin/common.css    /var/www/cheerstick-admin/
sudo cp public/admin/common.js     /var/www/cheerstick-admin/
pm2 restart cheerstick-server
```

反映確認は下記「★必須：コピー後は『反映されたこと』をdiffで確認する」の方針に倣い、
6ファイルすべてに対して`diff`を実行してから完了とすること。**上記のうち
`events.html`・`masters.html`・`targets.html`・`common.css`・`common.js`の5ファイルは
今回`/var/www/cheerstick-admin/`に無かった新規ファイルにあたるため、下記
「★必須：新規ファイルをコピーした場合は所有者も確認する」の`chown`/`chmod`も
併せて必要。**

> **2026-09-13追記：本番デプロイ実施。** 上記6ファイルの本番反映・pm2再起動・疎通確認
> （既存API回帰、`targets.html`・`GET /admin/targets`の200応答）まで完了した。
> デプロイ時に新規5ファイルの所有者が`root:root`になる事象が発生し、`chown`/`chmod`で
> 対処した（下記「★必須：新規ファイルをコピーした場合は所有者も確認する」参照）。
> 詳細は`docs/worklog.md`2026-09-13エントリ
> （「管理画面ランチャー化」「選手データ管理UI・応援集計画面」の本番デプロイ）参照。

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

### ★必須：新規ファイルをコピーした場合は所有者も確認する（2026-09-13追記）

**理由：** `sudo cp`で**新規ファイル**（配信先にまだ存在しないファイル）をコピーすると、
コピー先での所有者が`root:root`になる（`sudo`で実行しているため）。これに対し、
**既存ファイルへの上書きコピーの場合は元の所有者・パーミッションがそのまま引き継がれる
ため、この問題は起きない（対象外）。** 新規ファイルのときだけ発生する事象である点に注意。

過去2回、この事象で新規ファイルが`ubuntu:ubuntu`（664、他の配信ファイルと同じ慣習）
ではなく`root:root`（644）のまま配置される事態が発生した：

- `battle.html`（2026-09-11、`docs/worklog.md`同日エントリ参照）
- `events.html`・`masters.html`・`targets.html`・`common.css`・`common.js`
  （2026-09-13、管理画面ランチャー化・選手データ管理UI本番デプロイ時、
  `docs/worklog.md`同日エントリ参照）

配信自体（nginxからの200応答）は所有者が`root:root`のままでも支障なく行えるが、
既存ファイルとの所有者不一致を放置すると、次回以降`ubuntu`ユーザーでの上書き操作
（`sudo`を付け忘れた`cp`等）に支障が出たり、運用上の一貫性が崩れたりするため、
**新規ファイルをコピーした場合は、その場で必ず所有者を既存ファイルに合わせて修正する
ことをデプロイ手順の一部とする。**

```bash
# 新規ファイル（配信先にまだ存在しなかったファイル）をコピーした場合のみ実行。
# 既存ファイルへの上書きコピーのみのデプロイでは不要（所有者は引き継がれるため対象外）。
sudo chown ubuntu:ubuntu <配信先の新規ファイルパス>
sudo chmod 664 <配信先の新規ファイルパス>

# 修正後、ディレクトリ内の既存ファイルと所有者・パーミッションが揃っていることを目視確認する
ls -la <配信先ディレクトリ>
```

複数ファイルをまとめてコピーした場合は、まとめて対象に含めてよい（例：
`sudo chown ubuntu:ubuntu file1 file2 file3 && sudo chmod 664 file1 file2 file3`）。
`diff`による内容確認（上記）とセットで、新規ファイルを含むデプロイでは
「内容が一致していること」と「所有者が揃っていること」の両方を確認してから完了とする。

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

### 画像アップロード機能の本番インフラ準備（改善3件フェーズ2、2026-09-16実施）

**理由：** 画像アップロード機能（`docs/spec.md` 8.8章）の新設に伴い、アプリケーション
コードの本番デプロイに先立って、本番インフラ側の準備（保存先ディレクトリ・
nginxのアップロードサイズ上限）のみを実施した。**コード本体（`src/`・`public/admin/`の
今回変更分）は今回デプロイしていない。** アプリが実際にこのディレクトリへ書き込みを
開始するのは、コード本体を本番反映した後になる。

**実施内容（2026-09-16）：**

1. pm2実行ユーザーの確認：`cheerstick-server`は`ubuntu`ユーザーで稼働しており、
   `/var/www/cheerstick-app/images/`の所有者も`ubuntu:ubuntu`（755）だったため、
   **追加の権限変更（chmod/chown）は不要だった**（pm2実行ユーザー＝ディレクトリ所有者の
   ため、755のままでも所有者は書き込み可能）
2. アップロード保存先ディレクトリを新規作成：
   ```bash
   mkdir -p /var/www/cheerstick-app/images/uploads
   ```
   （既存の`assets/images/`正本方式とは別の、運用中に随時追加されるアップロード画像専用の
   ディレクトリ。既存の「デプロイ時の注意」（index.html等が2箇所に分かれる問題）とは
   無関係。既存の画像・素材フロー〔上記〕とも独立している）
3. `/etc/nginx/sites-available/cheerstick-api`の`location /api/v1/admin/`ブロックへ
   `client_max_body_size 5m;`を追加（変更前に`sites-available`一式をバックアップ、
   `sudo nginx -t`で構文チェック成功を確認したうえで`systemctl reload nginx`を実施）。
   **`cheerstick-app`（app.cheerstick.com、静的ファイル配信のみ）ではなく`cheerstick-api`
   （api.cheerstick.com、Node appへのproxy）側に適用した**：
   `POST /api/v1/admin/uploads/image`は他の管理API（8.3章等）と同じくapi.cheerstick.com
   経由でNode appへ到達し、app.cheerstick.comは一切経由しないため
   （`cheerstick-app`は`root`＋`try_files`の静的配信のみで、Node appへのproxy設定を
   持たない構成であることを確認済み）

**次回コード本体を本番デプロイする際に必要な追加作業（未実施）：**
- 本番`.env`に`UPLOAD_DIR=/var/www/cheerstick-app/images/uploads`・
  `UPLOAD_URL_BASE=https://app.cheerstick.com/images/uploads`を追加
  （`.env.example`参照。未設定の場合ローカル開発用の既定値にフォールバックしてしまうため、
  本番では明示的な設定が必須）
- `npm install`（`multer`が新規依存として`package.json`に追加されているため）

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

**追記（2026-09-13、`CREATE TABLE`は対象外であることを確認）：** 本節の問題は
既存テーブルへの`ALTER TABLE`（所有者が`cheerstick`のまま変更されていないテーブルを
`cheerstick_stg`で書き換えようとする）に限った話であり、**新規テーブルを追加する
`CREATE TABLE`系マイグレーションには当てはまらない。** `cheerstick_stg`は`public`
スキーマへの`CREATE`権限を持っており（`has_schema_privilege`で確認済み）、
`cheerstick_stg`接続で`CREATE TABLE`を実行すればそのロール自身が新規テーブルの
所有者になるため、所有者不一致は起きない。`migrations/011_add_event_battles.sql`
（`event_battles`新設）をこの方法でstaging DBへ適用し、所有者が`cheerstick_stg`
（`events`等と同じ）になることを実際に確認した。詳細は`docs/spec.md` 11.9章参照。

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

## BLE切断ログの集計例（2026-09-29追加）

`ble_disconnect_logs`テーブル（`migrations/013_add_ble_disconnect_logs.sql`、
`docs/spec.md` 11.12章）へのSQLクエリ例。Vanstone様から要望のあった「頻度・条件の傾向」を
確認する際に使う。専用の画面・APIは今回実装していないため、`psql`等で直接実行する。

```sql
-- 直近7日間の、日別の切断回数
SELECT DATE(occurred_at) AS day, COUNT(*) AS disconnect_count
FROM ble_disconnect_logs
WHERE occurred_at >= NOW() - INTERVAL '7 days'
GROUP BY DATE(occurred_at)
ORDER BY day;

-- デバイスごとの切断回数（直近7日間、多い順）
SELECT d.mac_address, COUNT(*) AS disconnect_count
FROM ble_disconnect_logs bdl
JOIN devices d ON d.id = bdl.device_id
WHERE bdl.occurred_at >= NOW() - INTERVAL '7 days'
GROUP BY d.mac_address
ORDER BY disconnect_count DESC
LIMIT 50;

-- 試合中（event_idが記録されている）の切断と、それ以外（練習中・試合前後等）の内訳
SELECT
  (event_id IS NOT NULL) AS during_live_event,
  COUNT(*) AS disconnect_count
FROM ble_disconnect_logs
WHERE occurred_at >= NOW() - INTERVAL '7 days'
GROUP BY (event_id IS NOT NULL);

-- 特定の試合中の切断一覧（デバイス別、発生時刻順）
SELECT d.mac_address, bdl.occurred_at
FROM ble_disconnect_logs bdl
JOIN devices d ON d.id = bdl.device_id
WHERE bdl.event_id = '<event_idをここに>'
ORDER BY bdl.occurred_at;
```

「切断時の条件（距離など）」自体はサーバー側では持っていない（BLEの信号強度・距離等の
生データはAPPからサーバーへ送られていないため）。集計できるのは、あくまで
「いつ・どのデバイスが・どの試合中に」切断したかという頻度・タイミングの傾向のみ。

---

## リポジトリバックアップ手順（gitタグ方式、2026-09-13新設）

**実施タイミングの目安**：大きな機能追加の後、本番デプロイ前など、要所での実施を想定する。
毎回の細かいコミットで行うものではない。

過去に一度「GitHubバックアップ」が行われたとの認識があったが、2026-09-13時点で
`git tag -l`・`git remote -v`・全ブランチ・docs内の記述のいずれからも過去の具体的な
方式を特定できなかった（詳細は`docs/worklog.md`2026-09-13エントリ「リポジトリバックアップ
『20260913ver』の取得」参照）。そのため、以下を今後の標準手順として新たに定める。

### タグ命名規則

```
<ブランチ名を安全な形に変換>-<YYYYMMDDver>
```

ブランチ名の`/`はタグ名として使えない（あるいは紛らわしい）ため`-`に置き換える。

例：
- `main` ブランチ → `main-20260913ver`
- `feature/reference-data` ブランチ → `feature-reference-data-20260913ver`

### 手順

```bash
# 1. 対象ブランチのローカルがoriginの同名ブランチと完全一致していることを確認
#    （差分が出る場合はpull/pushで揃えてから進める。ズレたままタグを打つと
#    「バックアップのつもりが実は古い/新しい版だった」という事故につながるため）
git fetch origin
git log <ブランチ名>..origin/<ブランチ名> --oneline
git log origin/<ブランチ名>..<ブランチ名> --oneline
# 両方とも出力が空であることを確認

# 2. タグを作成（対象ブランチのHEADに対して）
git tag <タグ名> <ブランチ名>

# 3. タグをoriginへpush（通常のgit pushではタグは送られないため、タグ名を明示する）
git push origin <タグ名>

# 4. リモートに反映されたことを確認
git ls-remote --tags origin
```

### 本番DBバックアップの併用（推奨）

コードのバックアップ（gitタグ）と合わせて、**本番DBバックアップ（`pg_dump`）も同じ
タイミングで取得することを推奨する。** 命名規則は既存のもの（11.8章の本番デプロイ時等で
実際に使われている方式）をそのまま使う。

```bash
# 本番EC2上で実行
mkdir -p ~/backups
FILE=~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
sudo -u postgres pg_dump cheerstick_production > $FILE
ls -la $FILE   # サイズが非ゼロであることを確認
```

### 実施例（2026-09-13）

```
git tag main-20260913ver main
git tag feature-reference-data-20260913ver feature/reference-data
git push origin main-20260913ver feature-reference-data-20260913ver
```

作成したタグ：

| タグ名 | 参照コミット |
|---|---|
| `main-20260913ver` | `7388540` |
| `feature-reference-data-20260913ver` | `8f9fd4a`（管理画面ランチャー化・pageshow修正・staging DB migration 011適用の記録を含む） |

同日、本番DBバックアップも取得済み：`~/backups/cheerstick_production_20260913_074456.sql`
（49,996バイト）。詳細は`docs/worklog.md`2026-09-13エントリ参照。

### アップロード画像のバックアップ（改善3件フェーズ2、2026-09-16追加）

**理由：** 画像アップロード機能（`docs/spec.md` 8.8章）の新設に伴い、
`/var/www/cheerstick-app/images/uploads/`にDB外・git管理外の資産（アップロードされた
画像ファイル）が本番にのみ存在する状態になる。既存の「gitタグ＋DBダンプ」の
バックアップ運用（上記）だけではこれを取りこぼすため、同じタイミングでの
tar.gz化を追加の手順として定める。既存の「git管理下に画像を置きデプロイ時にコピーする」
フロー（`assets/images/`、上記デプロイ手順参照）とは別の資産であり、置き換えるものではない
（初期・既定画像は引き続き`assets/images/`が正本。運用中に随時追加・差し替えられる
アップロード画像のみが本節の対象）。

```bash
# 本番EC2上で実行。DBダンプ取得と同じタイミングで行う想定
mkdir -p ~/backups
FILE=~/backups/cheerstick_uploads_$(date +%Y%m%d_%H%M%S).tar.gz
tar czf $FILE -C /var/www/cheerstick-app/images uploads
ls -la $FILE   # サイズが非ゼロであることを確認（uploads/が空の場合はほぼ0バイトになる点に注意）
```

命名規則はDBダンプ（`cheerstick_production_<YYYYMMDD_HHMMSS>.sql`）に揃え、
`cheerstick_uploads_<YYYYMMDD_HHMMSS>.tar.gz`とした。

---

## WebARENA デモ実行環境（応援合戦デモ Phase 3、2026-09-28新設）

応援合戦デモ（`docs/worklog.md` 2026-09-27エントリ、`scripts/demo/`参照）のPhase 3
（負荷発生元VPSの構築）で用意した環境。**本番EC2（`cheerstick-production`）とは別の、
独立したインスタンス。** 本番のコード・DB・nginx設定には一切影響しない。

```
ホスト   : 161.34.35.70（WebARENA Indigo）
用途同居 : Nextcloud（cloud.kmtinc.jp）が稼働中の既存インスタンスを間借りしている
           （2026-09-21の負荷試験でも使用したものと同一）。デモ専用VPSへの
           移設予定があり、それまでの暫定利用
作業ユーザー: cheerdemo（sudo権限なし、パスワードログイン無効、
           ホームディレクトリ /home/cheerdemo は750＝cheerdemo自身以外アクセス不可）
配置     : /home/cheerdemo/cheerstick-demo（gitリポジトリ。origin は後述のbundleファイル）
Node.js  : v24.21.0（cheerdemoユーザーのnvm配下、システム全体には影響しない）
```

**`.env`は置かない。** デモ本体（`battle-demo.js`）はDB・管理APIに直接接続しない設計
（本番EC2上の`battle-demo-prepare.js`側でのみDB・管理APIを扱う）ため、このVPS上に
認証情報を持たせる必要がない。VPSが万一侵害されても本番への認証情報漏洩経路にならない
構成として意図的に採用している。

### ファイルディスクリプタ上限（ulimit）

```
設定ファイル : /etc/security/limits.d/99-cheerdemo.conf
内容         : cheerdemo soft nofile 8192
               cheerdemo hard nofile 8192
```

1プロセスで最大1,000WebSocket接続を扱う`battle-demo.js`のため、既定値では不足する
懸念に対する設定（`scripts/demo/README.md`「注意事項」参照）。`cheerdemo`ユーザーの
プロセスのみに限定されており、同居する既存サービス（Nextcloud等）には影響しない。

### ufw（SSHアクセス制限、2026-09-28対応）

**上流（WebARENA側のネットワーク制御）と、サーバー上のufwの二重で22番をオフィスIPに
限定する構成。** 上流側は従来から設定済みで、今回サーバー側のufwにも重ねた。

```
変更前 : 22/tcp ALLOW IN Anywhere（"OpenSSH"という名前付きルール）
変更後 : 22/tcp ALLOW IN 49.156.217.121（コメント: "SSH office only"）
         80/tcp・443/tcp は ALLOW IN Anywhere のまま変更なし（Nextcloud用のため）
```

```bash
# 追加したルール
sudo ufw allow from 49.156.217.121 to any port 22 proto tcp comment 'SSH office only'
# 削除したルール（名前付き"OpenSSH"ルールのため、"ufw delete allow 22/tcp"では一致しない）
sudo ufw delete allow OpenSSH
```

バックアップ：`/home/ubuntu/ufw.bak_20260928_xxxxxx`（`/etc/ufw`のコピー、EC2上ではなく
本VPS上）。

**元に戻す場合：**

```bash
sudo ufw allow OpenSSH
sudo ufw delete allow from 49.156.217.121 to any port 22 proto tcp
```

**この変更はKMT様オフィス（49.156.217.121）による2026-09-28手動実施分。**
`docs/worklog.md`同日エントリ「Phase 3」参照。ufwへの変更は本節記載の内容が最新であり、
今後の変更もここに追記していく。

### コード反映手順（git bundle方式）

本VPSはGitHubへのアクセス経路を持たない構成のため、ローカルPCで作成した`git bundle`を
`scp`で運搬して反映する（2026-09-21の負荷試験時と同方式）。

```bash
# 1. ローカル（C:\Projects\cheerstick-server）でbundle作成
git bundle create cheerstick-demo.bundle feature/reference-data

# 2. scpでVPSのubuntuユーザーのホームへ転送
scp -i <鍵ファイル> cheerstick-demo.bundle ubuntu@161.34.35.70:~/

# 3. 配置場所（/home/cheerdemo/cheerstick-demo.bundle）を置き換え、所有者をcheerdemoに変更
sudo mv ~/cheerstick-demo.bundle /home/cheerdemo/cheerstick-demo.bundle
sudo chown cheerdemo:cheerdemo /home/cheerdemo/cheerstick-demo.bundle

# 4. cheerdemoユーザーでfetch・ff-onlyでmerge
sudo -iu cheerdemo git -C /home/cheerdemo/cheerstick-demo fetch origin
sudo -iu cheerdemo git -C /home/cheerdemo/cheerstick-demo merge --ff-only origin/feature/reference-data

# 5. 依存パッケージに変更があった場合のみ
sudo -iu cheerdemo bash -c 'cd /home/cheerdemo/cheerstick-demo && npm ci --omit=dev'
```

`git remote -v`は`origin`が`/home/cheerdemo/cheerstick-demo.bundle`（ファイルパス）を
指す構成になる（GitHub等のリモートURLではない）。

### 9/21負荷試験時の残置物（未整理）

`ubuntu`ユーザー配下に2026-09-21の負荷試験で構築した`~/cheerstick-loadtest-client/`・
`.nvm`・`.npm`が残っている。今回の`cheerdemo`ユーザー環境とは独立しており支障はないが、
将来デモ専用VPSへ移設するタイミングでまとめて整理する予定（未実施）。

## お客様向け「デモモード」機能の一時ファイル（2026-09-29追加）

理由：管理画面「デモをセット」「デモを開始」ボタン（`docs/spec.md` 9.12章）の追加に伴い、
`cheerstick-server`本体（本番EC2、`/home/ubuntu/cheerstick-server-new/`）が
`scripts/demo/battle-demo.js`を子プロセスとして起動するようになった。同スクリプトの
`--metrics-log-path`には、Node標準の`os.tmpdir()`（本番EC2＝Linuxのため実質`/tmp`）配下に
`cheerstick-demo-metrics-<timestamp>.jsonl`というファイル名で、デモ実行1回ごとに新規作成される。

- 削除の自動処理は無い（`battle-demo.js`自体が既存の仕組みとしてファイルを残す設計のため、
  今回それを変更していない）。デモを繰り返すたびに増えるため、ディスク容量が気になる場合は
  `/tmp/cheerstick-demo-metrics-*.jsonl`を手動で削除して問題ない（応援ログ本体はDBの
  `cheer_logs`に残っており、このファイルは診断用の副産物に過ぎないため）
- 本番の`/tmp`はOS再起動で消える想定のディレクトリのため、放置していても実害は限定的

---

## 未確認・保留中のファイル

- `cheerstick-ws`：**2026-07-31、内容確認済み。** nginx設定の下書きであることを確認した。
  EC2上の`/etc/nginx/sites-enabled/cheerstick-ws`とdiffを取ったところ、Certbot自動追記分
  （443 ssl設定・80→443リダイレクトブロック）を除いて内容が一致。ローカル側は
  Certbot適用前の下書きとして残置されたものと判断できる（実害なし、削除も不要）。
