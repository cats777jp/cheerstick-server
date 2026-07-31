# CheerStick 本番反映計画書（管理画面・本番誤接続ガード）

作成日：2026-07-30
作成者：Claude（チャット版）
対象：次セッションのClaude（チャット版）およびClaude Code、KMT様

本書は、2026-07-30のstaging検証（`docs/handoff-20260730.md`）完了後、
**本番環境へ変更を反映するための計画書**である。
本日は検証完了・記録整理までで区切り、本番反映は改めて実施する方針となった。

---

## 0. 本日時点で完了していること

- 検証用DB（`cheerstick_staging`）の構築、本番スキーマとの完全一致確認
- 本番誤接続ガード（`src/db/productionGuard.js`）の実装と双方向検証
- EC2上のstaging専用プロセス（`cheerstick-server-staging/`、ポート3001、
  `127.0.0.1`限定）での管理画面の動作確認（STEP 9-A・9-B）
- 管理画面4ファイルのレビュー（`docs/handoff-20260730.md` 3.1節参照）
- TOCTOUの実証と記録（`docs/spec.md` 11.2節）

**本番環境（pm2: `cheerstick-server`、nginx、`cheerstick_production`）は
本日一切変更していない。**

---

## 1. 【最重要】本番反映で絶対に見落としてはならない点

### 1.1 `ALLOW_PRODUCTION_DB=true` の設定（順序を誤ると本番が停止する）

`src/db/productionGuard.js` は、接続先DBが `cheerstick_production` であり、かつ
環境変数 `ALLOW_PRODUCTION_DB` が文字列 `'true'` でない場合、
`console.error` の上 `process.exit(1)` する。
これは `src/index.js` の起動シーケンスで、HTTPサーバーの `listen` より前に
`await` される形で組み込まれている。

つまり、**この変更を本番へ反映した状態で `ALLOW_PRODUCTION_DB` が未設定のまま
本番プロセスを再起動すると、本番アプリは起動しない。**

**必ず以下の順序で行うこと：**

```
① 本番の .env に ALLOW_PRODUCTION_DB=true を追記する
② 追記されたことを確認する（grep等）
③ その後に git pull する
④ その後に pm2 restart する
```

①を飛ばして③④を行うと本番が落ちる。ロールバック手順（下記5章）を
実行前に必ず確認しておくこと。

### 1.2 静的ファイル2箇所問題（過去にデプロイ漏れが発生済み）

`public/` 配下のファイルは、git管理下の原本と、nginxが実配信するディレクトリの
2箇所に存在する。**git pull だけでは本番の配信内容は変わらない。**

```
/home/ubuntu/cheerstick-server-new/public/    ← git管理下の原本（pullで更新される）
/var/www/cheerstick-app/                       ← nginxが app.cheerstick.com として実配信
```

管理画面（`public/admin/index.html`）についても同じ構造が当てはまる。
**pull後、配信先へのコピーが別途必要。**

なお、`admin.cheerstick.com` は未設定であり、管理画面の配信先を
どこにするかは本番反映時の判断事項（下記2.3参照）。

### 1.3 管理画面は認証なし・nginxのIP制限のみに依拠

`/api/v1/admin/*` はnginxで `allow 49.156.217.121; deny all;` が設定済み
（`docs/runbook.md`記載、2026-07-30に設定の実在を確認）。
管理画面のAPIはこのIP制限のみで保護される。認証は未実装であり、
これは既知の課題として `docs/spec.md` に記録されている。

**AWSセキュリティグループの確認結果（2026-07-30）：**
インバウンドは443/80/22の3件のみで、ポート3000は開いていない。
そのためnginxを迂回した直接アクセス（`http://52.196.49.126:3000/...`）は
到達不可能であることを確認済み。IP制限は実効性がある。

---

## 2. 本番反映の作業計画

### 2.1 事前確認（変更前、すべて読み取りのみ）

