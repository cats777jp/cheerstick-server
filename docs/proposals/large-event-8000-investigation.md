# 8,000人規模イベント向け 現状コード調査（男子→スポンサー対抗→女子の連続3フェーズ）

作成日：2026-10-05
対象コミット：`c7f5620`（`feature/reference-data`）
性質：**読み取りのみ。** コード・設定・マイグレーションは一切変更していない。
本番EC2・WebARENA・本番DBへの接続も行っていない（本番の値は、過去のdocsに記録された
実測・確認結果のみを引用し、出典を示した）。
位置づけ：検討中資料。実装済みの仕様ではない（`docs/spec.md`とは別）。
関連：`docs/proposals/large-event-scaling.md`（2026-09-28、トラックA/B-①の土台。本資料はその続きで、
「連続3フェーズ・8,000人が一斉に登録」という新しい前提で再調査したもの）

## 想定シナリオ（依頼文より）

- 男子チーム → スポンサー対抗 → 女子チームを1日で連続実施。各フェーズ最長4時間
- 8,000人が同時にアプリへアクセスし、ユーザー登録（ニックネーム＋メール）を行う

## 凡例

- **【事実】**：コード・docsを読んで確認できたこと（`ファイル:行`を付記）
- **【推測】**：事実からの計算・外挿。前提を併記している
- **【未確認】**：コードからは分からず、本番側の確認が必要なこと（確認方法は末尾「確認依頼リスト」）

---

## 0. 先に結論（重要度順）

| # | 発見 | 区分 | 詳細 |
|---|---|---|---|
| 1 | **1台のデバイスが別カテゴリのチームへ選び直すことは、サーバー側で拒否される（`CATEGORY_MISMATCH`）。さらに、現行のWebViewには選択後にチームを変更する画面導線が無い** | 事実 | C章 |
| 2 | **再接続すると、応援中画面から完了（ウェルカム）画面に戻り、STARTを押し直すまでcountが送られない**（コード上。実機未確認） | 事実（コード） | D章。サーバー再起動・Wi-Fi瞬断のたびに「全員の応援が止まる」可能性 |
| 3 | **nginxの接続枠が2 vCPU構成だとほぼ上限**（`worker_connections 8192`×worker数2＝16,384、8,000接続は2ソケットずつ消費して16,000） | 事実（設定値）＋推測（worker数） | E章。余裕ゼロで、片寄りがあれば不足 |
| 4 | **`cheer_logs`の行数・ディスクが桁違いに増える**：全員が5秒おきに送ると最大約2,300万行／4時間／フェーズ。1行あたり約300〜450 B（推測）で、約7〜9GB。9/17時点のルートディスクは6.8GB（使用3.6GB） | 事実＋推測 | A・E章 |
| 5 | **再接続のたびに呼ばれる`GET /webview/reference`は、そのデバイスの`cheer_logs`全行を集計する。** 試合が進むほど1回が重くなり、一斉再接続で8,000回走るとDBが詰まりうる | 事実（クエリ形状）＋推測（規模） | B・D章 |
| 6 | 登録経路は1人あたり約20往復・4回の書き込み。**トランザクション無し、メール送信等の外部呼び出し無し。** `pg.Pool`は`max 20`で、待ちが5秒を超えるとエラー応答 | 事実 | B章 |
| 7 | 強度0のcountも記録している。**スコア・順位の合計値は変わらない**が、「0pt行だけの選手・ユーザーが一覧から消える」「履歴の対象イベントが減る」影響がある | 事実 | A章 |
| 8 | 現行のレート制限に8,000台は収まる（audienceIp 50,000：基準16,000件）。**ただし1デバイスあたり再接続が約4回/15分を超えるとIP枠が尽きる**。nginx（api側）が`X-Forwarded-For`を付けているかは未確認 | 事実＋未確認 | F章 |
| 9 | `cheer_summaries`は**1度も使われていない**（INSERT/SELECTするコードが無い）。`target_id`/`user_id`が`NOT NULL`のため、そのままでは`cheer_logs`のNULL行を受けられない | 事実 | G章 |

付随して気づいた点（強度の上限超過によるINSERT失敗の可能性など）はH章。

---

## A. 応援データの量

### A-1. `count`を送る間隔

【事実】
- `public/index.html`の`onCheerStickData`（`:1063`）が呼ばれるたびに強度を算出し、**5回ごとに1件の`count`を送る**（`BATCH_SIZE = 5`、`:1037`。送信は`:1097-1110`）。
  送るのは「5回分の強度の合計`value`」と「最初のサンプルからの経過時間`duration_ms`」
- `onCheerStickData`を呼ぶ間隔はネイティブアプリ側（Vanstone様）が決める。`docs/spec.md` 5.1章は「1秒間隔」と記載
- 強度は1サンプルあたり0〜21（`MAX_INTENSITY = 21`、`:987`）。よって`value`は0〜105
- BLE切断を示す全ゼロデータのときは`count`を送らない（`ble_disconnect`のみ、`:1072-1081`）
- WebSocketが開いていない間は`send()`が黙って捨てる（`:651-655`）。再送・バッファは無い

【推測】（前提：アプリが1秒間隔で呼ぶ。実測値は本リポジトリに無い）
- 1デバイス＝約5秒に1件。**8,000台が全員応援中なら約1,600件/秒**
- 1フェーズ（4時間＝14,400秒）の上限：1,600×14,400＝**約2,300万行**
- 3フェーズとも全員が応援した場合の上限：**約6,900万行**（C章のとおり現状は選び直せないため、
  実際は各フェーズの参加者次第。ただし1フェーズに限っても約2,300万行になりうる）

