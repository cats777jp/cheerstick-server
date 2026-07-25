# CheerStick Runbook（環境・接続情報・手順）

最終更新：2026-07-25

---

## 本番環境

```
EC2インスタンス : i-04576698e7325bddb
パブリックIP    : 52.196.49.126（Elastic IP、2026-07-25割当。Nameタグ: cheerstick-production）
                  ※旧IP 18.179.62.192 は割当解除済み。再起動でもIP不変を確認済み
SSH             : ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@52.196.49.126
```

### 稼働プロセス

```
nginx                 80/443、api/app/ws すべてのリバースプロキシ
cheerstick-server     pm2 online、ポート3000、REST API + WebSocket 統合プロセス
                      稼働ディレクトリ: /home/ubuntu/cheerstick-server-new（git管理下）
cheerstick-api        pm2 stopped、旧プロトタイプ。削除候補
```

### ドメイン・SSL

証明書有効期限：2026-10-19

| ドメイン | 状態 |
|---|---|
| api.cheerstick.com | 稼働中 |
| app.cheerstick.com | 稼働中 |
| ws.cheerstick.com | 稼働中 |
| admin.cheerstick.com | 未設定（Grafana等用、優先度低） |

Route53 Aレコードは4本とも上記パブリックIPを直接指す。TTL 300。

### データベース

```
PostgreSQL（EC2上に直接インストール、RDS不使用）
DB   : cheerstick_production
User : cheerstick
```

### 環境変数（.env）

```
ALLOWED_ORIGINS=https://app.cheerstick.com   # ワイルドカード許可は解消済み
ENABLE_REFERENCE_TOKEN=false                 # 署名付きトークン、現在無効化中
```

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

### ⚠️ 静的ファイルは2箇所ある

```
/home/ubuntu/cheerstick-server-new/public/index.html   （git管理下）
/var/www/cheerstick-app/index.html                     （nginxが実際に配信）
```

**`git checkout` だけでは後者に反映されない。** 過去にこの見落としでデプロイ漏れ発生済み。

```bash
cd /home/ubuntu/cheerstick-server-new
git pull
sudo cp public/index.html /var/www/cheerstick-app/index.html   # ← 忘れやすい
pm2 restart cheerstick-server
```

**恒久対応（未実施）**：nginx の root を `cheerstick-server-new/public/` に統一するか、
デプロイスクリプトでコピーを自動化する。

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

- `cheerstick-ws`：nginx設定の下書きの可能性。未追跡のまま保留中。内容確認が必要