- [ ] 本番の `.env` の現在の内容を確認（`ALLOW_PRODUCTION_DB` の有無、
      `DATABASE_URL` が `cheerstick_production` を指していること）
- [ ] 本番プロセスの現状（`pm2 list`、`pm2 logs cheerstick-server --lines 50`）
- [ ] EC2側のgit状態（`git status`、`git log --oneline -3`、`origin`との差分）
- [ ] 本番DBのバックアップを取得（`pg_dump`、`sudo -u postgres`で実行、
      本番への書き込みは行わない）
- [ ] `/var/www/cheerstick-app/` の現在の内容をバックアップ（コピー保全）

### 2.2 反映手順（順序厳守）

```
1. 本番 .env に ALLOW_PRODUCTION_DB=true を追記
2. 追記の確認（grep ALLOW_PRODUCTION_DB .env）
3. git pull（feature/reference-data）
4. 差分の確認（git log、git diff HEAD~1 --stat 等）
5. pm2 restart cheerstick-server
6. pm2 logs で起動確認（productionGuardによるブロックが出ていないこと、
   "CheerStick server running on port 3000" 等が出ていること）
7. 一般APIの疎通確認
   - curl -sI https://api.cheerstick.com/api/v1/webview/geturl?id=<テスト用MAC>
   - https://app.cheerstick.com/index.html の表示確認
   - wss://ws.cheerstick.com への接続確認
8. 管理画面の静的ファイルを配信先へ配置（下記2.3の判断に従う）
9. 管理APIの疎通確認（KMT様の事務所IPまたはVPN経由で）
   - curl https://api.cheerstick.com/api/v1/admin/organizations
   - IP制限が効いていること（別経路からは403になること）の確認
10. 管理画面をブラウザで開いて動作確認（STEP 9-Aと同様の項目を簡易に）
```

**7番（一般APIの疎通確認）を必ず行うこと。** 管理画面の追加が
アプリ側の通信に影響していないことを、実際に確認する必要がある。
Vanstone様のアプリはこの経路を使用しており、ストア審査にも関わる。

### 2.3 管理画面の配信先の判断（2026-07-31、KMT様判断により案Bに決定）

**KMT様の判断により、案B（`admin.cheerstick.com`を新設して配信）に決定した。**
決定を受けた事前確認結果は`docs/worklog.md`の2026-07-31エントリを参照。
以下は決定に至るまでの検討記録として残す。

管理画面HTMLをどこから配信するかは、本番反映時に決める必要がある。

| 案 | 内容 | 論点 |
|---|---|---|
| A | `/var/www/cheerstick-app/admin/` にコピーし、`app.cheerstick.com/admin/` で配信 | 一般ユーザーが到達しうるドメイン。nginxで`/admin/`にもIP制限を追加する必要あり |
| B | `admin.cheerstick.com` を新設し、そこで配信 | Route53のAレコード追加、SSL証明書（ACM/Certbot）、nginx serverブロック新設が必要。作業量は増えるが分離としては最も清潔 |
| C | 本番反映を見送り、staging環境（トンネル経由）のまま運用 | 追加作業ゼロ。ただし試合当日にSSHトンネルを張る運用になる |

**staging環境で確認した構成（Expressの`express.static`経由）は
staging専用の暫定対応であり、本番はこの経路を通らない。**
本番ではnginxが配信する前提で計画すること。

案Cは意外と現実的な選択肢である。管理画面の操作者はKMT様のみであり、
試合当日にSSHトンネルを張るのが許容できるなら、本番のnginx・DNS・SSLに
一切手を入れずに済む。**リリース期日を優先するなら案Cを推奨する。**

---

## 3. 未pushの変更内容（2026-07-30 時点）

ローカル（`C:\Projects\cheerstick-server`、ブランチ `feature/reference-data`）に
以下の変更がある。push状況は本書作成時点の作業結果を参照。

