# CheerStick 作業ログ

**追記のみ。過去エントリの編集・削除は禁止。** 新しいエントリを先頭に追加すること。

---

## 2026-07-31 管理画面DELETE機能の設計方針書を格納

### 実施したこと
- ユーザーからDownloads内の設計方針書（`cheerstick-proposal-admin-delete-endpoint.md`、
  チャット版Claude作成）を受け取り、格納指示に従い本文を
  `docs/proposals/admin-delete-endpoint.md` として保存（格納指示セクションは除去）
- 指示書は「`docs/spec.md`の既知の課題6」への追記を求めていたが、該当項目は
  `docs/spec.md`には存在せず、`docs/proposals/production-deploy-plan.md`4章に
  あることが判明。ユーザーに報告し確認を取った結果、**両方に記載する**方針で実施：
  - `docs/proposals/production-deploy-plan.md` 4章の項目6に、実装決定・設計書への
    参照を追記
  - `docs/spec.md` 11章に新規11.3を新設し、既知の課題として正式に記録
    （spec.mdを既知の課題の正本とする従来方針に合わせる）
- **実装（コード変更）には一切着手していない。** ドキュメントの格納・参照追記のみ

### 変更したファイル
- `docs/proposals/admin-delete-endpoint.md`（新規、DELETE機能の設計方針書）
- `docs/proposals/production-deploy-plan.md`（4章項目6に参照追記）
- `docs/spec.md`（11.3新設、変更履歴に追記）
- `docs/worklog.md`（本エントリ）
- コード・DBの変更なし

### 判明した事実 / 想定と違ったこと
- 指示書が引用した「6. 管理画面にDELETEエンドポイントが存在しない」の文言は
  `docs/spec.md`ではなく`docs/proposals/production-deploy-plan.md`4章のものだった。
  指示書自体の前提と実態が食い違っていたケース（過去にも複数回発生）

### 次回への申し送り
- DELETE機能の実装は**本日（2026-07-31）の案B本番反映には含めない**
  （`docs/proposals/admin-delete-endpoint.md` 3章参照）
- 実装着手前に、`cheer_logs`→`events`の外部キー制約`confdeltype`の確認が必須
  （CASCADEだった場合は設計見直しが必要。staging環境で確認可能）
- 案Bの本番反映が完了した後、staging環境（ポート3001）で実装・検証してから
  単独デプロイとする方針
- 前回エントリ（案Bの事前確認結果）の申し送りに継続

### 未解決のまま残した課題
- 前回エントリから変わらず継続

---

## 2026-07-31 案B（admin.cheerstick.com新設）の事前確認（読み取りのみ）

### 実施したこと
- KMT様がユーザー提示の作業指示書（`cheerstick-task-20260731-preflight-check.md`、
  Downloads内、チャット版Claude作成）に基づき、`docs/proposals/production-deploy-plan.md`
  2.3節で保留になっていた管理画面配信先の判断（案A/B/C）のうち、
  **案B（`admin.cheerstick.com`を新設して配信）に決定**した後の事前確認を実施
- 本番へは一切変更を加えず、読み取り専用の確認とバックアップ取得のみ実施：
  - `public/admin/index.html`のAPI呼び出し方式の調査（ローカル）
  - EC2上のnginx設定（`sites-enabled`/`sites-available`一覧、api/app/ws各設定全文）の確認
  - ローカル未追跡`cheerstick-ws`とEC2上の同名ファイルのdiff
  - SSL証明書一覧・`authenticator`の値・自動更新設定の確認
  - 本番`.env`（`ALLOW_PRODUCTION_DB`有無、`DATABASE_URL`）、pm2状態、EC2側git状態の確認
  - 本番DBバックアップ（`pg_dump`）・`/var/www/cheerstick-app/`バックアップの取得
  - `/var/www/`配下の既存ディレクトリ確認、Secrets Manager参照有無の確認

### 判明した事実 / 想定と違ったこと
- **管理画面のAPI呼び出しは本番では絶対URL方式**（`public/admin/index.html`の
  `API_BASE`が`location.hostname`で分岐し、`localhost`/`127.0.0.1`以外では
  `https://api.cheerstick.com/api/v1/admin`を使用）。案Bでは`admin.cheerstick.com`と
  別オリジンになりCORSに抵触する。**対応はコード変更ではなく、本番`.env`の
  `ALLOWED_ORIGINS`に`https://admin.cheerstick.com`を追加するだけで足りる見込み**
  （`src/app.js`のcors設定は`ALLOWED_ORIGINS`を参照する実装のため）
- `admin.cheerstick.com`に該当するnginx設定・SSL証明書は存在しないことを確認
  （想定通り）
- ローカル未追跡の`cheerstick-ws`とEC2上の`/etc/nginx/sites-enabled/cheerstick-ws`は、
  **Certbot自動追記分（443 ssl設定・80→443リダイレクトブロック）を除いて内容が一致**。
  ローカル側はCertbot適用前の下書きと判断できる（従来「内容確認が必要」としていた
  保留事項を解消。`docs/runbook.md`側を更新）
- 証明書の`authenticator`は3ドメインとも**`nginx`**（webroot/standalone/DNS-01ではない）。
  指示書はwebroot方式を想定した記述だったため、事実の食い違いとして報告に留めた
- **EC2側は`origin/feature/reference-data`から11コミット遅れ**（`fc2c21b`→`4bd647b`）。
  管理画面本体（`f24289b`）・本番誤接続ガード（`62de68c`）を含む一連のコミットが
  未反映で、`public/admin/`はEC2上にまだ存在しない。案Bの前に通常の`git pull`
  （`docs/proposals/production-deploy-plan.md`2.2節の手順）が前提となる
- 本番`.env`に`ALLOW_PRODUCTION_DB`は未設定（想定通り、ガードのコードもまだ未反映）
- pm2 `cheerstick-server`は稼働中・再起動回数0、ログに新規異常なし
  （既知の課題以外のエラーなし）
- `/var/www/`配下に管理画面用へ転用できる既存ディレクトリは無い（新設が必要）
- `src/`・`package.json`にAWS Secrets Manager関連の参照は無く、
  アプリは`.env`のみを参照していることを確認

### 変更したファイル
- `docs/worklog.md`（本エントリ）
- `docs/runbook.md`（`cheerstick-ws`の保留事項を解消・更新）
- `docs/proposals/production-deploy-plan.md`（2.3節に案B決定の記録を追記）
- 本番EC2：`~/backups/cheerstick_production_20260731.sql`（DBバックアップ、新規ファイル）、
  `~/backups/cheerstick-app_20260731/`（`/var/www/cheerstick-app/`のバックアップコピー、
  新規ディレクトリ）を作成。**既存ファイル・設定への変更は無し**
- コード（`src/`配下）の変更なし

