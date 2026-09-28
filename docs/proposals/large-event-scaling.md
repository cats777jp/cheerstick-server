# 大規模イベント（8,000〜10,000接続）対応：現状調査・設計案

作成日：2026-09-28
対象：`cheerstick-large-event-scaling-investigation-20260928.md`（指示書）に基づく調査
性質：**読み取りのみ。`src/`・`public/`・`migrations/`・`package.json`・設定ファイルは
一切変更していない。本番EC2・WebARENAへのSSH、DB接続も行っていない。**
実装は本調査の承認後、別途指示書を出す。

---

## 0. 確認待ちの項目（KMT様のコマンド出力待ち）

指示書3章のコマンドは、本レポート作成時点でまだ出力をいただいていない。
**以下5点は未確認のまま、コードからの推測を書かずプレースホルダとしている。**
出力をいただき次第、該当箇所を更新する。

| # | コマンド | 使う箇所 |
|---|---|---|
| 1 | `grep -rn "limit_req\|limit_conn" /etc/nginx/` | A-1（nginx側で既に何らかのレート制限が入っていないか） |
| 2 | `pm2 show cheerstick-server \| head -40` | B-3（現在の起動モード・メモリ・再起動回数の基礎値） |
| 3 | `sudo -u postgres psql -c "SHOW max_connections;"` | B-2（DB接続数上限との突き合わせ） |
| 4 | `sudo -u postgres psql -d cheerstick_production -c "SELECT count(*) FROM cheer_logs;"` | C（`cheer_logs`の現在の行数、増加ペースの参考値） |
| 5 | `ls /home/ubuntu/cheerstick-server-new/ecosystem* 2>/dev/null; echo done` | B-3（ecosystemファイルの有無） |

---

## 1. 調査結果の要約

### 課題1：レート制限

- 上限は**同一IPあたり15分500リクエストの固定ウィンドウ**（スライディングではない）。対象は`/api/v1`配下全体（観客向け・運営向けの区別なし）と`/health`。WebSocketと静的ファイルは対象外（確認済み）
- `trust proxy 1`はnginx経由の実クライアントIPを正しく見る設計だが、**2026-09-28の準備スクリプト実行では、本番EC2内部から`127.0.0.1`宛に直接叩いたためこの前提が崩れ、429が発生した**（`docs/worklog.md`同日エントリ）。今回の調査対象である「1つのIPに1万人が集約される」ケースは、これと構造的に同じ問題（トラフィックが単一キーに積み上がる）が実際の観客側で起きるという話であり、地続きの課題である
- **結論を先に書く：** 会場Wi-Fiが1つの公開IPに集約される前提でシミュレーションすると（4章）、**たとえ30分かけて平準化しても、現状の定常スループット上限（500回／15分 ≒ 33.3回／分）が観客の到着ペース（10,000人／30分×1〜5回＝333〜1,667回／分）を10〜50倍下回るため、ほぼ全員が429の影響を受ける。** 「集中を避ける」対策では足りず、キー設計自体を変える必要がある

### 課題2：Node.jsシングルスレッド制約

- 2026-09-21の負荷試験（`docs/worklog.md`同日エントリ）で、m5.large・4,000接続時に`cheerstick-server`のCPUが100%に達した事実は確認済み。vCPU数を増やすだけでは解消しない（Node.jsは1プロセス=1スレッドで実行されるため）
- pm2 cluster mode化が本命の対策だが、**WebSocketのセッション管理（`this.sessions`Map）がプロセスごとのメモリに閉じているため、cluster mode化するとStickyなし構成では「同一デバイスの旧接続を切る」処理が機能しなくなる**（B章で詳述）。これは`docs/spec.md` 10.2章で既に「Sticky Session対応が必要になる可能性が高い」と記載済みの懸念だが、今回のコード調査で**その具体的なメカニズムを特定した**

---

## A. レート制限

### A-1. レートリミッターの設定全文（`src/app.js`）

```js
app.set('trust proxy', 1);              // 11行目
...
app.use(helmet());                       // 13行目
app.use(cors({ origin: ... }));          // 14-16行目
app.use(morgan('combined'));             // 17行目
app.use(express.json({ limit: '16kb' })); // 18行目

const limiter = rateLimit({              // 20-25行目
  windowMs: 15 * 60 * 1000,              // 15分
  max: 500,                              // 500リクエスト
  standardHeaders: true,                 // RateLimit-*ヘッダーを返す（draft-7形式）
  legacyHeaders: false,                  // X-RateLimit-*は返さない
});
app.use(limiter);                        // 26行目：パス指定なし＝全リクエストが対象

app.use('/api/v1', routes);              // 28行目：limiterの「後」にマウント
```