### A-2. 強度0のcountの記録

【事実】
- クライアントは`value=0`でも送る（フィルタ無し、`:1097`）
- サーバーの`count`ハンドラ（`src/websocket/index.js:312-343`）も`value`の大小を見ない。
  選択中チームに`status='live'`の試合があれば**0でも`insertCheerLog`する**（`:329-338`）
- `cheer_logs.intensity`は`CHECK (intensity BETWEEN 0 AND 100)`（`migrations/001_initial_schema.sql:163`）

【事実】0を記録しない形にした場合の影響範囲（`cheer_logs`を読む箇所は`src/db/cheerstickQueries.js`のみ。全箇所を確認）

| 参照箇所 | 内容 | 0を記録しない場合の影響 |
|---|---|---|
| `getEventIntensityTotal`（`:1224`、対抗戦スコア） | `SUM(intensity)` | **影響なし**（0を足しても合計は同じ） |
| `getEventTargetScores`（`:755`）／`getAllTimeTargetScores`（`:777`） | `SUM(intensity)`、`JOIN targets`（INNER） | 合計は同じ。**0のログしか無い選手は一覧から消える**（現状は0ptで表示される） |
| `computeUserRanking`（`:1251`）／`computeTargetRanking`（`:1270`）（順位確定、上位20） | `SUM(intensity)`、INNER JOIN | 順位・値は同じ。応援ゼロのユーザー／選手は出なくなる（20位に満たない場合、0pt同率の行が出なくなる） |
| `getRecentEventCheerTotals`（`:231`）／`getAllTimeCheerTotal`（`:251`）（reference API） | `SUM(intensity)`・`SUM(duration_ms)`・`COUNT(*)` | `intensity_total`は同じ。**「0しか無いイベント」はそのユーザーの履歴（直近3件）から消える。** `cheer_count`・`total_duration_ms`は減るが、`referenceController`は`intensity_total`のみ返すため画面には出ない |
| `deleteTargetAdmin`（`:735`） | `cheer_logs.target_id`の参照有無で削除をブロック | 0ログだけの選手は削除可能になる（軽微） |

【事実】失われる情報：「応援画面にいたが振らなかった」と「未接続」の区別。参加人数（`DISTINCT device_id`）、
応援時間（`duration_ms`合計）。**現状これらを使う画面・APIはコード上に無い。** 将来「参加者N人」を出す場合は、
「振った人数」になる点に注意。

【事実】実装箇所の候補（今回は実装しない）：
- サーバー：`count`ハンドラで`value <= 0`なら早期return。旧版クライアントにも効く
- クライアント：`:1097`の`send`を`cheerBatchSum > 0`に限る。WebViewは自社配信（`app.cheerstick.com`）のため
  Vanstone様側の変更は不要と見込まれる（ただしアプリのWebViewキャッシュ挙動は未確認）
- どちらも、WebSocket自体の生存確認は別機構（ping/pong、`:412-434`）のため影響しない

【未確認】本番で0が占める割合。これが分からないと削減量が分からない（確認SQLは末尾）。
なお0を省いても、DBのINSERT（1往復＋`cheer_logs`の9本のインデックス更新）が減るだけで、
JSON解析などの受信コストは残る。

### A-3. 行数の増加がもたらすもの

【事実】`cheer_logs`にはPKを含め**9本のインデックス**がある（`001:298-312`、`005`）。1 INSERTごとに9本を更新する。

【推測】1行あたりのサイズ：ヒープ約140 B＋インデックス約200〜300 B＝**約300〜450 B/行**
（列型からの概算。実測ではない。9/28の資料にある「720万行で数百MB〜1GB」は、
この概算だと約2.5GBになり、過小だった可能性がある）。
2,300万行なら約7〜9GB、6,900万行なら約21〜28GB。ディスクは`docs/spec.md` 10.1章（2026-09-17）で
**ルート6.8GB中3.6GB使用**。インスタンス構成が同じなら、**1フェーズ分でも収まらない**。
【未確認】イベント当日のEBS容量・インスタンスタイプ（`docs/worklog.md`10/1に「本番運用はm5.large以上」の決定記録はあるが、
ディスク容量の記録は無い）。

---

## B. 登録・推し選択の経路

### B-1. メッセージごとのDB往復・書き込み

【事実】`src/websocket/index.js`と`src/db/cheerstickQueries.js`より。**すべて`pool.query`の単発実行（自動コミット）。
`BEGIN`/`COMMIT`によるトランザクションはこの経路に1つも無い**（トランザクションを使うのは管理系の`createRankingSnapshot`のみ）。

| メッセージ | 実行されるSQL（順に`await`） | 往復 | 書き込み |
|---|---|---|---|
| `connect`（`:212`） | `ensureDevice`（`INSERT … ON CONFLICT DO NOTHING`）→`findDeviceWithProfile`（4表JOIN）。状態により`listOrganizations`または`listTargetsByOrganization`を追加 | 2〜3 | 0〜1（デバイス行が無い時のみ実INSERT） |
| `register`（`:255`） | `ensureDevice`→`findOrCreateUserByEmail`（`INSERT … ON CONFLICT (email) DO UPDATE`）→`UPDATE devices`（`owner_user_id`設定）→`findDeviceWithProfile`→`listOrganizations` | 5 | **2**（users UPSERT、devices UPDATE） |
| `select_team`（`:276`） | `ensureDevice`→カテゴリ照合SELECT→`UPDATE devices`→`findDeviceWithProfile`→`listTargetsByOrganization` | 5 | 1 |
| `set_oshi`（`:294`） | `ensureDevice`→所属照合SELECT→`UPDATE devices`→`findDeviceWithProfile` | 4 | 1 |
| （完了後）`GET /webview/reference` | `getDeviceIdByMac`→`getDeviceReferenceProfile`→（並列）`getRecentEventCheerTotals`＋`getAllTimeCheerTotal` | 4（最後の2本は同時に2接続を使う） | 0 |

