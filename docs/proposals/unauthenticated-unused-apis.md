# 未使用・無認証APIの棚卸しと対応方針（5エンドポイント）

作成日：2026-10-08
決定者：岩村様（KMT様）
ステータス：**調査完了・方針確定・未実装**（nginx設定変更・コード削除はまだ行っていない）

関連文書：
- `docs/proposals/large-event-scaling.md`（A-2「`src/routes/`配下の全ルート一覧」。本件の発端）
- `docs/spec.md` 11.5章（`routes/events.js`が実スキーマと異なる`events`を参照している）
- `docs/runbook.md`「管理API アクセス制限（nginx IPアドレス制限）」

---

## 0. 結論と判断

現行の本番フロントエンド（`public/`・管理画面）から呼ばれていない、認証なしの公開APIが5系統ある。
うち`GET /api/v1/devices`は本番DBの実データ（全デバイスのMACアドレス・所有者ID）を返す。

**判断（岩村様、2026-10-08）：** 現在はテスト段階で実ユーザーは存在せず、漏洩しうるのは
KMT様・サーリューション様・Vanstone様のテストデバイス情報のみのため、**緊急対応は不要。**
ただし**2027年1月の8,000人規模イベントまでに必ず対応する**項目とする。

**対応方針：B（nginxで遮断）を先に、A（コード削除）を後で。**

> 本書は調査結果の記録であり、実装済みの内容ではない。実装が完了したら`docs/spec.md`へ
> 統合し、本書は更新または削除する（`docs/proposals/README.md`の運用）。

---

## 1. 対象エンドポイントと優先度

調査はコードの読み取りのみ（本番には触れていない）。

| 順位 | エンドポイント | 性質 | 実害の見立て |
|---|---|---|---|
| 1 | `GET /api/v1/devices` | DB実データの無認証全件取得 | 全デバイスのMAC・`owner_user_id`・登録日時・カテゴリ等が漏れる。MAC一覧は後述の`webview/reference?id=<MAC>`（MACのみで認証）の総当たり材料になる。件数無制限で、台数が増えると1回数MBのJSONが返りイベントループを塞ぐ |
| 2 | `GET /api/v1/user/cs_user` | プロセス内メモリに任意キーを作れる唯一の入口 | メモリ消費・CPU遅延（Mapの全件走査）。他の2つ（game/control・cheer/device）の悪用の前提にもなる |
| 3 | `GET /api/v1/events`（直下） | DBの`events`を無認証で取得 | `hidden_at`を見ないため非表示の試合も返る。`metadata`・開始時刻・組織IDも含む。個人情報は含まない |
| 4 | `GET /api/v1/devices/:deviceId` | 同上の1件版 | UUIDを知らないと使えない。UUIDでない値を渡すとPostgreSQLの生エラー文が返る |
| 5 | `POST /api/v1/cheer/device` | `sendToDevice`で観客のWebSocketへ`cheer-update`を送る | 現状、`index.html`は`cheer-update`を処理しないため実害ほぼなし。将来`index.html`が対応すると、攻撃者が値を書いた通知を観客へ送れるようになる |
| 6 | `POST /api/v1/game/control` | プロセス内メモリ（`deviceStore`）の書き換え | `cs_user`で作った偽エントリにしか効かず、単独の脅威は小さい。DBには触れない |
| 7 | `POST /api/v1/events`、`POST /api/v1/devices`、`PATCH /api/v1/devices/:deviceId` | 書き込み系 | **現スキーマでは必ず失敗し、書き込みは起きない**（下記）。将来の列追加で突然動き出す潜在リスク |

### 書き込み系が失敗する理由（`migrations/`に基づく）

- `POST /devices`：`location`列が`devices`テーブルに存在しない（`mac_address`もNOT NULLで未指定）
- `PATCH /devices/:id`：`location`・`updated_at`が`devices`テーブルに存在しない（SQLが解析段階でエラーになり、更新されない）
- `POST /events`：`device_id`・`event_type`・`payload`が`events`テーブルに存在しない
- `GET /events?device_id=…`：同様に`device_id`列が無く500になる（`device_id`を付けない`GET /events`は動く）

**この結論は「本番スキーマが`migrations/`と一致している」前提。** 本番では未確認（TODO参照）。

### 個人情報

- メールアドレスは、いずれのエンドポイントからも取得・変更できない（`users`テーブルには触れない）
- ニックネーム等は`GET /devices`から直接は出ない。ただし全MACを入手できると、公開の
  `GET /api/v1/webview/reference?id=<MAC>`（`ENABLE_REFERENCE_TOKEN=false`のためMACのみで引ける。
  メールは返らない）で、ニックネーム・チーム・推し選手・応援履歴を総当たりで集められる

### 認証とレート制限（5系統とも共通）

- アプリケーションの認証：なし
- nginxのIP制限：なし（`/api/v1/admin/`のみが制限対象）
- レート制限：「その他」系統の15分500回/IP（`src/middleware/rateLimit.js`の`defaultIpLimiter`）。
  分散アクセスには効かない。また`trust proxy`が1のため、ポート3000がインターネットから
  直接届く状態だと`X-Forwarded-For`の偽装で回避されうる（未確認、TODO参照）

### 呼び出し元の確認結果

- `public/`・管理画面：いずれも呼んでいない。管理画面の`apiFetch('/events')`は、`common.js`の
  `API_BASE`が`…/api/v1/admin`のため、実際は`/api/v1/admin/events`を呼んでいる