| 項目 | 値 | 備考 |
|---|---|---|
| `windowMs` | 900,000ms（15分） | 固定ウィンドウ（`express-rate-limit` v7.5.1の既定アルゴリズム。スライディングではない） |
| `max` | 500 | |
| `keyGenerator` | **未指定＝既定値。** `trust proxy 1`のもとでのクライアントIP（`req.ip`） | nginx経由なら`X-Forwarded-For`の最初の1つ。nginxを経由しない直接アクセス（本番EC2内部からの`127.0.0.1`等）では、その接続元IPがそのままキーになる |
| `skip` | 未指定（常に適用） | 除外ルートは無い |
| `handler` | 未指定（既定のJSON 429応答） | カスタムハンドラなし |
| `store` | **未指定＝既定の`MemoryStore`（プロセス内メモリ）** | **cluster modeでプロセスが増えると、ワーカーごとに別々にカウントされる（B-1で詳述）** |
| 適用位置 | `app.use(limiter)`（パス指定なし）が`app.use('/api/v1', routes)`より前 | `/api/v1`配下すべて（観客向け・管理系とも）と`/health`が対象。静的ファイル配信（`public/`）はExpressの`static`ミドルウェアを使っておらず、そもそも本アプリのExpressサーバーを経由しない（nginxの`root`直配信、`docs/runbook.md`参照）ため対象外 |

`standardHeaders: true`により、レスポンスに`RateLimit-Policy`・`RateLimit-Limit`・
`RateLimit-Remaining`・`RateLimit-Reset`ヘッダーが付く（2026-09-28の429調査で
実際に確認した値と一致）。

### A-2. `src/routes/`配下の全ルート一覧

| メソッド | パス | 公開／管理 | nginx IP制限 | 認証 | DBアクセス |
|---|---|---|---|---|---|
| GET | `/api/v1/webview/geturl` | 公開（観客・起動時） | なし | なし | なし（HTMLリダイレクトのみ） |
| GET | `/api/v1/webview/reference` | 公開（観客） | なし | なし（`ENABLE_REFERENCE_TOKEN=false`時はMAC直指定。トークン方式は無効化中） | あり（4クエリ：MAC→device_id、プロフィール、直近3件、全期間合計） |
| GET | `/api/v1/event-battles/:id/score` | 公開（会場スクリーン・`battle.html`） | なし | なし | あり（3クエリ：メタデータ1＋SUM集計2、A-4参照） |
| GET | `/api/v1/events/:id/target-scores` | 公開（会場スクリーン・`target-report.html`） | なし | なし | あり（JOIN+GROUP BY、event_id絞り込み） |
| GET | `/api/v1/target-scores` | 公開（`target-report.html`、非ポーリング） | なし | なし | あり（**JOIN+GROUP BY、絞り込み無し＝全期間全件**） |
| GET | `/api/v1/events/:eventId/ranking-snapshots/latest` | 公開（会場スクリーン・`ranking-user.html`/`ranking-target.html`） | なし | なし | あり（事前計算済みスナップショットのSELECT。集計はしない） |
| GET/POST/PATCH/DELETE | `/api/v1/admin/*` | 管理 | **あり**（オフィスIP限定、`docs/runbook.md`） | なし（既知の課題、`docs/spec.md` 11章） | あり |
| POST/GET | `/api/v1/events` | **事実上の死んだコード** | なし | なし | 実スキーマと不一致で失敗する見込み（`docs/spec.md` 11.5章） |
| GET | `/api/v1/user/cs_user` | 未使用（現行フロントエンドから呼ばれていない） | なし | なし | あり（`src/store/deviceStore.js`、プロセス内メモリ） |
| POST | `/api/v1/game/control` | 同上 | なし | なし | 同上 |
| POST | `/api/v1/cheer/device` | 同上 | なし | なし | 同上（`wsServer.sendToDevice`も使用） |
| GET/POST/GET/PATCH | `/api/v1/devices*` | 未使用（現行フロントエンドから呼ばれていない。管理系は`/admin/devices`が別途ある） | なし | なし | あり |
| WebSocket | `/cheer`（`connect`/`register`/`select_team`/`set_oshi`/`count`） | 公開（観客） | 対象外（`app.use(limiter)`はExpressのミドルウェアチェーンのみに適用され、`ws`ライブラリが`http.Server`の`upgrade`イベントに直接アタッチするWebSocketは通らない。既に2026-09-28に確認済み） | なし | あり（`count`ごとに1 INSERT、C章参照） |

`user.js`・`game.js`・`cheer.js`・`events.js`・`devices.js`（`/api/v1/devices`側、
管理用`/admin/devices`とは別）は、`public/`配下の全ページを`grep`した結果、
**いずれも現行フロントエンドから呼ばれていない**（旧Node-RED版WebView時代の
名残とみられるが出所は未追跡）。レート制限の設計を検討する上では、
「観客が実際に使うルート」から除外してよい。ただし`deviceStore`（後述B-1）を
使っている点は cluster mode の観点で一応記録した。

### A-3. 観客1人あたりのAPI呼び出し回数（コードから静的に算出）