### 次回への申し送り
- 案Bの本番反映を進める場合の順序：
  1. 通常のデプロイ手順（`docs/proposals/production-deploy-plan.md`2.2節、
     `ALLOW_PRODUCTION_DB`追記→確認→`git pull`→`pm2 restart`の順序厳守）を先に実施
  2. 本番`.env`の`ALLOWED_ORIGINS`に`https://admin.cheerstick.com`を追加
  3. `admin.cheerstick.com`用のnginx serverブロック新設（`/`と`/api/`相当の経路両方に
     IP制限、ただし`/.well-known/acme-challenge/`は除外）、Route53 Aレコード追加（KMT様）、
     Certbotでの証明書取得
  4. 管理画面HTML配置先ディレクトリの新設（`/var/www/cheerstick-admin/`等）
- 上記1〜4はいずれも未実施。実作業はKMT様の指示を得てから着手する
- `docs/proposals/production-deploy-plan.md`3章「未pushの変更内容」は本セッション時点で
  すべてpush・EC2未反映のまま。反映後は同章の記載更新が必要

### 未解決のまま残した課題
- 前回エントリ（TOCTOU、管理APIの認証未実装、MACなりすまし等）から変わらず継続

---

## 2026-07-30 staging環境構築・管理画面動作確認・TOCTOU実証

### 実施したこと
- 検証用DB（`cheerstick_staging`）構築とスキーマ突合（STEP 0〜6完了）
- 本番誤接続ガード（`src/db/productionGuard.js`）の実装と双方向検証（STEP 7完了）
- EC2上にstaging専用プロセスを構築（`cheerstick-server-staging/`、ポート3001、
  `127.0.0.1`限定バインド、SSHトンネル経由でアクセス）
- 管理画面4ファイルのレビュー（STEP 8）と手動動作確認（STEP 9-A）
- 管理APIのAPIレベル検証（STEP 9-B）とTOCTOUの実証

### 判明した事実 / 想定と違ったこと
- 管理画面4ファイル（未追跡・出所不明）が発見された。出所の特定には至らず、
  `_review_20260728/`へコピー保全。詳細は`docs/handoff-20260730.md` 3.1節
- **TOCTOU（同一組織で複数liveが成立する）を実証。20回中19回発生。**
  詳細は`docs/spec.md`の既知の課題を参照
- Expressアプリに`express.static`が存在せず、`public/`配下は本番ではnginxが
  配信していることを確認（既知の「静的ファイル2箇所問題」の構造）
- `cheerstick_stg`ロールのパスワードを再発行（平文露出への対応、完了）

### 次回への申し送り
- 未pushの4コミット＋本日の未コミット変更のcommit/push方針の決定
- 管理画面の本番反映手順（静的ファイル2箇所問題を踏まえた手順が必要）
- 詳細は`docs/handoff-20260730.md`（セクション6以降の追記部分）を参照

### 未解決のまま残した課題
- TOCTOU（リリース後の改良として対応、`docs/spec.md`記載）
- 日時逆転（`ends_at < starts_at`）のバリデーション欠如
  （編集機能で修正可能なため今回は対応不要と判断、KMT様判断）
- 不正UUID形式で500＋生のPostgreSQLエラーメッセージが返る
- 管理画面にDELETEエンドポイントが存在しない（誤登録の削除手段がない）
- 管理画面4ファイルの出所（3.1節、これ以上追跡しない方針）

---

## 2026-07-30 handoff-20260730.md を追加

`docs/handoff-20260730.md` を追加。詳細は当該ファイル参照。

---

## 2026-07-27 チームロゴ・チーム名の使用許諾が未取得と判明、表示コンテンツをリーグワンへ当面切り替え

### 実施したこと
- `docs/proposals/admin-panel-design.md` 8章の未確定事項のうち、
  「V・ファーレン長崎様のチームロゴ・チーム名の使用許諾」を
  **未取得と判明（2026-07-27）** として確定・チェック済みに更新
- 対応方針として、**当面リーグワン（三菱重工相模原ダイナボアーズ）のデータで
  進める**こととし、これは管理画面の着手を妨げる前提条件ではないと整理
- 1章の前提条件に、表示コンテンツをリーグワンへ当面切り替える方針を追記
- **Jリーグ（V・ファーレン長崎）側のデータは削除せず保持し、許諾取得後に
  表示を切り替える**方針を明記

### 変更したファイル
- `docs/proposals/admin-panel-design.md`（1章に前提条件を追記、8章の該当項目を
  未確認→未取得と判明・チェック済みへ更新）
- `docs/worklog.md`（本エントリ）
- コード（`src/`配下）の変更なし

### 次回への申し送り
- 3章「#9の権利関係」表のチームロゴ・チーム名の行は、まだ「未確認。要フォロー」の
  ままになっており、8章の記述（未取得と判明）と表現が食い違っている。
  次回整合を取ること
- リーグワン側のチーム・選手データの投入手順（ロゴURL・チームカラー等）は
  未着手。2026-07-27時点の別記録にある「ラグビーリーグワン・ダイナボアーズの
  データをテストに使用する」方針と合流させる形で進める想定
- V・ファーレン長崎様のロゴ・チーム名許諾取得後の切り替え手順（表示データの
  差し替え方法）は未検討

---

## 2026-07-27 管理画面の機能整理完了、実装順序と認証方式を確定

### 実施したこと
- ユーザーから受け取った `cheerstick-admin-panel-requirements-20260727.md`
  （管理画面 機能整理・実装方針 第2版）で `docs/proposals/admin-panel-design.md`
  （2026-07-25版）を置き換えた。7/25版の内容は第2版に統合済みとの確認を得た上での
  差し替え。コード変更は無し
- 主な確定事項：
  - アクセス制限は **IP制限＋nginx Basic認証**（自作の認証コードは書かない方針）
  - 機能一覧を優先度A/B/Cで再整理。#9（プロフィール／ロゴ設定）・#10
    （チームカラー設定）を優先度B→Aへ引き上げ
  - 画面構成を3画面（`/events` `/teams` `/devices`＋ダッシュボード）に集約
  - フェーズC（応援可視化）は500台負荷試験の日程未定のため、
    ダミーデータ生成スクリプトを先行させる方針に変更
  - リリース前の実装範囲を #0→#1・#2→#9・#10→#4・#5 に絞り、3〜3.5日と見込む

### 変更したファイル
- `docs/proposals/admin-panel-design.md`（2026-07-25版から2026-07-27第2版へ全面置換。
  `git diff --stat docs/` で146行削除・211行追加を確認済み。旧版の内容を吸収した
  意図的な全面改訂であり、機能の記述漏れではないことをユーザーに提示済み）
- `docs/worklog.md`（本エントリ）
- コード（`src/`配下）の変更なし

### 次回への申し送り
- 未確定事項（`docs/proposals/admin-panel-design.md` 8章）が複数残っている。
  特に「V・ファーレン長崎様のチームロゴ・チーム名の使用許諾」は選手写真より先に
  チーム選択画面へ現れるため優先度が高い