- **新規ユーザー1人の合計：約20往復、書き込み約4回**（users 1、devices UPDATE 3。デバイス行が未登録なら＋1）
- **外部サービス呼び出しは無い。** メール送信ライブラリ・HTTPクライアントは`package.json`にも`src/`にも無く、
  メールアドレスは`users.email`へ保存するだけ（形式チェックの正規表現のみ、`:25`・`:263`）
- `ensureDevice`は4メッセージすべてで毎回実行されるが、既存行なら実書き込みは発生しない
- 途中で失敗した場合（例：`users`は作られたが`devices`のUPDATEに失敗）、トランザクションが無いため中間状態が残る。
  ただし冪等で、再`register`すれば収束する

### B-2. 8,000人が数十秒で一斉に送った場合のボトルネック

【事実】
- `pg.Pool`は`max: 20`、`connectionTimeoutMillis: 5000`、`idleTimeoutMillis: 30000`（`src/db/index.js:6-8`）。
  空き接続が無いクエリは待ち行列に入り、**5秒待っても取れないと例外**（`timeout exceeded when trying to connect`）になる
- `ws`の`message`ハンドラは`async`で、同一接続内でも次のメッセージを待たず並行に走る。**明示的な背圧は無い**
  （既存調査 `large-event-scaling.md` C-1と同じ）
- 例外はcatchされ、`type:"error"`＋`internal server error`がクライアントへ返る（`:373-384`）。
  クライアントの`error`処理（`index.html:619-625`）はスプラッシュ（接続中画面）を閉じない。
  初回`connect`が失敗した場合、**接続は開いたまま画面が「接続を確認しています…」のまま止まる**可能性がある（実機未確認）
- `console.log`（接続成功ログ）・`morgan('combined')`（HTTPアクセスログ）が各リクエストで出る。8,000人規模では量が増えるが、
  CPU上の主因にはならないと見られる

【推測】
- Node.jsは1プロセス＝1スレッド。9/21の負荷試験（m5.large、4,000接続、`count`約800件/秒×3往復＝約2,400クエリ/秒）で
  プロセスがCPU100%に達した（`worklog` 2026-09-21「発見3」）。これを「Node 1コアの目安＝約2,400クエリ/秒」とする
- 8,000人×約20往復＝**約16万クエリ**。「数十秒（例：30秒）」で一斉なら**約5,300クエリ/秒＝目安の約2.2倍**で、
  待ち行列が伸びて5秒タイムアウトが出る領域。**5分に分散すれば約530クエリ/秒で問題ない**
  （実際の登録は入力に時間がかかるため完全な一斉にはなりにくいが、`connect`＋`geturl`は一斉になりうる）
- 9/21・10/1の負荷試験はいずれも**登録経路（register/select_team/set_oshi）を通していない**
  （`scripts/load-test/load-test.js:8-9`、ダミーデバイスは事前投入）。**登録バーストは一度も試験していない**

---

## C. チームの選び直し

### C-1. 男子→スポンサー→女子と選び直せるか

【事実】サーバー側（`setDeviceOrganization`、`cheerstickQueries.js:145-168`）：
- `select_team`は**何度でも受け付ける**。「既に選択済みなら拒否」という制限は無い
- 制限は**カテゴリのみ**：`devices.category_id`と`organizations.category_id`が一致しなければ`CATEGORY_MISMATCH`
  （`devices.category_id`がNULLでも拒否）。`organizations.is_active`は`select_team`では見ていない（一覧表示のみ`is_active = TRUE`で絞る、`:121`）
- 1台のデバイスの`category_id`は1つだけ（`devices.category_id`、`migrations/004`）

【事実】クライアント側（`public/index.html`）：
- チーム選択カードが出るのは`status === 'team_selection'`（`selected_organization_id`がNULL）のときだけ（`:863-865`）。
  `select_team`を送るのは`renderTeamList`内のクリックのみ（`:675`）。**選択後にチームを変更する画面・ボタンは無い**
- つまり**現状のUIでは、一度チームを選ぶと自力で選び直せない**

### C-2. 制限がある場合の回避方法（案。実装はしない）

| 案 | 内容 | 留意点 |
|---|---|---|
| ① 男子／スポンサー／女子のorganizationを**同じカテゴリ**に置き、WebViewに「チーム変更」導線を追加 | サーバーのカテゴリ照合を通る。`index.html`の変更（自社配信） | サーバー側の変更は不要で済む見込み。UI追加が必要。`select_team`後は推しがリセットされるので再選択が要る（C-3） |
| ② 管理側で`selected_organization_id`をNULLに戻す | 現状、管理APIで更新できるのは`category_id`と`is_demo`のみ（`updateDeviceAdmin`）。**SQL直接実行**になる | 接続中の端末には通知が飛ばず、再接続（アプリ再起動）で初めて選択画面が出る。`cached`モードでは接続ごとのデバイスキャッシュ（60秒、`websocket/index.js:43`）が残り、最大60秒は旧チームのlive試合へ記録されうる |
| ③ フェーズごとにデバイスの`category_id`を一括変更 | 管理画面の絞り込み一括適用（`bulkUpdateDevicesByFilter`）で可能 | 8,000行UPDATE。選択済みの`selected_organization_id`は変わらないため、選び直しの導線（①か②）が別途必要。単独では解決しない |
| ④ フェーズごとに専用の端末識別子（別MAC）を使う | 非現実的 | 実機のMACは固定 |