`public/index.html`のWebSocketメッセージハンドラは`type: 'connect'`と`type: 'error'`
の2種類しか処理しない（609-626行目）。サーバー側は`register`・`select_team`・
`set_oshi`のいずれの応答も`buildConnectResponse()`（`type: 'connect'`を再利用、
`src/websocket/index.js` 213-253行目）で返す設計のため、**`status`が`'complete'`
（`owner_user_id`・`selected_organization_id`・`current_target_id`がすべて揃った状態、
93-103行目）になった瞬間に1回だけ**`loadCheerStats()`（789行目）が呼ばれ、
`GET /api/v1/webview/reference`が発火する（875行目）。

| タイミング | 呼び出し | 回数（HTTPのみ。WebSocketはレート制限対象外） |
|---|---|---|
| アプリ起動時（ネイティブアプリ→WebView） | `GET /api/v1/webview/geturl` | **1回**（固定） |
| WebSocket接続確立時 | `connect`送信（WS、対象外） | 0 |
| 登録・チーム選択・推し選択が揃った瞬間 | `GET /api/v1/webview/reference` | **1回**（初回セッション中に1回のみ。既に完了済みの再来場者は最初の`connect`応答時点で発火） |
| 応援中 | `count`送信（WS、対象外、5秒間隔目安） | 0 |
| **自動再接続のたび**（指数バックオフ2秒→最大10秒、628-643行目） | `connect`を再送信→`status`が`complete`なら`reference`が**再度**発火 | **再接続回数と同数** |
| 終了時 | 明示的なAPI呼び出しなし（WebSocket close） | 0 |

**結論：** 通信が安定していれば、観客1人あたりのHTTP呼び出しは**geturl 1回＋reference
0〜1回＝1〜2回**で、KMT様の「通常は1回」という想定と概ね一致する（新規登録者は
1回、登録済みの再来場者は2回）。ただし**自動再接続のたびに`reference`が再度呼ばれる
ことをコードで確認した**（指示書A-3の質問に対する回答）。会場Wi-Fi・BLEが不安定な
環境では、1人が数十分の応援時間中に複数回再接続し、そのたびに1リクエストが
追加される可能性がある。この上振れ分は「観客の意図的な操作」ではなく
「通信品質に応じて自動的に増える」ため、設計上は保守的に見ておくべき。

**会場スクリーン用ページ（1タブあたり15分の回数）：**

| ページ | ポーリング対象 | 間隔 | 15分あたり |
|---|---|---|---|
| `battle.html` | `/event-battles/:id/score` | 3秒 | 300回 |
| `target-report.html`（試合ごと） | `/events/:id/target-scores` | 3秒 | 300回 |
| `target-report.html`（全期間） | `/target-scores` | 読み込み時1回＋手動更新のみ | 実質0（ポーリングなし） |
| `ranking-user.html` | `/events/:eventId/ranking-snapshots/latest?rankingType=user` | 3秒 | 300回 |
| `ranking-target.html` | 同上（`rankingType=target`） | 3秒 | 300回 |

いずれも1タブ300回／15分で、**同一IPから2タブ以上開くと単独で429の主要因になりうる**
（2026-09-28にコードとして確認済み。`scripts/demo/README.md`・
`docs/tasks/2026-09-28-battle-demo-phase4.md`に運用注意として反映済み）。

### A-4. 1つのIPから10,000人が接続する場合のシミュレーション

**前提：** 固定ウィンドウ500req/15分。観客の呼び出しは上記A-3のとおり1人あたり
1〜2回（reconnectを除く）だが、指示書の指定どおり1・2・5回のケースで計算する。
ウィンドウは到着開始時刻に揃うと仮定した単純化計算（実際はウィンドウ境界と
到着タイミングのずれで多少前後する）。

**ケース1：開始前5分間に全員が開く（5分 < 15分＝1ウィンドウに収まる）**

| 1人あたりの呼び出し回数 | 429になり始める人数 | 備考 |
|---|---|---|
| 1回 | **500人目** | 501人目以降は`geturl`自体が429になり、WebViewが開けない（アプリ起動失敗） |
| 2回 | **250人目**（の2回目） | 251人目は1回目（geturl）は通るが2回目（reference）で429の可能性 |
| 5回 | **100人目** | |

**ケース2：30分かけて徐々に開く（一様到着、10,000人÷30分＝約333.3人/分）**

固定ウィンドウは「到着ペースが平準化されているか」ではなく「そのウィンドウ内に
何リクエスト入るか」で決まるため、**結論はケース1とほぼ同じ**になる。
最初の15分間だけでも約5,000人（10,000人×15/30）が到着し、1人1回なら5,000
リクエストが発生するが、上限は500なので、**最初のウィンドウ内で500人目
（同じく1回あたり500・250・100人目）に到達した時点で429が始まり、以降はウィンドウが
切り替わるたびに次の500req分だけ通る、という状態が続く。**

**全員のリクエストを通し切るのに必要な時間（自動リトライが無い前提。実際は
リトライしないため、通らなかった人はそのまま失敗する）：**

| 1人あたり回数 | 総リクエスト数 | 必要ウィンドウ数（500req/window） | 目安時間 |
|---|---|---|---|
| 1回 | 10,000 | 20 | 300分（5時間） |
| 2回 | 20,000 | 40 | 600分（10時間） |
| 5回 | 50,000 | 100 | 1,500分（25時間） |