- `admin.cheerstick.com` のDNS/証明書の現状（未設定なのか取得済みなのか）は
  実地確認がまだ済んでいない。着手前に確認が必要
- 実装自体は本セッションでは未着手（方針確定のみ）

---

## 2026-07-27 migrations/009本番適用・デモ用デバイス登録・動作確認

### 実施したこと
- ユーザー確認のうえ、`migrations/009_add_device_is_demo.sql`を本番へ適用：
  1. ローカルの本日分コミット（`b599ee3`〜`061e74e`）を`git push origin
     feature/reference-data`でGitHubへ反映
  2. 本番（`/home/ubuntu/cheerstick-server-new`）で`git pull`（`b17ee37..061e74e`）
  3. 本番で`node src/db/migrate.js`を実行し、`009_add_device_is_demo.sql`のみAPPLY
     （001〜008はSKIP、想定通り）
  4. 適用後、`schema_migrations`に`009`が記録されたこと、`\d devices`で
     `is_demo boolean NOT NULL DEFAULT false`列が追加されたことを確認
- `docs/runbook.md`記載のデモ用デバイス登録SQLを、MACアドレスが
  `DE:AD:BE:EF:00:01`になっていることを実行前に確認したうえで本番実行（`INSERT 0 1`）。
  登録内容：`id=c35a42c5-4fc1-419a-b0e7-f6b143b37854`,
  `mac_address=DE:AD:BE:EF:00:01`, `status=active`,
  `category_id=10000000-0000-0000-0000-000000000001`（Jリーグ）, `is_demo=true`,
  `owner_user_id=NULL`
- デモ用デバイスの動作確認（`register`以降は未実施、指示範囲内）：
  1. `GET /api/v1/webview/geturl?id=DE:AD:BE:EF:00:01` → `200 OK`、
     `https://app.cheerstick.com/index.html?id=DE%3AAD%3ABE%3AEF%3A00%3A01`への
     meta refreshリダイレクトHTMLを正常に確認
  2. WebSocket `wss://ws.cheerstick.com/cheer`へ
     `{"type":"connect","id":"DE:AD:BE:EF:00:01"}`を送信し、以下の応答を受信：
     ```json
     {"type":"connect","status":"unregistered","user":null,"team":null,"member":null,"reference_url":"https://app.cheerstick.com/reference.html?id=DE%3AAD%3ABE%3AEF%3A00%3A01"}
     ```

### 変更したファイル
- 本番DB：`schema_migrations`に`009`追加、`devices.is_demo`列追加、
  デモ用デバイス1件（`DE:AD:BE:EF:00:01`）を新規登録（テスト後の削除は無し。
  デモ用として継続利用する想定のため）
- GitHub / 本番リポジトリ：`git pull`により`061e74e`まで反映（コードのdiffなし、
  ドキュメントとmigrations/009のみ）
- `docs/worklog.md`（本エントリ）
- コード（`src/`配下）の変更なし

### 判明した事実 / 想定と違ったこと
- `status`は`"error"`から`"unregistered"`へ改善し、category_id未設定による
  異常系（第6章・11章参照）を脱したことを確認した
- **`teams`（チーム選択肢）は今回の確認では返っていない。** これは不具合ではなく
  `computeStatus()`（`src/websocket/index.js`）の仕様通りの挙動：`teams`は
  `status === 'team_selection'`のときのみ付与され、そのためには`owner_user_id`が
  設定済み（＝`register`実行済み）である必要がある。今回のデモ用デバイスは
  `owner_user_id = NULL`のまま登録し、指示によりconnectまでしか確認していないため、
  `status`は`unregistered`で止まっており想定通り。`teams`を実際に確認するには
  次回`register`を送信する必要がある

### 次回への申し送り
- デモ用デバイスで`register`〜`select_team`〜`set_oshi`〜`count`までの一連の
  動作確認（`teams`/`targets`が正しく返るか、`is_demo=true`でも通常デバイスと
  同一の経路で状態遷移すること）はまだ未実施
- `is_demo`を参照する集計・ランキング・ダッシュボードの実装は引き続き未着手
- 前回までの申し送り（MACなりすまし対応、Vanstoneブリッジ仕様提示等）に継続

### 未解決のまま残した課題
- 前回エントリから変わらず継続。加えて、デモ用デバイスの`register`以降の
  動作確認が未実施のまま残っている

---

## 2026-07-27 spec.md 3.2章に旧記述への打ち消し・参照ポインタを追加

### 実施したこと
- 前回、3.2章「チームID登録」に実装との乖離を追記した際（コミット`b599ee3`）、
  旧記述（「事前ホワイトリスト方式に確定済み」）自体には打ち消しの文言が無く、
  読み手が追記部分まで読まないと乖離に気づけない構造だったとの指摘を受けた
- 既存文言は削除・改変せず、以下2点を追加：
  1. 見出し直後に「⚠️ この節の当初記述は現行実装と一致しません。必ず下記の
     2026-07-27追記まで読んでください。」という警告を追加
  2. 旧記述の文末に「※実装されていない（下記追記参照）」を追加
- `git diff docs/spec.md`で、既存文（「事前ホワイトリスト方式に確定済み」〜
  「PDF仕様書を参照）。」）が一文字も削除・変更されていないことを確認済み

### 変更したファイル
- `docs/spec.md`（3.2章、既存文の削除・変更なし、注記4行の追加のみ）
- `docs/worklog.md`（本エントリ）
- コード・DBの変更なし

### 判明した事実 / 想定と違ったこと
- 特になし（ドキュメントの可読性改善のみ）

### 次回への申し送り
- 前回までの申し送り（migrations/009の本番適用、デモ用デバイスINSERTの実行等）に継続

### 未解決のまま残した課題
- 前回エントリから変わらず継続

---

## 2026-07-27 デモ用デバイスMACアドレスの修正（DE:M0:... → DE:AD:BE:EF:00:01）

### 実施したこと
- 前回エントリで`docs/runbook.md`に記録したデモ用デバイス登録SQLのMACアドレスを、
  `DE:M0:00:00:00:01`から`DE:AD:BE:EF:00:01`へ修正
- 理由：`DE:M0:...`の`M`は16進数として不正な文字であり、アプリ側にMAC形式の
  バリデーションが存在する場合に弾かれる懸念があるとの指摘を受けた。
  `DE:AD:BE:EF:00:01`はローカル管理アドレス（16進数として正しく、かつ慣用的に
  テスト・デモ用途で使われる値）であり、実機（グローバル管理アドレス）と衝突しない
- `docs/runbook.md`該当箇所にMACアドレス変更の経緯をコメントとして追記
- SQLは前回同様、本コミット時点でも未実行（`migrations/009`が本番未適用のため）

### 変更したファイル
- `docs/runbook.md`（デモ用デバイス登録SQLのMACアドレスを修正）
- `docs/worklog.md`（本エントリ）
- コード・DBの変更なし