### C-3. 選び直したとき`current_target_id`（推し）はどうなるか

【事実】
- `setDeviceOrganization`は**常に**`current_target_id = NULL`にする（`:162-166`）。**同じチームを選び直しても推しは消える**
- その結果`computeStatus`は`player_selection`になり（`:142`）、`set_oshi`でその新チームの選手を選ぶまで`complete`に戻らない
- `setDeviceTarget`は選択中チームに属さない選手を`TARGET_TEAM_MISMATCH`で拒否する（`:185-189`）
- 推し未選択（NULL）の間も`count`は記録される（`count`が見るのは`selected_organization_id`のみ）。
  その行は`target_id`がNULLで、イベント合計（`getEventIntensityTotal`）には入るが、選手別集計・選手別順位には入らない（INNER JOIN）
- 【事実】**組織に`targets`が1件も無いと、デバイスは`complete`になれない**（`current_target_id`が必須のため、`:142`）。
  スポンサー組織を作る場合は、表示用の選手（例：マスコット等の`targets`行）が最低1件必要。
  選択画面が空のままだと、完了画面（START）へ進めない

---

## D. 再接続の挙動

### D-1. 自動再接続の仕様

【事実】`public/index.html:585-649`
- 待ち時間：`min(2000×1.5^回数, 10000)`ms ± 50%のランダム幅。下限1,000ms（`:590-594`）。
  1回目1〜3秒、2回目1.5〜4.5秒、3回目2.3〜6.8秒、4回目3.4〜10秒、以降5〜15秒
- **ジッター：あり**（±50%）
- **回数上限：無し**（初回表示後は無限に再試行）
- 例外：初回の`connect`応答を受け取る前（`hasShownContent`が偽）に切れた場合は自動再試行せず、
  エラー画面と手動リトライボタンになる（`:633-637`）。意図的な終了（`intentionalClose`）も再接続しない
- 回数は`open`イベントで0に戻る（`:605`）。接続は成立するがすぐ切れる状態（過負荷時の受け入れ→切断など）が続くと、
  待ち時間が1〜3秒に戻り続けうる

### D-2. 【事実（コード）】再接続後の画面遷移：応援が止まる

- 再接続するとクライアントは`connect`を再送し、`status:'complete'`の応答で`renderConnect`が走る。
  そこで`hideAllCards()`（応援中画面`cheeringCard`も隠す、`:657-661`）の後に**完了（ウェルカム）画面を表示する**（`:869-870`）
- `onCheerStickData`は応援中画面が隠れている間は何もしない（`:1067`）。応援中画面に戻るのはSTARTボタンのクリックのみ（`:932-934`）
- **したがって、Wi-Fi瞬断やサーバー再起動で再接続すると、利用者がSTARTを押し直すまで`count`は送られず、LED制御（`sendLED`）も止まる**
- 実機・本番での再現は未確認（コードからの読み取り）。docsにこの挙動の記録は見当たらない。
  4時間のイベントで接続が一度も切れない前提は置けないため、**スコアの取りこぼしと、利用者の「応援が止まった」体験に直結する**

### D-3. サーバーが一時的に落ちて戻ったとき、8,000台が一斉に再接続すると

【事実】
- `SIGTERM`/`SIGINT`で`process.exit(0)`を即時実行する（`src/index.js:28-33`）。`pm2 restart`（`.env`変更の反映含む）は**全接続を同時に切る**
- 再接続1台あたりのサーバー負荷：`ensureDevice`＋`findDeviceWithProfile`の2往復（`complete`なら一覧取得は無し）＋
  `GET /webview/reference`の4往復（B-1の表）＝**約6往復**
- `reference`の中身：`getRecentEventCheerTotals`と`getAllTimeCheerTotal`は、`cheer_logs`を`device_id`で引いて
  `SUM`/`COUNT`する。**行数に上限・キャッシュは無く**、デバイスの記録行数に比例して重くなる（`:231-262`、`idx_cheer_logs_device_event`で行は絞れるが集計自体は全行）

【推測】
- 再接続は、サーバー停止が数秒なら主に1〜3回目の待ち時間帯（1〜7秒）に集中し、**約2,000〜4,000接続/秒の山**になりうる
  （長く落ちていれば5〜15秒に均され、約800接続/秒）
- 8,000台×約6往復＝約4.8万クエリ。数秒に集中すれば、上記の「Node 1コア約2,400クエリ/秒」を超え、
  プールの待ちが5秒を超える台は`connect`が失敗して前述のスプラッシュ停止になりうる
- `reference`の重さは試合が進むほど増す。例：応援開始から1時間のデバイスは約720行、4時間なら約2,900行
  （`count`が5秒間隔の場合）を毎回集計する。8,000台×2本の集計が数秒に重なると、**DB側（同居、PostgreSQL）がCPU飽和**する可能性がある
- nginx側のTLSハンドシェイク（再接続ごとに新規接続）のCPU負荷は、2 vCPUで数千接続/秒だと無視できない可能性があるが、
  **本リポジトリには試験記録が無い**【未確認】

【事実】上の「全員が再接続→STARTを押し直すまで`count`が止まる」（D-2）ため、実際には**復旧直後の`count`の再開は
利用者のタップ速度で自然に散る**（`count`の山は小さくなる）。一方、**スコアは全員がタップし直すまで伸びない。**

---

## E. 各種上限値