**結論：** 「30分かけて平準化する」という緩和策は、定常スループット上限
（500req/15分＝約33.3req/分）そのものを引き上げない限りほぼ効果がない。
観客の到着ペース（333〜1,667req/分、回数によって変動）が上限を10〜50倍
上回っているため、**ケース1・2のどちらでも、最初の100〜500人目以降は
即座に429の影響を受け始める。** これは「アクセス集中を避ける」運用上の工夫では
解決できず、**キー設計（IPからデバイスIDへ）か上限そのものの引き上げ・別枠化が
必須**という結論になる。

### A-5. 対策の設計案（実装はしない）

優先度つきで4章にまとめる（A-5はB章の結論と合わせて重複を避けるため、
4章「対策の設計案」に統合した）。

---

## B. cluster mode・大規模接続（8,000〜10,000）への対応

### B-1. プロセス内メモリに持っている状態の洗い出し

| 状態 | 場所 | cluster modeでの影響 |
|---|---|---|
| **`this.sessions`（Map、MAC→WebSocket）** | `src/websocket/index.js` 145行目 | **最重要。** 「同一デバイスの旧接続をcode 4000で切る」処理（178-185行目、2026-09-20実装）が、この`sessions`Mapへの`get`/`set`のみで動いている。Node clusterはワーカーごとに別プロセス＝別メモリのため、**再接続が別ワーカーに着地すると、旧ワーカー上の古い接続をこの仕組みでは検知できない。** 旧接続はその後もそのワーカー上で生き続け、90秒のハートビートタイムアウト（後述）で自然にreapされるまで「幽霊接続」として残る。既知の11.10章の問題（幽霊接続）が、cluster mode下では別の経路（プロセス跨ぎ）で再発する形になる |
| `sendToDevice`・`broadcast`・`getConnectedDevices` | 同ファイル 354-374行目 | `sessions`Mapに依存するため同上の制約を受けるが、**現状どの公開ルートからも呼ばれていない**（`sendToDevice`は未使用の`/api/v1/cheer/device`からのみ）。将来「応援演出のプッシュ配信」等で使う場合は要対応（クラス冒頭コメントに将来用途の記載あり） |
| ハートビート（`this.heartbeatInterval`） | 同ファイル 328-345行目、30秒間隔・90秒タイムアウト | **プロセスごとに独立して動くため、cluster mode自体には問題ない。** 各ワーカーが自分の管理する接続だけを見る設計で、他ワーカーの接続には関与しない |
| レートリミッターのストア（`express-rate-limit`のMemoryStore） | `src/app.js` 20-25行目 | A-1で確認済み：`store`未指定＝プロセス内メモリ。**cluster modeでは実質の上限がワーカー数倍になる**（N workerなら理論上N×500req/15分。ただしOS/Nodeのラウンドロビンが完全均等でない場合は前後する） |
| `deviceStore`（`this.devices`Map） | `src/store/deviceStore.js` | A-2で確認済み：`user.js`/`game.js`/`cheer.js`（現行フロントエンドから未使用）専用。cluster modeで壊れるが、**現状使われていないため実害はない**。将来これらのルートを使う計画があれば要注意 |

**B-1のまとめ：** cluster mode化の最大の技術的課題は、指示書が想定していたとおり
`sessions`Mapのプロセス跨ぎ問題である。**Sticky Session（同一デバイスを常に
同じワーカーへ振り分ける）が実質的に必須**という`docs/spec.md` 10.2章の結論を、
具体的なコード箇所（178-185行目）で裏付けた。

### B-2. DBの接続数

`src/db/index.js`：

```js
const pool = new Pool({
  ...
  max: 20,   // コメント：「2000デバイス想定 — Render無料プランの上限に合わせて調整」
  ...
});
```

`max: 20`は**1プロセスあたり**の値（`pg.Pool`はプロセス内で完結するオブジェクトのため）。
cluster modeでN workerになると、DB接続数は最大`20 × N`（＋`psql`等の対話的接続、
`pg_dump`実行時の一時的な1接続）になる。コメントにある「Render無料プランの上限」は
**現行のAWS EC2自社管理構成とは無関係な、過去のホスティング先を前提にした値**で
あり、cluster mode化のタイミングで見直すべき値である。

PostgreSQLの`max_connections`の実際の値は、指示書3章のコマンド（`SHOW max_connections;`）
の出力待ち（0章参照）。**一般的な既定値は100**だが、本番で変更されている可能性がある
ため未確認のまま断定しない。既定値100だとすると、`max: 20`のままworker数4以上で
80接続に達し、余裕が少なくなる（`pg_dump`等の一時接続やadmin系の対話接続を
考慮すると、worker数を上げる際は`max`を`20`から`10`程度へ下げるか、
`max_connections`自体を引き上げる検討が必要）。

### B-3. pm2の起動方式

