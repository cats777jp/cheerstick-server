# CheerStick Runbook（環境・接続情報・手順）

最終更新：2026-07-25

---

## 本番環境

```
EC2インスタンス : i-04576698e7325bddb
パブリックIP    : 18.179.62.192
                  ⚠️ Elastic IP 未割当。停止・起動でIPが変わり、Route53の
                     4レコードが全滅する。最優先で対応すること（手順は後述）
SSH             : ssh -i C:\AWS\cheerstick-key\cheerstick-key.pem ubuntu@18.179.62.192
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

## Elastic IP 割当手順（未実施・最優先）

```
1. EC2コンソールで Elastic IP を新規割当
2. インスタンス i-04576698e7325bddb へ関連付け
3. IPが変わった場合、Route53 の4レコードを更新
   （api / app / ws / admin .cheerstick.com、TTL 300のため反映は早い）
4. DNS反映後、4ドメインすべてで疎通確認
5. インスタンスを再起動してもIPが変わらないことを確認
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

- `cheerstick-ws`：nginx設定の下書きの可能性。未追跡のまま保留中。内容確認が必要