- `scripts/`：`scripts/rate-limit/local-verify.js`（405行・494行）が`/api/v1/devices`を
  「その他系統のリミッター」の試験台に使っている（ローカル検証のみ）
- リポジトリ外（ネイティブアプリ、ファームウェア、旧Node-RED系）からの呼び出しは**未確認**

---

## 2. 対応方針

### B. nginxで遮断（先に実施）

`/etc/nginx/sites-available/cheerstick-api`（api.cheerstick.com）に、対象パスを404で返す
locationを1つ追加する。再起動不要（`systemctl reload`のみ）で、WebSocketは切れない。

```nginx
location ~ ^/api/v1/(user/cs_user|game/control|cheer/device|devices(/[^/]+)?|events)/?$ {
    return 404;
}
```

- **`events`は直下のみ。** `/api/v1/events/:id/target-scores`・`/events/:id/ranking-snapshots/latest`は
  会場スクリーンが使う生きた公開APIのため、`/api/v1/events`の前方一致にしてはならない
- `/api/v1/admin/devices`・`/api/v1/admin/events`は`^/api/v1/`直後が`admin/`のため一致せず、影響しない
- 正規表現locationは前方一致locationより優先して評価される。`/api/v1/admin/`のIP制限ブロックには
  干渉しない設計だが、適用前に`nginx -t`と下記の疎通確認で必ず確かめる
- 手順は`docs/runbook.md`の既存方式に従う：`sites-available`一式のバックアップ → 編集 →
  `sudo nginx -t`（失敗したらreloadしない）→ `systemctl reload nginx`
- 反映後の確認：遮断対象が404になること、生きたAPI（`/api/v1/webview/reference`・
  `/api/v1/events/:id/target-scores`・`/api/v1/event-battles/:id/score`・管理画面）が従来どおり応答すること
- **限界：** ポート3000が外部から直接届く状態だとnginxを迂回される。セキュリティグループの確認が前提

### A. コード削除（後で実施）

- 削除対象：`src/routes/index.js`の`user`・`game`・`cheer`・`devices`・`events`のマウントと`require`、
  `src/routes/{user,game,cheer,devices,events}.js`、`src/controllers/{userController,gameController,cheerController,devicesController,eventsController}.js`、
  `src/store/deviceStore.js`
- **温存するもの：** `src/websocket/index.js`の`sendToDevice`・`broadcast`・`getConnectedDevices`
  （将来のプッシュ配信用。2026-09-24の判断どおり）
- **要修正：** `scripts/rate-limit/local-verify.js`の`/api/v1/devices`を、削除後も存在する
  「その他」系統のパス（例：`/health`）へ差し替える。差し替えないと検証スクリプトが壊れる
- 反映には`pm2 restart`が必要でWebSocketが切れるため、**実イベントのない時間帯に**行う
- `docs/spec.md`は累積型のため、削除した機能の記述は消さず、変更履歴に理由を残す
  （`docs/spec.md` 11.5章の「対応要否は別途判断」にも結果を反映する）

### 実施順序

1. 下記TODOの確認（本番ログ・スキーマ・セキュリティグループ）
2. B（nginx遮断）
3. イベント前の準備期間に A（コード削除）
4. `docs/spec.md`・`docs/runbook.md`へ反映し、本書を更新または削除

---

## 3. TODO（未実施。いずれも読み取りのみで可能）

実行前に何をするか宣言してから行うこと（`CLAUDE.md`「作業スタイル」）。

- [ ] **本番アクセスログの確認：** nginxのアクセスログ（`/var/log/nginx/`配下）と
  `pm2 logs`（morganの出力）で、`/api/v1/devices`・`/api/v1/events`（直下）・`cs_user`・
  `game/control`・`cheer/device`への過去のアクセス有無を確認する。自分たち以外のIPからの
  アクセスがあれば、すでにスキャンされている可能性がある
- [ ] **AWSセキュリティグループの確認：** ポート3000がインターネットに開いていないこと
  （開いていればnginx遮断が迂回され、`X-Forwarded-For`偽装でレート制限も回避されうる）
- [ ] **本番スキーマの確認：** `\d devices`・`\d events`で`migrations/`と一致しているか
  （書き込み系が失敗するという結論の裏付け。`location`・`updated_at`・`device_id`等が
  本番に存在すれば、書き込み系も動く可能性がある）
- [ ] **リポジトリ外の呼び出し元の確認：** ネイティブアプリ・ファームウェア・旧Node-RED系が
  これらのAPIを使っていないか（Vanstone様・サーリューション様への確認が必要な可能性）
- [ ] （B適用後）遮断が効いていることと、生きたAPIに影響が無いことの確認

---

## 4. 関連する別件（本書の対象外）

- `GET /api/v1/webview/reference?id=<MAC>`がMACのみで引ける点（`ENABLE_REFERENCE_TOKEN=false`）は、
  `GET /devices`を塞いでも残る別の弱点。トークン方式の有効化は別途検討する
- `PATCH /api/v1/admin/events/:id/status`はアプリ側認証なし（nginxのIP制限のみ）。既知の課題
- WebSocketの`connect`・`register`等は無認証で、任意のMACを名乗れる（既知の設計）
- 全エンドポイントがエラー時に`err.message`をそのまま返す（`src/app.js`の共通エラーハンドラ）。
  スキーマ情報が出る。削除対象外のルートにも共通する