- 現状は`fork`モード（`docs/runbook.md`「稼働プロセス」節、`pm2 list`の表示）
- **リポジトリ内に`ecosystem.config.js`は存在しない**（`git`管理下を確認済み。
  `package.json`の`scripts.start`は`node src/index.js`のみで、pm2固有の設定は
  含まれていない）。本番EC2上に存在するかは指示書3章のコマンド（`ls ecosystem*`）の
  出力待ち
- cluster mode切り替えの起動コマンド例（**実装時の参考。今回は実行しない**）：
  ```bash
  pm2 delete cheerstick-server
  pm2 start src/index.js --name cheerstick-server -i <N>   # -i max で論理コア数分
  pm2 save
  ```
  `pm2 startup`は2026-09-06に設定済み（`docs/runbook.md`）であり、`pm2 save`を
  実行すればcluster mode構成もsystemd経由の自動復帰に反映される見込み（未検証）

### B-4. nginxとの関係（Sticky Sessionの要否）

**指示書の前提を1点補正する。** nginxは現状`http://127.0.0.1:3000`という
**単一のアップストリーム**にプロキシしており（`sites-available/cheerstick-api`等、
`docs/runbook.md`）、pm2 cluster modeは複数プロセスであっても**同じポート3000を
共有する**（Node.jsの`cluster`モジュールが、マスタープロセスで受けた接続を
ワーカーへ内部的に振り分ける仕組みのため）。つまり、

- **nginx側にSticky Session設定（`ip_hash`等）を追加する余地は無い**（そもそも
  アップストリームが1つしかないため、nginxの視点では「複数ワーカーがある」ことが
  見えない）
- 「Sticky Session」が必要だとすれば、それは**Node.jsの`cluster`モジュール自身が
  持つワーカー振り分けの仕組み**に対して行う必要がある（例：`cluster`のデフォルトの
  ラウンドロビン振り分けではなく、接続元やメッセージ内容でワーカーを固定する
  カスタム実装。あるいはpm2/Node cluster自体にはMACアドレス単位の振り分け機能は
  無いため、実現には追加の設計・実装が必要）
- 現実的な選択肢は2つ：
  1. **Sticky Session無しでcluster mode化し、B-1の`sessions`Map分断を許容する**
     （幽霊接続はハートビートの90秒タイムアウトで自然に解消される前提。
     10.2章が提案する「まずSticky無しで検証」方針と一致）
  2. 何らかの形でMACアドレス単位の振り分けを実装する（追加の設計・実装コストが
     大きく、今回の調査範囲では設計しない）

**B-1の`sessions`Map以外に「再接続が別ワーカーに着くと壊れる」処理は無い**
（ハートビートはワーカーごとに独立、DBアクセスは毎回クエリを投げる設計で
プロセス内状態に依存しない）ことをB-1で確認済みのため、**当面は選択肢1（Sticky無し）
で様子を見る運用が現実的**という結論になる。

### B-5. vCPU数とプロセス数

- 2026-09-21の実績：m5.large（2 vCPU）・4,000接続でCPU 100%（`docs/worklog.md`）
- ネイティブ依存のnpmパッケージは無し（`package.json`の全依存を確認。`cors`・
  `dotenv`・`express`・`express-rate-limit`・`helmet`・`jsonwebtoken`・`morgan`・
  `multer`・`pg`・`uuid`・`ws`はいずれも純JS。`pg-native`のような任意のネイティブ
  拡張も導入していない）ため、**Graviton（ARM、m6g/m7g）でも動作する見込み**
- nginx側の同時接続上限も、vCPU数と連動する点に注意が必要：`worker_processes`が
  `auto`の場合、ワーカー数はvCPU数に一致する。2026-09-27時点の設定
  （`worker_connections 8192`）だと、**2 vCPU構成では合計16,384ソケット分の余裕
  しかなく、10,000 WebSocket接続（1接続でクライアント側・アップストリーム側の
  2ソケットを消費、`docs/worklog.md` 2026-09-27エントリの既知の計算方法）＝20,000
  ソケットには届かない。** 4 vCPU（m5.xlarge等）にすれば32,768ソケットとなり
  余裕が生まれる。**cluster modeのプロセス数だけでなく、nginx側のworker数も
  インスタンスサイズと連動して見ておく必要がある**（今回のコード調査で新たに
  見つけた論点。`worker_processes`の実際の設定値は本調査では未確認）
- インスタンス候補：

  | 候補 | vCPU | 想定pm2プロセス数 | 備考 |
  |---|---|---|---|
  | m5.xlarge | 4 | 3（nginx・PostgreSQLとの同居分を1コア残す） | 現行構成からの最小の変更幅 |
  | m5.2xlarge | 8 | 6〜7 | より安全マージン重視 |
  | m6g.xlarge/m7g.xlarge（Graviton） | 4 | 3 | 同スペックでコスト2〜3割減の可能性（`docs/spec.md` 10.2章）。ネイティブ依存が無いため候補として有効 |
  | c5.xlarge系（コンピューティング最適化） | 4 | 3 | メモリ比率がm5系より低い。cheer_logsの増加でメモリ余裕が必要な場合はm5系を優先 |