### E-1. 設定値の一覧

| 項目 | 値 | 出典・区分 |
|---|---|---|
| nginx `worker_connections` | **8192**（2026-09-27、9/21試験時は768） | `docs/runbook.md`「nginx本体設定」【事実】 |
| nginx `worker_rlimit_nofile` | 32768 | 同上【事実】 |
| nginx `worker_processes` | `auto`（＝vCPU数） | 9/21の本番AMI複製の設定が`auto`（`worklog` 2026-09-21「発見1」）【事実】。本番のvCPU数は【推測】2（t3.micro、`spec.md` 10.1） |
| nginx WebSocketのタイムアウト | `proxy_read_timeout`／`proxy_send_timeout` 86400秒 | `spec.md` 11.10章【事実】。アプリ側pingが30秒ごとのため4時間でも切れない |
| pm2/Nodeのファイル数上限 | 1,048,576（`LimitNOFILE=infinity`） | `spec.md` 11.10章（2026-09-20、`/proc/<pid>/limits`実測）【事実】 |
| PostgreSQL `max_connections` | **100** | 2026-09-28に岩村様が確認（`large-event-scaling.md` 0章）【事実】 |
| `pg.Pool` `max` | **20**／接続待ち5秒／アイドル30秒 | `src/db/index.js:6-8`【事実】 |
| WebSocket heartbeat | 30秒間隔でping、90秒pong無しで`terminate` | `websocket/index.js:32-33`【事実】 |
| レート制限 | `RL_AUDIENCE_IP_MAX`50,000／`RL_DEVICE_MAX`60／`RL_SCORE_IP_MAX`6,000／`RL_DEFAULT_IP_MAX`500（15分） | `src/middleware/rateLimit.js:42-50`【事実】 |
| `PostgreSQL`の`shared_buffers`・`max_wal_size`等 | 記録なし | 【未確認】 |
| ephemeral port範囲（nginx→127.0.0.1:3000） | 記録なし（Linux既定なら約28,000） | 【未確認】 |

### E-2. nginxの接続枠（最も確度の高い不足）

【事実】WebSocketを1本プロキシすると、クライアント側とアップストリーム側の**2接続**を消費する（`worklog` 2026-09-21で実測。768で約764接続止まり）。
`worker_connections`はワーカーごとの上限。

【推測】2 vCPUなら`worker_processes auto`は2。
- 全体：8192×2＝16,384。8,000 WebSocket＝**16,000接続を消費**し、残りは約384
- ワーカーごと：8192÷2＝1ワーカーあたり約4,096 WebSocket。2ワーカーに完全に均等に振られても1ワーカー**約98%**。
  片寄れば、どちらかが先に満杯になる
- その上に`geturl`・`reference`・静的ファイル（`index.html`約39KB、画像は`assets/images`計約148KB）の一時接続が加わる
- 4 vCPU（4ワーカー）なら32,768枠で、8,000本は余裕がある（`large-event-scaling.md` B-5と同じ計算）
- したがって**本番を2 vCPUのまま8,000人を受けるなら、`worker_connections`の引き上げか、4 vCPU以上へ**。
  設定変更だけで済む項目で、`reload`で反映できる（`runbook.md` 2026-09-27の手順と同じ）

### E-3. 8,000接続でどれが先に足りなくなるか（見立て）

【推測】先に足りなくなる順（上ほど早い／確度が高い）：

1. **nginxの接続枠**（2 vCPU構成の場合）：E-2。ほぼ余裕ゼロ
2. **ディスク**：A-3。ルートディスク6.8GBでは、1フェーズ分の`cheer_logs`も収まらない可能性
3. **メモリ**（インスタンスが小さい場合）：10/1の本番測定（t3.micro、各500台＝1,000接続、`cached`）で`mem_available`の最小が約256MB。
   10.1章の「1接続時の使用中453MB」と合わせると、1,000接続で約+200MB（`mem_available`と使用中の差、ページキャッシュ等を含む粗い値）。**単純比例で8,000接続＝約+1.6GB**
   （t3.micro約909MiBには入らない）。測定はt3.micro・1,000接続までで、外挿である。10/1に「本番運用はm5.large以上」と決定済み
4. **Node 1コアのCPU**：`count`約1,600件/秒。10/1測定（`cached`、各500台、約200〜250件/秒）で`cpu_user`最大14.6%（2 vCPU全体）
   ＝約1.2ms/件（nginx・PostgreSQL含む全体）。**1,600件/秒に外挿すると約1.9 vCPU**。Node単体で1コアを超える公算が大きい
   （9/21：4,000接続で100%）。cluster mode（トラックB）が未実装のため、1プロセスで受けることになる
5. **`pg.Pool`（20）とPostgreSQLの書き込み**：`cached`でも`count`は1往復（INSERT）、約1,600 INSERT/秒×9インデックス。
   登録・再接続バーストでは、B-2/D-3のとおり待ちが5秒を超えて失敗する台が出うる。**`max_connections 100`は先には尽きない**（Poolが20のため）
6. **WebSocketのping/pong**：8,000接続で30秒に8,000回のping送信と、同数のpong受信（約270件/秒ずつ）。
   JSON解析・DBアクセスを伴わず、`count`（約1,600件/秒）に比べ軽微と見られる【推測】。
   各接続に`setTimeout`（ジッター0〜15秒）を作るが、30秒に8,000個で負荷にはならない

【未確認】どれも8,000接続での実測は無い。最大は9/21の4,000接続（m5.large）と10/1の1,000接続（t3.micro）。

---

## F. 観客のスマホが叩くHTTP API