### 判明した事実 / 想定と違ったこと
- 前回作成した`DE:M0:00:00:00:01`は16進数として不正な値であり、実際にアプリ側で
  MAC形式バリデーションが実装された場合に投入できなくなる可能性があった。
  未実行のまま気づけたため実害はない

### 次回への申し送り
- 前回エントリの申し送り（migrations/009の本番適用、デモ用デバイスINSERTの実行、
  is_demoを参照する集計・ランキング実装）に変わらず継続

### 未解決のまま残した課題
- 前回エントリから変わらず継続

---

## 2026-07-27 デモモード実装の前段調査、記帳漏れ是正、is_demo方式への転換

### 実施したこと
- デモモード実装に向けた現状調査（コード変更なし）を実施し、報告：
  - `geturl`（`src/controllers/webviewController.js`）はDBを一切参照せず、id未指定/空文字は
    同一の400、未登録MACでも正常系と同じ200のリダイレクトHTMLを返すことを確認
  - `devices`テーブルの現行スキーマ（本番`\d devices`）、`migrations/`一覧（次番号は009）、
    WebSocket各ハンドラのDB書き込み箇所（`connect`/`register`/`select_team`/`set_oshi`/`count`）を
    ファイル・行番号単位で特定
  - 応援量の横断集計（管理API・ダッシュボード向け）は未実装で、個別デバイス向け集計
    （`getRecentEventCheerTotals`/`getAllTimeCheerTotal`）のみ存在することを確認
  - 本番`schema_migrations`が`007`までしか記録されておらず、`008`（`targets.profile_text`列、
    実体は本番に存在）が未記帳であることを発見
- `connect`ハンドラの拒否ロジックを精査し、`msg.id`が空/未指定の場合を除き、
  **未登録・架空のMACアドレスを拒否する分岐が一切存在しない**ことをコード上確認
  （`category_id`未設定の場合も、`ensureDevice()`でdevices行を作成した後に
  `status:'error'`という「正常応答」を返すのみで、接続自体は拒否されない）
- 上記を本番で実地確認：未使用と確認済みのMACアドレス`AA:BB:CC:DD:EE:42`で
  `GET /api/v1/webview/geturl` → WebSocket `{type:"connect"}` を実行し、いずれも拒否されず
  `devices`テーブルへ自動的に行が作成されることを確認。確認後、当該テスト行は
  `DELETE FROM devices WHERE mac_address = 'AA:BB:CC:DD:EE:42'`で削除し後片付け済み
  - なお、ユーザー提示の例`AA:BB:CC:DD:EE:FF`は前回セッションで実際に「テスト太郎」として
    登録済みだった本番デバイスであることが判明したため、そちらは使用せず別MACで実施した
- `migrations/008_target_profile_text.sql`の全文冪等性を判定（`ADD COLUMN IF NOT EXISTS`と
  `COMMENT ON COLUMN`のみで副作用なし、再実行安全と判断）。ユーザー確認のうえ、本番で
  `node src/db/migrate.js`を再実行し、`schema_migrations`に`008`を正しく記帳（是正完了、
  001〜008の8件が揃っていることを確認済み）
- `docs/spec.md`3.2章の「事前ホワイトリスト方式に確定済み」という記述が実装（TOFU方式・
  任意のMAC自動登録）と乖離していたため、既存記述は削除せず追記で是正。あわせて
  第11章「既知の課題」を新設し、認証機構が無く任意のMACで`cheer_logs`へ書き込み可能な点
  （応援量捏造リスク、対応時期未定）を記録（コミット`b599ee3`）
- デモモードの設計方針について、当初検討していた「`ensureDevice`等の書き込み系関数に
  分岐を入れてDB保存自体を止める」方式をユーザー指摘により撤回し、**「is_demoフラグで
  集計から除外する」方式**へ転換。デモ用デバイスも本番デバイスと全く同じ経路で
  DBへ状態を保持し（書き込みガードは実装しない）、応援量の集計・ランキング・
  ダッシュボード側で`is_demo`を除外条件に使う設計とした
  （書き込み抑止方式は、デモ用デバイスの動作そのものが本番と食い違うリスクがあり、
  審査・デモンストレーション用途では「実際に一通り動く」ことの確認が主目的のため
  不適切と判断した）
- `migrations/009_add_device_is_demo.sql`を新規作成（`devices.is_demo BOOLEAN NOT NULL
  DEFAULT false`、`ADD COLUMN IF NOT EXISTS`で冪等、ロールバック文コメント併記）。
  本番へは未適用（コミット`e606526`）
- デモ用デバイス登録SQL（MAC `DE:M0:00:00:00:01`、`category_id`は本番`categories`から
  SELECTで確認した Jリーグ = `10000000-0000-0000-0000-000000000001`、`is_demo=true`、
  `owner_user_id=NULL`）を作成し、`docs/runbook.md`に記録。**未実行**（009適用が前提のため）
  （コミット`fd07523`）

### 変更したファイル
- `docs/spec.md`（コミット`b599ee3`）
- `docs/runbook.md`（コミット`fd07523`）
- `migrations/009_add_device_is_demo.sql`（新規、コミット`e606526`）
- 本番DB：テスト用デバイス1件（`AA:BB:CC:DD:EE:42`）を作成・削除（後片付け済み、差分なし）、
  `schema_migrations`に`008`の記録を追加（是正、実体のスキーマ変更は無し）
- `docs/worklog.md`（本エントリ）
- コード（`src/`配下）の変更なし

### 判明した事実 / 想定と違ったこと
- `devices`テーブルへのMACアドレス事前登録（ホワイトリスト）は、`docs/spec.md`3.2章の
  記述に反してコード上どこにも実装されていなかった。`geturl`・`connect`いずれも
  未登録MACをそのまま受け入れ、`ensureDevice()`が無条件に`devices`行を作成する
- ユーザー提示の検証用MAC例`AA:BB:CC:DD:EE:FF`は「架空」ではなく、前回セッションの
  実地テストで実際に登録済みだった本番デバイス（テスト太郎）だったため、
  検証には別の未使用MACを選定する必要があった
- `migrations/008`は本番のカラム自体は反映済みだったが、`schema_migrations`への記帳が
  漏れていた（`migrate.js`を介さず手動psqlで適用された可能性が高い）。機能への実害は
  無かったが、次回`009`適用時のトラブルの芽になり得たため先に是正した
- デモモードの当初設計案（書き込み抑止方式）は、ユーザーからの指摘で
  「デモ用デバイスも通常どおり動作を確認できる必要がある」という審査・デモ用途の
  目的と整合しないことが分かり、is_demoフラグによる集計除外方式に転換した

### 次回への申し送り
- `migrations/009_add_device_is_demo.sql`を本番へ適用し、`docs/runbook.md`記載の
  デモ用デバイス登録SQL（`DE:M0:00:00:00:01`）を実行するのは次回以降（本セッションでは
  ユーザー指示により未実施のまま）