- **PostgreSQLを同一EC2に置いたままでよいか：** 本プロジェクトはRDS不使用の方針
  （`CLAUDE.md`）。cluster mode化でNodeプロセスが増えるとCPU・DB接続数の両面で
  PostgreSQLとの資源競合が強まるため、**「1イベント限定」の単発対応としては
  同居を維持しつつ、検証計画（B-6）でPostgreSQL側のCPU・IO・接続数を
  `monitor-server.sh`で監視し、ボトルネックが実際に観測された場合のみ分離を検討する**
  のが現実的（常時分離インフラを増やすコストと、単発イベント対応という前提が
  見合わない）

### B-6. 検証計画（案）

1. **一時インスタンス**：本番AMIの複製で、cluster mode（`-i 2`〜`-i 4`程度から開始）
   を試す。2026-09-21の負荷試験（`docs/worklog.md`）と同じ「専用DB
   `cheerstick_loadtest`・本番から切り離した`.env`」の方式を踏襲する
2. **負荷の発生元**：WebARENA VPS（8 vCPU・32GB、`docs/runbook.md`
   「WebARENA デモ実行環境」）。`scripts/load-test/load-test.js`が1プロセスで
   扱える接続数の目安は2026-09-21実績で確認済み（`docs/worklog.md`参照）。
   8,000〜10,000接続を1プロセスで出せない場合は、`load-test.js`を複数プロセス
   （`--mac-prefix`を分けて並列起動）で分散する。ファイルディスクリプタ上限
   （現状`ulimit`は`scripts/demo/README.md`の`cheerdemo`ユーザー設定＝8192。
   10,000接続には不足するため引き上げが必要）・エフェメラルポート上限
   （`net.ipv4.ip_local_port_range`、WebARENA側も要確認）の両方を事前に確認する
3. **段階**：4,000（現状との比較用ベースライン）→6,000→8,000→10,000
4. **監視項目**：`scripts/demo/monitor-server.sh`の既存項目（load・CPU内訳
   〔steal含む〕・メモリ・ポート3000の接続数・pm2再起動回数・PostgreSQLの
   プロセス数）に加え、**プロセスごとのCPU**（cluster modeでは複数の
   `cheerstick-server`プロセスが並ぶため、`pm2 jlist`から個別に取る必要がある。
   `monitor-server.sh`は現状「1プロセス」前提でpm2の値を取得している箇所
   〔`grep -o`で最初の1件のみ拾う実装〕があり、cluster mode検証時は改修が必要）
5. **「観客が一斉にアプリを開く」場面の再現**：`geturl`を1つのIPから大量に呼ぶ
   シナリオは、現行の`scripts/demo/battle-demo.js`には無い（`connect`→
   `select_team`→`count`のWebSocketシーケンスのみで、`geturl`のHTTP呼び出しは
   含まれていない）。**新規に、`geturl`（および必要なら`reference`）を指定台数分
   同一送信元から一斉に叩く軽量スクリプトを追加することを提案する**
   （`battle-demo.js`とは別の、レート制限検証専用の小さいスクリプトの想定。
   実装はKMT様承認後）

---

## C. あわせて気づいた懸念

- **DBのINSERT性能：** `count`メッセージは`insertCheerLog()`
  （`src/db/cheerstickQueries.js` 283行目）で1メッセージ=1 INSERT、バッチ化は
  していない（`docs/spec.md`「10. 未実施の検証」に既存の記載あり）。実機の送信間隔
  （応援合戦デモでの目安は5秒、`docs/spec.md`5.1章のBLE側は1秒間隔）を仮に5秒とすると、
  10,000接続で**最大2,000 INSERT/秒**の持続負荷になりうる。単発イベント・短時間の
  想定でも、同居するPostgreSQL・nginxとのCPU/IO競合を考えると、バッチINSERT
  （一定間隔でまとめてINSERT）の検討価値がある
- **スコア系APIの集計クエリがイベント進行とともに重くなる：**
  `getEventIntensityTotal()`（`event-battles`スコアAPI、`event_id`にインデックス
  `idx_cheer_logs_event_id`あり）・`getEventTargetScores()`（`target-scores`、
  同じく`event_id`で絞り込み）は、**インデックスで対象行には絞れるが、SUM自体は
  毎回その時点までの全該当行を再集計する設計**（インクリメンタル集計やキャッシュは
  無い）。イベントが進むほど対象行数が増えるため、3秒間隔ポーリング×複数画面が
  重なると応答が遅くなっていく懸念がある。**指示書A-5で触れられている「1秒程度の
  プロセス内キャッシュ」は、レート制限対策だけでなくこのDB負荷対策としても有効**
  （同じ改修で両方に効く）
- **`getAllTimeTargetScores()`（`/api/v1/target-scores`）はWHERE句が無く、
  `cheer_logs`全件を対象にJOIN+GROUP BYする。** ポーリング対象ではない
  （読み込み時1回＋手動更新のみ）ため頻度は低いが、シーズンが進み`cheer_logs`が
  累積するほど1回あたりのコストは増える。将来的に定期実行のスナップショット化
  （`ranking_snapshots`と同じ設計パターン、8.9章参照）を検討する価値がある