### F-1. `public/index.html`が呼ぶHTTP API

【事実】`index.html`が呼ぶHTTP APIは**1本だけ**：`GET https://api.cheerstick.com/api/v1/webview/reference?<id or token>`（`:795`）。

| 呼び出し | 頻度 | 呼び出し元 |
|---|---|---|
| `GET /api/v1/webview/reference` | `connect`系の応答が`status:'complete'`になるたび。**新規＝登録完了時に1回、再接続のたびに1回**（`:869-876`） | `index.html` |
| `GET /api/v1/webview/geturl?id=<MAC>` | アプリ起動時に1回 | **ネイティブアプリ**（`index.html`は呼ばない。`meta refresh`でWebViewを開く） |
| 静的ファイル：`index.html`（約39KB）・チームロゴ・選手画像 | 起動のたび | nginx直配信（APIではない） |

WebSocket（`wss://ws.cheerstick.com/cheer`）はHTTP APIではなくレート制限の対象外。
会場スクリーン（`battle.html`等）は`/event-battles/:id/score`等を3秒間隔でポーリングするが、観客のスマホは呼ばない
（`large-event-scaling.md` A-3と同じ）。

### F-2. 同一IPから8,000台が呼んだ場合のレート制限

【事実】`src/middleware/rateLimit.js`。`geturl`・`reference`は「IPごと」と「デバイス（MAC）ごと」の2つを両方適用（固定ウィンドウ15分、メモリ保持）。

| 制限 | 値 | 8,000台の基準使用量（全員が15分以内に起動＋登録完了） | 判定 |
|---|---|---|---|
| audienceIp（IPごと） | 50,000/15分 | geturl 8,000＋reference 8,000＝**16,000**（32%） | 収まる |
| audienceDevice（MACごと） | 60/15分 | 1台あたり約2 | 収まる |
| scoreIp | 6,000/15分 | 観客は呼ばない。会場スクリーン1タブ300/15分 | 収まる |

【推測】
- 再接続が増えるとIP枠が先に尽きる：基準16,000の残りは34,000＝**1台あたり約4.25回の再接続/15分**まで。これを超える瞬断が
  同じ15分に集中すると、`reference`が429になる。ただし429の影響は「過去の応援回数パネルが非表示になる」だけで、
  WebSocketと`count`は影響を受けない（`index.html:804-808`、`large-event-scaling.md` C-4）
- 固定ウィンドウのため、ウィンドウの境界をまたぐと一時的に最大2倍近く通る／逆に境界直前に集中して早く枠を使い切ることがある
- 会場の携帯回線利用者はIPが分散するため、実際のIP集約は会場Wi-Fi利用者に限られる
- 【未確認】**`api.cheerstick.com`の`location /`が`X-Forwarded-For`を付けているか。**
  `runbook.md`にnginx設定の全文が載っているのは管理API用の`location /api/v1/admin/`のみ。
  付いていない場合、`trust proxy 1`（`src/app.js:11`）のもとで全リクエストが`127.0.0.1`という1つのキーになり、
  IP枠（50,000）は全利用者で共有される（それでも基準16,000は収まるが、IP別の保護は効かない）。
  9/28の429事故（本番EC2内から`127.0.0.1`宛に直接叩いた）はこの前提の崩れが原因だった

---

## G. スコア集計

### G-1. スコアAPIの集計クエリ全文

【事実】`src/db/cheerstickQueries.js`より。いずれも`cheer_logs`を毎回集計する。

**対抗戦スコア**（`GET /event-battles/:id/score`、`eventBattleController.getScore`）：メタ情報1本＋イベントごとのSUM 2本（`Promise.all`）

```sql
-- getEventBattleMeta（:1201）
SELECT eb.id, eb.label,
       ea.id AS event_a_id, ea.title AS event_a_title, ea.metadata AS event_a_metadata,
       oa.id AS org_a_id, oa.name AS org_a_name, oa.logo_url AS org_a_logo_url, oa.color AS org_a_color,
       ebv.id AS event_b_id, ebv.title AS event_b_title, ebv.metadata AS event_b_metadata,
       ob.id AS org_b_id, ob.name AS org_b_name, ob.logo_url AS org_b_logo_url, ob.color AS org_b_color
FROM event_battles eb
JOIN events ea  ON ea.id  = eb.event_a_id
JOIN events ebv ON ebv.id = eb.event_b_id
LEFT JOIN organizations oa ON oa.id = ea.organization_id
LEFT JOIN organizations ob ON ob.id = ebv.organization_id
WHERE eb.id = $1;

-- getEventIntensityTotal（:1224）。A・Bそれぞれ1回
SELECT COALESCE(SUM(intensity), 0) AS total_intensity
FROM cheer_logs
WHERE event_id = $1;
```

**選手別スコア**（`GET /events/:id/target-scores`、`GET /target-scores`）

```sql
-- getEventTargetScores（:755）
SELECT t.id AS target_id, t.name AS target_name, t.type AS target_type,
       t.image_url AS target_image_url, t.number AS target_number,
       o.id AS organization_id, o.name AS organization_name, o.color AS organization_color,
       COALESCE(SUM(cl.intensity), 0) AS total_intensity
FROM cheer_logs cl
JOIN targets t ON t.id = cl.target_id
LEFT JOIN organizations o ON o.id = t.organization_id
WHERE cl.event_id = $1
GROUP BY t.id, o.id
ORDER BY total_intensity DESC;

-- getAllTimeTargetScores（:777）：上記からWHERE句を除いたもの（全期間・全試合）
```

