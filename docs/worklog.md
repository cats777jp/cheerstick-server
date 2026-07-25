# CheerStick 作業ログ

**追記のみ。過去エントリの編集・削除は禁止。** 新しいエントリを先頭に追加すること。

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