| ファイル | 種別 | 内容 |
|---|---|---|
| `src/db/productionGuard.js` | 新規 | 本番誤接続ガード。**1.1の注意事項あり** |
| `src/index.js` | 変更 | 起動シーケンスのasync化、ガードの組み込み |
| `public/admin/index.html` | 新規 | 管理画面（出所不明・レビュー済み） |
| `src/controllers/adminEventController.js` | 変更 | 同上 |
| `src/routes/admin.js` | 変更 | 同上 |
| `src/db/cheerstickQueries.js` | 変更 | 同上 |
| `.gitignore` | 変更 | `_review_20260728/` 等の除外 |
| `docs/handoff-20260730.md` | 新規 | 本日の作業記録 |
| `docs/spec.md` | 変更 | 既知の課題11.2（TOCTOU）追記 |
| `docs/worklog.md` | 変更 | 本日分エントリ追記 |

`cheerstick-ws`（未追跡）は内容未確認のため保留中。
EC2上の `/etc/nginx/sites-enabled/cheerstick-ws` と同一内容と推測されている
（`docs/handoff-20260730.md` 参照）。

---

## 4. 本番反映後に残る課題（リリース後対応）

`docs/spec.md` の既知の課題を正本とする。主なもの：

1. **TOCTOU**（11.2節、2026-07-30実証、20回中19回発生）
   → リリース後、部分UNIQUEインデックスでの対策を推奨
2. **管理APIの認証未実装**（IP制限のみに依拠）
3. **MACアドレスTOFU方式によるデータ捏造リスク**（対応時期未定）
4. 日時逆転（`ends_at < starts_at`）のバリデーション欠如
   → 編集機能で修正可能なため今回は対応不要と判断（KMT様判断、2026-07-30）
5. 不正UUID形式で500＋生のPostgreSQLエラーメッセージが返る
6. 管理画面にDELETEエンドポイントが存在しない（誤登録の削除手段がない）
   → **2026-07-31、KMT様判断により実装が決定。** 設計方針は
     `docs/proposals/admin-delete-endpoint.md` を参照。実装時期は
     「案B本番反映の完了後、staging環境で検証してから」と決定済み
     （`docs/spec.md` 既知の課題11.3も参照）
7. 静的ファイル2箇所問題の恒久対応（nginx root統一）
8. 2チーム対応：選択肢1（1試合＝2レコード）で運用中。
   選択肢2（一括開始/停止機能）はリリース後の改善候補
   （`docs/handoff-20260730.md` 参照）

---

## 5. ロールバック手順（本番反映が失敗した場合）

```
1. git reflog または git log で反映前のコミットハッシュを確認
2. git reset --hard <反映前のハッシュ>
   ※ EC2上での操作。push済みの履歴は書き換えない
3. pm2 restart cheerstick-server
4. pm2 logs で起動確認
5. 静的ファイルを配置していた場合、バックアップから復元
6. 一般API（geturl / app / ws）の疎通確認
```

`.env` に追記した `ALLOW_PRODUCTION_DB=true` は、
**ロールバック後も残して問題ない**（ガードのコードが無い状態では
単に無視される環境変数となるため）。

---

## 6. 次セッションでの再開手順

1. `docs/spec.md`・`docs/runbook.md`・`docs/worklog.md` 直近3件を読む
   （`CLAUDE.md`の運用ルール）
2. 本書（本番反映計画書）を読む
3. `docs/handoff-20260730.md` のセクション6以降（本日の追記部分）を読む
4. 上記2.3（管理画面の配信先）の判断をKMT様に確認する
5. 2.1の事前確認を実施
6. 2.2の反映手順を、**順序を厳守して**実施

**staging環境について：** EC2上の `cheerstick-server-staging/`（ポート3001）は
そのまま残置してよい。本番とは独立しており、`127.0.0.1` 限定バインドのため
外部からは到達できない。PC再起動やEC2再起動でプロセスは停止するため、
再度検証する場合は手動で起動し直すこと（起動手順は
`docs/handoff-20260730.md` のセクション6を参照）。