- `is_demo`フラグを実際に集計・ランキング・ダッシュボードのクエリへ反映する実装は
  未着手（現状、そもそも横断集計クエリ自体が存在しないため、そちらの新規実装と
  合わせて設計する必要がある）
- 前回までの申し送り（Vanstoneブリッジ仕様提示が最優先、認証機構の欠如への対応は
  リリース後検討、静的ファイル2重配置の恒久対応等）は変わらず継続

### 未解決のまま残した課題
- 第11章に記録した「MACアドレスのなりすまし・応援量捏造リスク」は対応時期未定のまま
- デモ用デバイスの`category_id`固定値（Jリーグ）が今後カテゴリー追加時にも
  そのままで良いかは未検証
- `is_demo`を参照する集計・ランキング・ダッシュボードの実装そのものが今後の課題

---

## 2026-07-25 管理画面設計案の正式配置（配置と記録のみ、実装なし）

### 実施したこと
- チャット側で検討した「管理画面・応援可視化ダッシュボード」の設計案
  （`cheerstick-admin-panel-design-draft.md`）を、正式な検討中ドキュメントとして
  `docs/proposals/admin-panel-design.md` へ配置
- `docs/proposals/` フォルダを新設し、`docs/spec.md`（実装済み正本）と
  検討中の設計案を明確に区別する運用を開始（`README.md`で説明）
- `CLAUDE.md`のドキュメント運用ルールに `docs/proposals/` の位置づけを追記
- 本日チャットで合意した以下の方針を記録：
  - 管理画面をフェーズA（試合状態・所有者リセット）／フェーズB（プロフィール・
    チームカラー設定）／フェーズC（応援可視化ダッシュボード）に分けて段階実装する方針
  - フェーズCは「管理画面での検証」と「将来の会場スクリーン表示」の両対応を
    前提にAPI設計を先行させる方針
  - ニックネーム表示について、専用入力欄は設けず、登録画面に案内文を追加する
    形で運用すること（この案内文追加はフェーズA実装時に含める）
  - メールアドレス収集は継続し、Apple/Googleのアプリストア審査で申告する方針
    （Vanstone様のアプリ申請時に必要。ブリッジ仕様のやり取りで申し送り済み）

### 変更したファイル
- `docs/proposals/README.md`（新規）
- `docs/proposals/admin-panel-design.md`（新規）
- `CLAUDE.md`（ドキュメント運用ルールへ追記）
- `docs/worklog.md`（本エントリ）
- コード変更なし

### 判明した事実 / 想定と違ったこと
- 特になし（今回は配置と記録のみ）

### 次回への申し送り
- フェーズA（試合状態切り替え・所有者リセットのAPI化）は8月リリース前後、
  Vanstoneとのやり取りが停滞している時間帯に着手するのに適している（社外依存なし）
- フェーズA実装時、登録画面への「ニックネームでご登録ください」案内文追加を含めること
- メールアドレス収集のアプリストア審査申告は、Vanstoneへのブリッジ仕様共有時に
  申し送りとして伝えること（次回のVanstone連絡時に忘れずに）
- フェーズCの未回答事項（API設計の過不足、2画面構成の是非、会場表示デザイン方向性）は
  `docs/proposals/admin-panel-design.md`末尾に記載。KMT様からの回答待ち

### 未解決のまま残した課題
- 前回までの申し送り事項に変更なし（Vanstoneブリッジ仕様提示が引き続き最優先）

---

## 2026-07-25 プロフィール枠実装（Phase 1調査で前提が覆り、縮小版で実施）

### 実施したこと
- 作業指示書（`cheerstick-task-20260725-profile-frame.md`）のPhase 1調査を実施し、
  結果を報告。指示書の3つの想定（静的ファイル直書き／選手テーブル無し／WebSocket応答に
  画像URL無し）がいずれも実態と異なる（`organizations.logo_url`・`targets.image_url`・
  WebSocket応答の画像URLは既に実装済み）ことが判明したため、指示書自身の分岐基準に従い
  実装前に報告し、指示を仰いだ
- ユーザー承認を得て、縮小版のPhase 2として以下のみ実施：
  1. `migrations/008_target_profile_text.sql`：`targets.profile_text`（nullable）を追加
  2. `public/index.html`：`teamLogo.src = team.logo_url`の直書きにnullチェックを追加。
     `logo_url`が無い場合、既存の推し選手と同じパターン（頭文字＋色のアバター、
     `#teamLogoAvatar`）にフォールバックするよう修正
  3. `profile_text`をWebSocket `connect`応答の`member.profile_text`として返却するよう
     `src/db/cheerstickQueries.js`・`src/websocket/index.js`を修正。フロントに
     `#oshiProfileText`表示行を追加（値が無ければ行ごと非表示）
  4. `object-fit`変更（`contain`化）はユーザーの判断で撤回。既存の`cover`を維持
- 本番へマイグレーション適用・デプロイ・動作確認まで実施（詳細は「判明した事実」参照）
- `docs/spec.md`に6.1「`targets`テーブルの設計」・9.1「プロフィール表示の空枠仕様」を新設

### 変更したファイル
- `migrations/008_target_profile_text.sql`（新規）
- `src/db/cheerstickQueries.js`, `src/websocket/index.js`, `public/index.html`
  （コミット `b17ee37`）
- `docs/spec.md`（コミット `a5dda4b`）
- 本番DB（`cheerstick_production`）：`profile_text`列追加、動作確認用の使い捨てテスト
  デバイス（`AA:BB:CC:DD:EE:01`）を作成・削除（後片付け済み）

### 判明した事実 / 想定と違ったこと
- `organizations.logo_url`・`targets.image_url`は初期スキーマ（migration 001）から
  既に存在し、フロントも既にDB値を動的に描画していた（ハードコードされた画像ファイル名は
  コード中に存在しなかった）。V・ファーレン長崎ロゴ・ヴィヴィくんの画像も、既に
  `https://app.cheerstick.com/images/...`として本番配信されており、「移行」は実質不要だった
- `targets`は「選手テーブル」ではなく、`type`列（player/team/mascot/artist/unit等）で
  汎用管理する1テーブル設計。作業指示書はこれを把握しておらず誤った前提を書いていた
- WebSocketの新規デバイス（`connect`のみ実行、`category_id`未設定）は`status:'error'`に
  なり`select_team`が`CATEGORY_MISMATCH`で拒否されることを動作確認中に再確認（想定通りの
  既存挙動。動作確認スクリプトでは対象デバイスに`category_id`を手動設定して回避した）
- デプロイ後、本番WebSocketで実際に確認：
  - 新規・チーム未選択状態：`team: null`、`status: 'unregistered'`（teamLogo/teamLogoAvatar
    とも非表示のパスを通過、エラーなし）
  - 既存の登録済みデバイス（`AA:BB:CC:DD:EE:FF`）：`team.logo_url`・`member.image_url`とも
    従来どおり返却され、新規`member.profile_text: null`も正しく追加されている（回帰なし）
  - サンプル選手A選択：`member.image_url: null`, `member.profile_text: null`を確認
    （空枠の既存メカニズムが引き続き機能）