**順位確定**（管理画面の操作で実行。`createRankingSnapshot`、`:1295`）：1トランザクション内でユーザー別・選手別

```sql
-- computeUserRanking（:1251）
SELECT RANK() OVER (ORDER BY SUM(cl.intensity) DESC) AS rank,
       u.id AS entity_id, u.display_name AS display_name, SUM(cl.intensity) AS cheer_value
FROM cheer_logs cl
INNER JOIN users u ON u.id = cl.user_id
WHERE cl.event_id = $1
GROUP BY u.id, u.display_name
ORDER BY cheer_value DESC
LIMIT 20;

-- computeTargetRanking（:1270）：users→targets、u.id→t.id/t.name、cl.user_id→cl.target_id に置き換えた同型
```

- スコアAPIは`SCORE_CACHE_TTL_MS`（既定1,000ms）のプロセス内キャッシュ＋同時リクエストの共有あり（`src/middleware/scoreCache.js`）。
  キャッシュキーは`req.originalUrl`
- 使われるインデックス：`idx_cheer_logs_event_id`（`event_id`）、`idx_cheer_logs_event_target`（`event_id,target_id`）。
  どれも`intensity`を含まないため、**行を読むたびにヒープへ取りに行く**（`large-event-scaling.md` C-2と同じ）

【推測】9/28の資料の外挿（約4.4万行で23〜25ms＝1行あたり約0.55µs）を2,300万行（全員が1つのイベントに記録した場合）に適用すると
**約12秒/回**。9/28の「720万行で約3.9秒」の約3倍。ページキャッシュに収まらなければさらに悪化する。
1秒キャッシュは重複を束ねるだけで、**1回の集計が12秒かかれば、画面の更新は12秒以上遅れ、DBは常に集計クエリで埋まる。**
順位確定（ユーザー別・選手別の2本）も同規模で、各数秒〜十数秒かかる管理操作になる【推測】。

### G-2. `cheer_summaries`の現状

