# 単独イベント用の順位発表を `ranking-battle.html` に統合する案（将来の拡張候補）

作成日：2026-10-07。**未実装・今回は対応しない。** 1月の8,000人規模イベントで、男子・女子チームの単独イベントフェーズも対抗戦と同じリッチな表示にしたい可能性があるため（岩村様）、候補として記録する。実施するかは、契約・イベント内容の確定後に判断する。

## 1. 背景

- 対抗戦（2チーム）の順位発表は `public/ranking-battle.html`（`view=target`／`view=user`、`docs/spec.md` 9.14章）で、冠・顔写真・チームカラー・背景画像・スポンサー枠・テーマ画像に対応している。
- 対抗戦を組まない**単独イベント**の順位発表は、従来の `public/ranking-user.html`・`public/ranking-target.html`（9.11章）のまま。これらは最小実装で、**冠・選手の顔写真・チームカラー・装飾枠がない**（`docs/worklog.md` 2026-09-24に「演出面の調整は未実施」と記録）。
- 8,000人規模イベント（`docs/proposals/handoff-2026-10-06.md`）は「男子チーム（通常使用）→ スポンサー対抗 → 女子チーム（通常使用）」の構成案で、男子・女子は単独イベント。スポンサー対抗だけが対抗戦で、男子・女子のフェーズは現状だと見劣りする画面になる。
- 2026-10-07の整理では、旧2画面は「単独イベント用」として残す方針とした（`docs/worklog.md` 2026-10-07「続き6」）。本案は、その旧2画面を将来的に置き換える（引退させる）選択肢。

## 2. 案

`ranking-battle.html` に**単独イベントモード**を足す。

```
ranking-battle.html?event_id=<試合ID>&view=target|user[&top=20]
```

- `battle_id`の代わりに`event_id`が指定されたとき、1チームだけを全幅（または中央）に表示する。冠・写真・チームカラー・背景画像・スポンサー枠は、対抗戦と同じ部品を使う。
- `view`（推し選手／応援ユーザー）の出し分けと`top`（既定10・最大20）も同じ仕様。
- ヘッダーは、その試合の`events.metadata.themeImageUrl`（無ければチームロゴ）。装飾枠（`rankingBackgroundUrl`・`sponsorLogoUrl`）も同じキーを読む。

## 3. 必要な変更

| 項目 | 内容 |
|---|---|
| API | 単独イベント用の閲覧GETが**必要**。既存の`GET /events/:eventId/ranking-snapshots/latest`は画像・チーム情報を返さず、`ranking-user/target.html`が使っているため**変更しない**。新規GET（例：`/events/:eventId/ranking-snapshots/latest-detail`）で、最新スナップショット（ユーザー別・選手別）、選手の画像・背番号、チームの名前・ロゴ・色、`decor`、テーマ画像を返す。実装は`getLatestBattleRankingSnapshot`（`src/db/cheerstickQueries.js`）と`getEventBattleMeta`の考え方を流用でき、DBスキーマ変更は不要の見込み。レート制限・短時間キャッシュは、スコア系ルーターの設定を継承させる（`docs/spec.md` 12章） |
| 画面 | `ranking-battle.html`に、`event_id`指定のときの1チーム表示。左右2パネル前提のレイアウト・再描画の判定（署名）を、1チームでも動くように一般化する |
| 管理画面 | `ranking-control.html`の「単独イベント用」のURL欄を、新モードのURL（`view=target`・`view=user`の2本）へ差し替える（または併記） |
| 旧2画面 | 新モードに切り替えた後、`ranking-user.html`・`ranking-target.html`を削除し、`docs/spec.md` 9.11章・`docs/runbook.md`のデプロイ記述・`docs/proposals/large-event-scaling.md`の画面一覧を整理する。`public/`・本番の`/var/www/cheerstick-app/`の両方から削除（デプロイ手順の2箇所問題に注意） |

## 4. 考慮事項

- **選手がいないチーム・誰も推されなかったチーム**は、選手別が0件になる（対抗戦と同じ扱いで、案内文を表示）。
- **8,000人規模での確定時間**（確定1回に数秒〜約25秒の見込み、`docs/proposals/ranking-battle-future-scaling.md`）は、この案とは独立の課題。単独イベントで実施する場合も同じ影響を受ける。
- 検証は、対抗戦の画面と同様に、pg-mem（ローカル）と、**stagingの実PostgreSQL**（新規GETのSQL）で行う。
- 旧2画面を削除する前に、**本番での使用実績を再確認**する（2026-10-07時点では、実イベントでの使用実績はなし。`docs/worklog.md`参照）。

## 5. 規模感と判断のタイミング

- 規模：小〜中（新規GET 1本＋`ranking-battle.html`の単独モード＋`ranking-control.html`の差し替え）。
- 判断のタイミング：1月の8,000人イベントの契約が確定し、男子・女子フェーズも対抗戦と同じ見せ方にしたいと決まった時点。それまでは、旧2画面を単独イベント用として使う（現状維持）。