- フロントのDOM描画自体（実ブラウザでの見た目）は本セッションでは確認できていない。
  WebSocket応答の内容とJSのnullチェックロジック（コードレビュー＋構文チェック）による
  確認にとどまる

### 次回への申し送り
- 前回までの申し送り（Vanstoneブリッジ仕様提示が最優先、他継続項目）は変わらず
- 実ブラウザでの目視確認（既存デバイスでロゴ・ヴィヴィくん表示が崩れないこと、
  スマートフォン幅375pxでの空枠レイアウト）は未実施。可能なタイミングで確認を推奨

### 未解決のまま残した課題
- フロントの実ブラウザでの目視確認（375px幅含む）が未実施
- `organizations`にも同様のtype汎用管理があるかは今回未調査（`targets`のみ確認）

---

## 2026-07-25 TOFU方式の本番DB実地テスト・デプロイ完了

### 実施したこと
- 作業指示書（`cheerstick-task-20260725-verify-deploy.md`）に基づき、コミット
  `113a7f9`（デバイス所有者の上書き防止／TOFU方式）を本番DBに対してpsqlで実地検証し、
  全シナリオ通過を確認したうえで本番へデプロイした
- 検証手順は指示書からの想定と本番の実状態が食い違ったため、以下の点を変更して実施
  （詳細は「判明した事実」参照）：シナリオ1〜3は新規の使い捨てテストMAC
  `AA:BB:CC:DD:EE:00` を使用し、`AA:BB:CC:DD:EE:FF`（実際に登録済み）は一切更新せず
  読み取り専用でシナリオ4相当を確認した
- 4シナリオすべて期待結果どおりであることを確認：
  - シナリオ1（未登録デバイスへの初回登録）: `UPDATE 1`
  - シナリオ2（同一ユーザーによる再登録）: `UPDATE 1`
  - シナリオ3（別ユーザーによる上書き試行）: `UPDATE 0`（拒否）、所有者はUSER_Aのまま不変
  - シナリオ4（既存の実登録デバイスへの影響確認、読み取り専用）: `would_pass = t`
- テスト用ユーザー2件・テスト用デバイス1件（`AA:BB:CC:DD:EE:00`）を作成後、全件削除して
  後片付け完了。`AA:BB:CC:DD:EE:FF`の状態（owner_user_id, registered_at）は開始時と
  完全一致することを確認済み
- 本番デプロイ実施：`git pull`（`c39ee16..0b52562`）→
  `pm2 restart cheerstick-server --update-env` → `pm2 list`で`online`を確認
- デプロイ後のpm2ログを確認。新規のエラーなし

### 変更したファイル
- 本番DB（`cheerstick_production`）：テスト用行を作成・削除（最終的に差分なし）
- 本番 `/home/ubuntu/cheerstick-server-new`：`git pull`で`113a7f9`まで反映
- `docs/worklog.md`（本エントリ）

### 判明した事実 / 想定と違ったこと
- 検証対象のテストMAC `AA:BB:CC:DD:EE:FF` は、指示書が前提としていた「未登録」
  状態ではなく、本日のブラウザ確認で既に「テスト太郎」(`test@example.com`,
  owner_user_id `bb640401-964e-4eb6-98bf-7010315b5a61`, registered_at
  `2026-07-21 08:53:46.500527+00`) に登録済みだった。この状態でシナリオ1のUPDATE文を
  そのまま実行すると対象外（`UPDATE 0`）になり、指示書の期待結果と食い違う。
  実データへの余計な書き込み・複雑な復元を避けるため、シナリオ1〜3は新規の
  使い捨てテストMACに切り替える判断をした（`AA:BB:CC:DD:EE:FF`は最終確認まで無変更）
- 本番pm2ログで、KMT様のオフィスIP(49.156.217.121)からの管理APIアクセス・
  `/api/v1/webview/reference`アクセスが既に実施され成功していることを確認した。
  管理APIのIP制限（作業1）がオフィスIPを正しく通していることの実地確認になった
  （管理APIのレスポンス自体は`test`という非UUID値によるアプリ層エラーだが、
  nginx側の403ではない＝IP制限は正しく機能）
- デプロイ後のpm2ログにregister/TOFU関連の新規エラーは無し

### 次回への申し送り
- 前回エントリ（管理API IP制限・所有者上書き防止対応）の申し送りを継続。
  特にVanstoneへのブリッジ仕様提示が最優先
- デプロイ後、実際のWebSocket `register` メッセージでのアプリケーション層動作確認は
  指示書上「必須ではない」とされており本セッションでは未実施。次回、実機または
  ブラウザからの確認が可能であれば行うとより確実

### 未解決のまま残した課題
- 実機（WebSocket経由）でのregister動作確認は未実施（psqlでのSQL挙動確認のみ）
- 管理APIの`test`のような不正なevent_idに対する入力バリデーション欠如
  （500エラーになる。今回のスコープ外だが、UUID形式チェックがあると親切）

---

## 2026-07-25 商用リリース前セキュリティ対応2件（管理API IP制限・所有者上書き防止）

### 実施したこと
- 作業指示書（`cheerstick-task-20260725-security.md`）に基づき、リリース前必須の
  セキュリティ対応2件を実施
- **作業1：管理APIへのnginx IPアドレス制限**
  - 本番EC2で `/etc/nginx/sites-available` をバックアップ（`sites-available.bak_20260725_080501`）
  - `cheerstick-api`（`api.cheerstick.com`）に `location /api/v1/admin/` ブロックを追加し
    `allow 49.156.217.121; deny all;` でKMT様オフィス固定IPのみ許可
  - `nginx -t` 成功を確認後 `systemctl reload nginx`
  - EC2上のcurlで管理APIが403（正しい挙動）、`geturl`/`app.cheerstick.com`等の通常機能が
    無影響であることを確認
- **作業2：デバイス所有者の上書き防止（TOFU方式）**
  - `registerDeviceOwner()`（`src/db/cheerstickQueries.js`）のUPDATE文に
    `AND (owner_user_id IS NULL OR owner_user_id = $1)` を追加し、別ユーザーによる
    上書きを`rowCount === 0`で検出、`DEVICE_ALREADY_REGISTERED`エラーとして投げる
  - `src/websocket/index.js` の既存エラーメッセージ分岐（`CATEGORY_MISMATCH`等と同じ書き方）に
    `DEVICE_ALREADY_REGISTERED`を追加
  - フロントエンド（`public/index.html`）は既存の`type:'error'`ハンドラ（`formError`表示・
    `registerBtn`再有効化）がそのまま流用できるため、変更不要と判断
- `docs/spec.md`・`docs/runbook.md` に両作業の内容を追記（別コミット）