【事実】
- **スキーマ**（`migrations/001_initial_schema.sql:177-194`）：

  | 列 | 型 | 備考 |
  |---|---|---|
  | `id` | UUID PK | |
  | `event_id` | UUID **NOT NULL** | `events(id)` ON DELETE CASCADE |
  | `target_id` | UUID **NOT NULL** | `targets(id)` ON DELETE CASCADE |
  | `user_id` | UUID **NOT NULL** | `users(id)` ON DELETE CASCADE |
  | `total_intensity` | BIGINT NOT NULL DEFAULT 0 | |
  | `cheer_count` | INTEGER NOT NULL DEFAULT 0 | |
  | `duration_total_ms` | BIGINT NOT NULL DEFAULT 0 | |
  | `rank_in_event` | INTEGER | |
  | `calculated_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

  インデックス：`UNIQUE (event_id, target_id, user_id)`、`event_id`、`user_id`、`(event_id, rank_in_event)`
- **使われていないことの再確認**：`src/`・`public/`・`scripts/`・`migrations/`を`cheer_summaries`で検索し、
  ヒットは`001`（定義）と`cheerstickQueries.js:715`のコメント（`ON DELETE CASCADE`の列挙）のみ。**INSERT/UPDATE/SELECTするコードは無い**
- 【未確認】本番テーブルの行数（コード上は0行のはず）

【事実】`cheer_logs`との不整合になる点（設計上の留意）：
- `cheer_logs.user_id`・`target_id`は**NULL許容**（`001:160,162`）。`cheer_summaries`は両方`NOT NULL`
- 推し未選択のまま記録された行（`target_id`NULL）や、所有者未設定のデバイスの行（`user_id`NULL）は`cheer_summaries`の行にできない。
  対抗戦スコアは`cheer_logs`の全行を合計するため（`getEventIntensityTotal`は`target_id`/`user_id`を見ない）、
  **`cheer_summaries`のSUMだけではイベント合計が一致しなくなる**

### G-3. 集計済みの値を持つ場合の更新タイミングの設計案（案の提示のみ・実装しない）

前提：スコアAPI（イベント合計・選手別）と順位確定を、`cheer_logs`の全行集計から切り離すことが目的。

| 案 | 更新タイミング | 長所 | 短所 |
|---|---|---|---|
| **S1：count受信ごとに同期UPSERT** | `count`ごとに`cheer_logs` INSERT＋`cheer_summaries` UPSERT | 常に最新。単純 | 書き込みが約2倍（約1,600→約3,200/秒）。**書き込みは減らない** |
| **S2：プロセス内バッファ＋1〜2秒ごとにまとめて更新（推奨候補）** | `count`をメモリに集計（キー`event,target,user`→合計・件数・時間）し、1〜2秒ごとに`total_intensity = cheer_summaries.total_intensity + EXCLUDED.total_intensity`の**加算UPSERT**を1文で実行。`cheer_logs`は同じタイミングで複数行INSERT | 加算式なので将来のcluster mode（複数プロセス）でも整合する。往復・パースが大幅に減る（B-①案2と同じ） | 異常終了で直近flush間隔分が消える。**現状の`SIGTERM`は`process.exit(0)`即時のため、flush処理の追加が前提**（`src/index.js:28-33`）。デバイスが5秒に1件のため、UPSERTの行数自体は大きく減らない（読み出し側の改善が主目的） |
| **S3：DB側の定期バッチ（5〜10秒ごと）** | `cheer_logs`を`cheered_at`の差分で集計して加算 | `count`の経路を変えない | `cheered_at`は`DEFAULT NOW()`でIDも連番でないため、取りこぼし／二重加算を避けるには「安全マージン付きの区間集計」か「検証用の全件再集計」が必要。複雑 |
| **S4：試合終了時（または順位確定時）のみ全件集計して保存** | `finished`遷移／順位確定の操作時 | 実装が最小。既存の`ranking_snapshots`と同じ考え方 | **ライブ中のスコア表示には効かない。** ライブ中は別途S2相当の走行合計やキャッシュが要る |

共通の注意点：
- イベント合計は、`target_id`/`user_id`がNULLの行を含めて合わせる必要がある（G-2）。
  選択肢：①`cheer_summaries`にNULL許容・部分ユニークインデックスを足す（マイグレーション要）②NULL行用の別のイベント合計テーブル／列を持つ③NULL行は表示に含めない（`cheer_logs`の合計と食い違うことをKMT様が許容する場合）。
  **この判断は仕様の解釈にあたるため、KMT様の確認が必要**
- 反映遅延：S2なら「flush（1〜2秒）＋スコアキャッシュ（1秒）＋画面ポーリング（3秒）」で最悪約6秒
- 照合：試合終了時に`cheer_logs`の全件合計と`cheer_summaries`を突き合わせ、ずれていないことを確認する（`SUM`1回、終了後のみ）
- 読み出し側：`cheer_summaries`の行数は「ユーザー数×推し数」で頭打ち（約8,000〜数万行）。対抗戦スコアは`event_id`で数千行のSUM、
  順位確定は`(event_id, total_intensity DESC)`のようなインデックスがあれば上位20件を直接取れる
- 書き込み側の負荷（B-2・E-3の4・5）は、S2＋`cheer_logs`の複数行INSERTでないと下がらない。`cheer_summaries`単独では書き込みを減らせない

---

## H. 付随して気づいた点（質問項目外）

1. **`value`の上限と`CHECK`制約の食い違い（事実）**：クライアントの`value`は最大105（21×5、A-1）。
   `cheer_logs.intensity`は`CHECK (0..100)`（`001:163`）。5サンプルの合計が101以上になると**INSERTが制約違反で失敗**し、
   そのバッチは失われ、サーバーは`console.error`にスタックを出し、クライアントへ`internal server error`を返す（`:373-384`）。
   発生頻度は【未確認】（1サンプルあたり平均20以上の激しい振りが5秒続く必要がある）。
   本番ログの`violates check constraint`で確認できる
2. **対抗戦（`event_battles`）は2イベント固定（事実）**：スポンサー対抗が3者以上の同時比較なら、現行の対抗戦画面では表現できない
   （選手別集計`target-report.html`はイベント単位で別画面）。スポンサー対抗の形式は未確認
3. **`pm2 restart`は全員を切断する（事実）**：D-3。試合中の`.env`変更・デプロイは、全員の応援停止（D-2）を伴う
4. **`scoreCache`のキャッシュは削除されない（事実）**：キー（`req.originalUrl`、クエリ文字列を含む）ごとにエントリを作り、
   上書きはされても削除されない（`scoreCache.js:23-66`）。有効な`battle_id`に対し任意のクエリ文字列を付けて叩けば、
   エントリが増え続ける。IPごとの上限（6,000/15分）が歯止めだが、複数IPからなら増える。規模は小さく、緊急性は低い
5. **`GET /target-scores`（全期間）は絞り込み無し（事実）**：3フェーズ後は`cheer_logs`全件のJOIN＋GROUP BYとなり、1回が数十秒になりうる。
   ポーリング対象ではない（読み込み時と手動更新のみ）が、会場スクリーンで開いたままにしない運用が望ましい
6. **`cheer_logs`の`device_id`は`ON DELETE RESTRICT`（事実）**：デバイスの削除は事実上できない（運用上の影響は小さい）

---

## 確認依頼リスト（読み取り専用・岩村様の実施を想定。今回Claude Codeは実行していない）

| 確認したいこと | コマンド／SQL（案） | 関連 |
|---|---|---|
| 本番のvCPU数・nginxのワーカー数 | `nproc`、`sudo nginx -T \| grep -nE "worker_(processes\|connections\|rlimit_nofile)"` | E-2 |
| ephemeral port・somaxconn | `sysctl net.ipv4.ip_local_port_range net.core.somaxconn` | E-1 |
| `api.cheerstick.com`のXFF設定 | `grep -nE "X-Forwarded-For\|X-Real-IP" /etc/nginx/sites-enabled/*` | F-2 |
| Nodeのファイル数上限 | `cat /proc/$(pgrep -of "cheerstick-server")/limits \| grep "open files"`（pm2のpid） | E-1 |
| ディスク残量 | `df -h /` | A-3 |
| `cheer_logs`の1行あたりサイズ | `SELECT pg_size_pretty(pg_total_relation_size('cheer_logs')), count(*), pg_total_relation_size('cheer_logs')::numeric/NULLIF(count(*),0) AS bytes_per_row FROM cheer_logs;` | A-3 |
| 強度0の割合・最大値 | `SELECT count(*) FILTER (WHERE intensity=0)*100.0/NULLIF(count(*),0) AS zero_pct, max(intensity) FROM cheer_logs;` | A-2、H-1 |
| `cheer_summaries`の行数 | `SELECT count(*) FROM cheer_summaries;` | G-2 |
| PostgreSQL設定 | `SHOW shared_buffers; SHOW max_wal_size; SHOW work_mem;` | E-1 |
| CHECK制約違反の実績 | `pm2 logs cheerstick-server --err --lines 2000 \| grep -c "violates check constraint"` | H-1 |

---

## 変更履歴

- 2026-10-05：初版作成（読み取り専用調査。依頼文A〜Gに基づく）