- **ディスク容量：** `docs/spec.md` 10.1章の実測（2026-09-17時点）で、t3.microの
  ルートディスクは6.8GB中3.6GB（53%）使用済み。`cheer_logs`の行数増加ペースは
  指示書3章のコマンド（`SELECT count(*) FROM cheer_logs`）の出力待ち（0章）
- **ログの量：** `morgan('combined')`が`/api/v1`配下の全HTTPリクエスト
  （WebSocketの`count`等は含まない）をアクセスログに残す。geturl・reference・
  スコア系ポーリングの合計で、10,000接続規模だと相応の量になる見込み
  （具体的な行数は今回計算していない。ログローテーション設定の確認を優先度低めの
  追加調査項目として記録する）
- **優先度の提案（依存関係を含む）：**
  1. **レート制限のキー設計変更**（A-5、4章）：cluster modeより先に着手できる、
     最も緊急性が高い項目。現行の1プロセス構成のままでも有効な対策
  2. **スコアAPIの短時間キャッシュ**：1と同じ改修範囲で実装でき、DB負荷の懸念（C章）
     も同時に緩和する。1とセットで進めるのが効率的
  3. **cluster mode化＋Sticky無しでの検証**：2026-09-21の実績（4,000接続でCPU
     100%）を踏まえると8,000〜10,000には避けて通れないが、B-1〜B-4の設計論点が
     A系対策より多く、検証にも時間がかかるため2番目以降が現実的
  4. **DBのバッチINSERT化**：3と並行して検証可能。ただし`count`のリアルタイム性
     （スコア表示への反映速度）とのトレードオフがあるため、要件をKMT様と
     すり合わせてから着手
  5. **インスタンスサイズ・nginx worker数の見直し**：3の検証結果を踏まえて
     最終決定する（先に決め打ちしない）

---

## 4. 対策の設計案（A-5、優先度つき）

### 案1：観客向けの入口をデバイスID単位で数える（優先度：高）

- **キーの取り出し方：** `geturl`は`?id=<MAC>`のクエリで受け取っている
  （`webviewController.js`）。`reference`も同様（`?id=`または`?token=`）。
  クエリパラメータからMACアドレスを取り出し、`keyGenerator`でこれをキーにする案
- **IDが無い・偽装された場合の扱い：** 現状`connect`同様、MACアドレスの真正性を
  検証する仕組みは無い（`docs/spec.md` 11.1章「デバイス認証機構が無い」と同根の
  問題）。したがって「IDベースの制限」は不正なMAC連番による突破を防げない。
  **IPベースの制限を完全に置き換えるのではなく、「IDがあればIDベース（緩め）、
  無ければIPベース（厳しめ）」の併用が現実的**（後述の案2とセット）
- 影響範囲：`src/app.js`の`limiter`の`keyGenerator`実装追加のみ。既存ルートの
  変更は不要

### 案2：IPごとの上限を残しつつ、値を引き上げる（優先度：高、案1とセット）

- 4章A-4の計算から、1万人・1〜5回のアクセスを1つのIPで許容するには、
  **少なくとも「10,000人×最大呼び出し回数」を1ウィンドウで許容できる値**が必要
  になる（例：1人5回・15分想定なら50,000/15分）。ただし上限を極端に緩めると
  不正アクセス対策としての意味が薄れるため、**案1（IDベース）で観客の正規トラフィックを
  別枠に逃がし、IPベースの上限は「異常な集中を検知する最終防波堤」として
  現実的な値（数千〜1万程度）に据え置く**組み合わせが望ましい
- トレードオフ：IPベースの上限を上げるほど、単一の悪意ある送信元からの
  DoS的な連打に対する防御は弱くなる。会場Wi-Fiという性質上、1万人分の
  トラフィックと悪意ある大量アクセスを区別する手段は現状無い

### 案3：スコアAPIを別枠にし、サーバー側で短時間キャッシュする（優先度：高）

- 対象：`/event-battles/:id/score`・`/events/:id/target-scores`・
  `/target-scores`・`/events/:eventId/ranking-snapshots/latest`
- **別枠にする根拠：** これらは観客の操作に依存しない「会場スクリーン」専用の
  ポーリングであり、A-3の表のとおり1タブ300回/15分と単価が高い。観客本人の
  操作（geturl・reference）とは性質が異なるため、別のレートリミッター
  インスタンス（`express-rate-limit`を複数登録すれば可能）で管理するのが自然
- **キャッシュしてよい根拠：** これらのAPIは**呼び出し元に関わらず同じ`event_id`
  ／`battle_id`に対して同じ応答を返す**（個人化されたレスポンスではない）。
  3秒間隔でポーリングされている実態を踏まえると、**1秒程度のプロセス内キャッシュ
  （`event_id`をキーにした単純なメモリキャッシュ、TTL 1秒）を挟んでも、
  画面の更新頻度（3秒）に対して鮮度の劣化は誤差の範囲**（最大1秒の遅延が
  3秒間隔の表示に混ざる程度）