### 変更したファイル
- `src/db/cheerstickQueries.js`, `src/websocket/index.js`（コミット `113a7f9`）
- `docs/spec.md`, `docs/runbook.md`（コミット `cf04aab`）
- 本番 `/etc/nginx/sites-available/cheerstick-api`（git管理外、EC2上で直接編集）

### 判明した事実 / 想定と違ったこと
- ローカル環境にPostgreSQL/Dockerが無く、指示書の「作業2-5：ローカルでの動作テスト」を
  実DBに対しては実施できなかった。代わりに`db.query`をインメモリでモックした
  ロジック検証スクリプトで、指示書記載の4シナリオ（新規登録／同一ユーザー再登録／
  別ユーザー上書き拒否／既存デバイスの回帰確認）すべてPASSを確認した。
  **実DB・実際のPostgres制約（一意制約等）に対する検証ではない**ため、
  本番反映後は実機での動作確認を推奨する
- 作業指示書のエラー応答例（`{type:"register", status:"error", code:...}`）は
  既存のエラー応答形式（`{type:"error", message}`）と異なる独自形式だったが、
  指示書自身が「既存の実装の書き方に合わせる」ことを優先するよう指示していたため、
  既存形式を採用した
- `docs/spec.md`の4.2メッセージ種別表に、現行コードには存在しない`set_name`・`broadcast`
  というtypeが残っていることに気づいた（削除はせず注記のみ追加）
- 本番nginxの`sites-enabled`に`cheerstick-ws`（ws.cheerstick.com設定）が実在し稼働中と確認。
  ローカルリポジトリの未追跡ファイル`cheerstick-ws`との関係は未確認のまま

### 次回への申し送り（優先度順）
1. Vanstoneへブリッジ仕様（`window.onCheerStickData` 等）を提示・合意
   → 唯一の社外依存。往復に日数がかかるため最優先で発信
   - 送付後、先方の合意を得られ次第 `ENABLE_REFERENCE_TOKEN=true` へ切替
   - 切替時は `REFERENCE_TOKEN_SECRET` のローテーションを必ず同時に行う
2. 今回対応した2件は暫定対応であり、以下は今回スコープ外として残っている
   （作業指示書に明記された「今回はやらない」項目）
   - `geturl` のホワイトリスト検証（現在DBを見ずに常にリダイレクトしている）
   - `geturl` 専用のレート制限、未登録MACアクセスのログ記録
   - `device_owner_history` テーブル（登録履歴の記録）
   - Cookieによるブラウザ紐付け（WebViewの挙動検証が必要なため、リリース後）
3. 2,000〜20,000本規模の負荷試験（未実施）とWebSocketハートビート実装
4. 静的ファイル2箇所デプロイ問題の恒久対応（nginx root統一）
5. `docs/archive/` へ仕様書PDF・旧引継ぎ書v14・監査書を格納
6. untracked の `cheerstick-ws` / `nodered-backup/` / `*.bak_*` の要否判断
   （`cheerstick-ws` は本番nginxの実設定ファイルと同名。関連の有無を要確認）
7. `docs/spec.md` のエンドポイントパス表記・WebSocketメッセージ種別表を実装に合わせて修正

### 未解決のまま残した課題
- 管理APIのIP制限はnginx側の暫定対応。アプリケーションレベルの認証は未実装のまま
- 本番DBでの実機動作確認（4シナリオ）は未実施（ローカルはモックテストのみ）
- KMT様オフィスからの管理API疎通確認（403以外が返ること）は未実施（要ユーザー確認）

---

## 2026-07-25 reference機能（署名付きトークン）実装状況調査

### 実施したこと
- reference機能（署名付きトークン）の実装状況をコード調査（コード変更なし）
- 有効化時の追加手順（`REFERENCE_TOKEN_SECRET`再生成）を `docs/spec.md` の
  再有効化手順へ反映
- 調査結果と申し送りを本エントリとして記録

### 変更したファイル
- `docs/spec.md`（3.3再有効化手順にシークレット再生成ステップと理由を追加、変更履歴に追記）
- `docs/worklog.md`（本エントリ）

### 判明した事実 / 想定と違ったこと
- reference機能は JWT(HS256)、TTL 7d、ペイロードは `{device_id, mac}`、email非含有
- WebSocket `connect` 応答への `reference_url` 組み込みは実装済み
  （`src/websocket/index.js`、トークン有効/無効の両モードに対応）
- 本番 `.env` に `REFERENCE_TOKEN_SECRET` 設定済みを確認
- `docs/spec.md` のエンドポイントパス表記が実装と不一致
  （`/geturl/` → 実装は `/api/v1/webview/geturl`、`/webviewrefer/` → 実装は
  `/api/v1/webview/reference`）。仕様書PDF由来の誤記と判明。次回修正予定

### 次回への申し送り（優先度順・下記1は前回エントリの内容を補足）
1. Vanstoneへブリッジ仕様（`window.onCheerStickData` 等）を提示・合意
   → 唯一の社外依存。往復に日数がかかるため最優先で発信
   - 本日、ブリッジ仕様書とセキュリティ方針の回答をサーリューション経由で送付予定
   - 先方の合意後、`ENABLE_REFERENCE_TOKEN=true` への切替を実施する
   - 切替時は `REFERENCE_TOKEN_SECRET` のローテーションを必ず同時に行う
2. 管理API `PATCH /api/v1/admin/events/:id/status` に認証を追加（現在無認証で公開中）
3. 2,000〜20,000本規模の負荷試験（未実施）とWebSocketハートビート実装
4. 静的ファイル2箇所デプロイ問題の恒久対応（nginx root統一）
5. `docs/archive/` へ仕様書PDF・旧引継ぎ書v14・監査書を格納
6. untracked の `cheerstick-ws` / `nodered-backup/` / `*.bak_*` の要否判断
7. `docs/spec.md` のエンドポイントパス表記を実装に合わせて修正
   （`/geturl/` → `/api/v1/webview/geturl` 等）

### 未解決のまま残した課題
- 上記7のパス表記修正は、意図的な省略表記か単純な誤記か切り分けが必要なため
  本セッションでは修正せず記録のみに留めた

---

## 2026-07-25 カテゴリー機能生存確認・Elastic IP割当・Cowork導入

### 実施したこと
- ドキュメント体制の整備（`docs/` 3分割、`CLAUDE.md`、`/handover` スキル、git管理化）
- カテゴリー機能の生存確認
- Elastic IP 割当・Route53更新・再起動テスト
- Cowork（デスクトップ）導入と役割分担の決定

### 判明した事実 / 想定と違ったこと
- カテゴリー機能は `d75d8f1` で実装済み、以降削除されていない。
  本番DBにも `categories` テーブル、`organizations`/`devices` の `category_id` が
  外部キー制約つきで実在。マルチスポーツ対応は本機能で実現済み。
- 引継ぎ書からの記述消失は、`.gitignore` に `.claude/` が含まれ
  「引継ぎドキュメントはclaude.ai側で管理」する方針だったことが根本原因。
  差分が取れないため消失に誰も気づけなかった。今回この方針を転換した。
