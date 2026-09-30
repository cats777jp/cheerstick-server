# トラックB-① 効果測定計画メモ（`CHEER_LOG_WRITE_MODE` legacy vs cached）

作成日：2026-09-30
性質：**計画のメモのみ。本書作成時点では実行していない。** 本番反映・負荷試験の実施と
`cached`モードへの切り替え判断は、別途指示を受けてから行う。
関連：`docs/spec.md` 12.6章、`scripts/demo/README.md`、`scripts/demo/monitor-server.sh`

---

## 0. 目的

`CHEER_LOG_WRITE_MODE=cached`（DB往復 3→1）が、`legacy`と比べてCPU負荷を実際に下げるかを、
同一条件で比較する。効果が確認できなければ`legacy`のまま運用を続ける（`.env`で戻せる）。

## 1. 比較条件（両モードで揃えること）

- 負荷発生：WebARENA VPSから`battle-demo.js`（`docs/runbook.md`「WebARENA デモ実行環境」）。
  接続数は各100〜500台×2から段階的に。**両モードで同じ台数・同じ時間**とする
- 試合は`live`にして実行する（`live`なしの0往復パスはCPUではなく空振り側の確認になるため、
  比較の主対象はlive試合あり＝3→1）
- 実行順序：`legacy` → `cached` → `legacy`（時間経過・キャッシュ状態の影響を見るため、
  可能なら`legacy`を2回はさむ）
- 切り替え：`.env`の`CHEER_LOG_WRITE_MODE`を変更し`pm2 restart cheerstick-server --update-env`。
  起動ログの`[WS] cheer-log-write config: mode=...`で、意図したモードになったことを毎回確認する

## 2. 比較する指標

| 指標 | 取得方法 | 見るポイント |
|---|---|---|
| `cpu_user` | `scripts/demo/monitor-server.sh`（サーバー全体） | `cached`で低下するか |
| `pm2_cheerstick-server_cpu` | 同上（Nodeプロセス） | `cached`で低下するか（主指標） |
| 送信成功・失敗の件数 | `battle-demo.js`の出力（メトリクスjsonl） | **両モードで変化が無いこと**（失敗が増えていないこと） |
| `cheer_logs`の増加行数 | 実施前後の`SELECT COUNT(*)`（読み取りのみ） | 両モードでほぼ同数になること（取りこぼしが無いこと） |
| PostgreSQL接続数 | `SELECT count(*) FROM pg_stat_activity`（任意） | `cached`で待機が減る想定 |

## 3. 判断の目安（案。最終判断は別途）

- `cached`で`pm2_cheerstick-server_cpu`が有意に下がり、送信失敗・`cheer_logs`の取りこぼしが
  増えていない → `cached`採用を検討
- CPUが変わらない、または失敗・取りこぼしが増える → `legacy`のまま。INSERTが1メッセージ1回で
  残ることがボトルネックの場合は、案2（INSERTのバッチ化、`docs/proposals/large-event-scaling.md`）の検討へ

## 4. 実施時の注意

- 本番EC2の`.env`変更・`pm2 restart`は接続中のWebSocketを一度切る。実機テストと重ならない時間帯に行う
- `cached`にしても、管理画面（同一プロセス）からの試合の開始・停止は即時反映される。
  SQL直接変更を伴う操作は行わないこと（最大2秒の反映遅れが出るため）
- 測定後は`CHEER_LOG_WRITE_MODE`を判断結果どおりの値にして`pm2 restart --update-env`し、
  起動ログで確認する