- **鮮度の影響：** `count`の反映がキャッシュのTTL分だけ遅れる。1秒程度なら
  会場演出として問題にならないと考えられるが、最終的な値はKMT様と相談
- cluster mode化した場合、このキャッシュもプロセスごとに独立する（B-1と同じ
  制約）。ワーカー間で完全に一致した値にはならないが、TTLが短ければ実用上の
  差は小さいと考えられる

### 案4：管理APIを枠から分ける（優先度：中）

- 管理API（`/api/v1/admin/*`）は既にnginxでオフィスIPに限定されている
  （`docs/runbook.md`）ため、観客側の集中とは別の送信元になる。**副作用としては、
  管理API専用の別リミッター（例：オフィスIPからは緩め、または対象外）を作る際、
  `location /api/v1/admin/`のIP制限とレートリミッターのキー生成が同じ
  `trust proxy`前提に依存している点を崩さないよう注意する**（IP制限自体は
  nginx側の設定であり、Expressのレートリミッターとは独立した仕組みだが、
  「管理APIを緩める」実装をExpress側に入れる場合、経路の判定をnginxのIP制限に
  依存させるかパスで判定するかの設計が必要）

### 案5：上限値・ウィンドウを環境変数化（優先度：高、実装コストが最も小さい）

- `windowMs`・`max`を`.env`の`RATE_LIMIT_WINDOW_MS`・`RATE_LIMIT_MAX`のような
  変数から読み込む設計に変更し、イベント直前に値を変えて`pm2 restart --update-env`
  で反映できるようにする。**案1〜4の実装を待たずに単独で着手できる**、最も
  シンプルな対策。ただし単独では4章冒頭の結論（IPキーである限りスループット
  上限を引き上げても焼け石に水になりやすい）を覆せないため、案1・3とセットで
  検討することを推奨する

### 既存クライアント（Vanstone様ネイティブアプリ）への影響確認

- レスポンスヘッダー（`RateLimit-Policy`等）の変更や、429時のエラー応答形式
  （現状`express-rate-limit`の既定JSON）を変える場合、ネイティブアプリ側が
  これらを解釈していないか確認が必要。**現状`geturl`はネイティブアプリが
  `meta refresh`をたどるだけの単純な呼び出しであり、レスポンスヘッダーや
  エラーボディの形式に依存した処理は無いと推測されるが、Vanstone様側の実装は
  こちらのコードからは確認できないため、KMT様経由でVanstone様に
  「429時の挙動変更予定がある」旨を事前共有することを推奨する**

---

## 5. cluster modeの可否

**可能。ただし前提が3つある。**

1. **Sticky Session無しで進める（B-4の結論）。** `sessions`Map分断による
   幽霊接続の残存は、既存のハートビート機構（90秒タイムアウト）で自然に
   解消される設計に既になっているため、致命的な障害にはならないと考えられる。
   ただし「同一デバイスの旧接続を検知して切る」という2026-09-20の対策の効果が
   部分的に失われる点は、KMT様に許容いただく必要がある
2. **DB接続数の見直し（B-2）。** `max: 20`（1プロセスあたり）は過去のホスティング
   環境を前提にした値であり、cluster mode化時はworker数に応じて引き下げる
   （または`max_connections`側を引き上げる）調整が必要。実際の`max_connections`は
   0章の確認待ち
   
3. **レートリミッターの実質上限が変わる点の理解（B-1・A章）。** cluster mode化
   すると、IPベースの上限が事実上ワーカー数倍になる。A章の対策（案1〜3）を
   先に、または同時に実施しないと、cluster mode化だけでは429問題は解決しない
   （むしろ「何人目で429になるか」の数字が変わるだけで、根本問題は残る）

**追加の作業：**
- `ecosystem.config.js`の新規作成（起動コマンドの一元管理、`pm2 save`との整合）
- `monitor-server.sh`のcluster mode対応改修（B-6参照）
- レート制限対策（A章）との実装順序の調整（4章の優先度どおり、A章を先行させることを推奨）

---

## 6. 検証計画の案（再掲・要約）

B-6の詳細のとおり。要約すると：

1. 本番AMI複製の一時インスタンスでcluster mode化（`-i 2`〜`-i 4`から）
2. WebARENA VPS（8 vCPU・32GB）から負荷発生。`ulimit`・エフェメラルポート上限の
   事前引き上げが必要
3. 4,000→6,000→8,000→10,000の段階実施
4. `monitor-server.sh`の改修（プロセスごとのCPU取得）を先に行う
5. 「観客一斉起動」再現用の新規軽量スクリプトを追加（KMT様承認後）

---

## 変更履歴

- 2026-09-28：初版作成（読み取り専用調査、`cheerstick-large-event-scaling-investigation-20260928.md`に基づく）。0章の5項目はKMT様の本番コマンド出力待ち