- 未コミットの3ファイルは改行コード(CRLF/LF)の差異のみで、内容変更はなかった。
- Cowork は読み取り・調査・ファイル編集は可能だが、FUSE経由のため
  `.git/index.lock` が残り git 書き込みができない。git操作はClaude Codeが担当する。

### 次回への申し送り（優先度順）
1. Vanstoneへブリッジ仕様（`window.onCheerStickData` 等）を提示・合意
   → 唯一の社外依存。往復に日数がかかるため最優先で発信
2. 管理API `PATCH /api/v1/admin/events/:id/status` に認証を追加（現在無認証で公開中）
3. 2,000〜20,000本規模の負荷試験（未実施）とWebSocketハートビート実装
4. 静的ファイル2箇所デプロイ問題の恒久対応（nginx root統一）
5. `docs/archive/` へ仕様書PDF・旧引継ぎ書v14・監査書を格納
6. untracked の `cheerstick-ws` / `nodered-backup/` / `*.bak_*` の要否判断

### 未解決のまま残した課題
- EC2のNameタグが `cheerstick-api-server` のままで実態とずれている
- 選手データの実データ化、CSVインポート、Grafana、管理画面
- チームカラーの正式HEX値（暫定 `#005AAA`）

---

## 2026-07-25 ドキュメント運用体制のコミット・push

### 実施したこと
- 前セッションで作成済みだった `.gitattributes` / `.gitignore` 変更 / `CLAUDE.md` ・
  `SETUP.md` ・ `docs/` ・ `.claude/`（いずれも未コミットのworking tree状態）を、
  ユーザー指示に沿って3つの単独コミットに分割してコミット
  1. `3962fd0` chore: テキストファイルの改行コードをLFに統一（`.gitattributes` のみ）
  2. `d87db8c` chore: 引継ぎドキュメントをgit管理対象に変更（`.gitignore` のみ）
  3. `840e36d` docs: 引継ぎドキュメント体制を整備（`CLAUDE.md`/`SETUP.md`/`docs/`/`.claude/`）
- `cheerstick-ws` / `nodered-backup/` / `*.bak_*` は指示通り触れず未追跡のまま残した
- `feature/reference-data` を `origin` にpush（upstream未設定だったため `-u` で新規設定）

### 変更したファイル
- `.gitattributes`（新規）／ `.gitignore`（改行コード運用ルールのコメント更新）
- `CLAUDE.md` / `SETUP.md` / `docs/spec.md` / `docs/runbook.md` / `docs/worklog.md` / `.claude/skills/handover/SKILL.md`（コミット確定のみ、内容は前セッションで作成済み）

### 判明した事実 / 想定と違ったこと
- `git add --renormalize .` は `-u` を暗黙に含むため、未追跡の新規ファイル（`.gitattributes` 自体）は
  ステージされない。別途 `git add .gitattributes` が必要だった。
- 最初のコミットでパス指定を忘れ、事前にステージ済みだった `.gitignore` の変更が
  `.gitattributes` のコミットに混入する事故を起こした。push前だったため
  `git reset --soft HEAD~1` で取り消し、パス指定付きで正しくコミットし直した。
  （教訓：複数コミットに分割する際は、必ず `git commit -- <path>` でコミット対象を明示する）

### 次回への申し送り
- 上記の分割コミットにより本セッションの申し送り事項に変化なし。下の優先度リストを参照。

### 未解決のまま残した課題
- 特になし（本セッションはコミット整理・pushのみ。下記の既存課題は継続）

---

## 2026-07-25 ドキュメント運用体制の整備

### 実施したこと
- 引継ぎ書を単一ファイルで書き直す運用をやめ、`docs/` 配下の3ファイル分割に移行
  - `spec.md`（累積型・削除禁止）／ `runbook.md`（環境情報）／ `worklog.md`（追記のみ）
- `CLAUDE.md` を設置し、セッション開始・終了時の手順を常時指示化
- `/handover` スキルを追加し、セッション終了時の docs 更新手順を固定化

### 判明した事実 / 想定と違ったこと
- v10で実装した「カテゴリー機能」の記述が v12 以降の引継ぎ書から消失していた。
  原因は単一ファイルを毎回書き直す運用で、触れなかった内容が自然に脱落したこと。
  コードの問題ではなくドキュメント運用の問題と判断。git管理により再発を防ぐ。
- 仕様書PDF（20260630）と現行実装に多数の差異がある。PDFは史的経緯として保管し、
  `docs/spec.md` を正本とする方針に変更。

### 次回への申し送り（優先度順）
1. **Vanstoneへブリッジ仕様（`window.onCheerStickData` 等の仮称）を提示・合意**
   → 唯一の社外依存。中国＋仲介1社経由のため往復に日数がかかる。最優先で発信
2. **Elastic IP 割当**（作業15分、未対応のままEC2再起動で4ドメイン全滅）
3. **管理API `PATCH /api/v1/admin/events/:id/status` に認証追加**（現在認証なしで公開中）
4. **負荷試験＋WebSocketハートビート実装**（2,000〜20,000本規模、未検証）
5. カテゴリー機能の生存確認（psql / grep で10分。設計判断は後回しで可）
6. 静的ファイル2重配置の恒久対応（nginx root統一）

### 未解決のまま残した課題
- マルチスポーツ対応の設計確定（初回リリースは長崎単独のため後倒し）
- 選手データの実データ化（現状サンプル選手A/B/Cのプレースホルダー）
- CSVインポート機能（MACリスト・選手データの一括投入）
- Grafana設定、admin.cheerstick.com
- `devicesController.js` の既存バグ（存在しない location カラム参照、実害なし）
- `cheerstick-api`（旧pm2プロセス）の削除
- チームカラーの正式HEX値（V・ファーレン長崎、暫定 #005AAA）
- 管理画面（試合状態操作・チームカラー設定のUI）

---

## 2026-07-23 v14までの作業（過去分の要約）

> handover v14 より転記。当時の記録を要約したもの。

### 実施したこと
- 本番EC2の状況確認（pm2 / index.htmlバージョン / nginx・SSL / DB稼働）
- 本番ディレクトリがgit管理外だった問題を解消。ローカル・GitHub・本番を完全同期（`c39ee16`）
- CORS設定修正：`ALLOWED_ORIGINS=https://app.cheerstick.com` を `.env` に追加
- 署名付きトークン（reference機能）を一時無効化、MACアドレス直指定方式へ切替
- 応援量カウント機能をサーバー側に新規実装（migration 006、events.status CHECK制約）
- 応援中画面（cheeringCard）をフロントに新規実装
- チームカラー対応（migration 007、organizations.color 列）

### 判明した事実
- 静的ファイルが2箇所にあり、`git checkout` だけでは本番配信先に反映されない。
  この見落としで当日デプロイ漏れが1度発生した。

### 未解決のまま残した課題
- 上記2026-07-25エントリの申し送りに引き継ぎ済み
