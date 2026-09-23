// src/controllers/rankingSnapshotController.js
// 順位確定機能の会場スクリーン向け閲覧用コントローラー（Phase 3、2026-09-23新設）。
//
// 認証：target-scores・event-battlesスコアAPIと同じく、アプリケーションレベルの認証は
// 追加しない。/api/v1/admin/ 配下ではないため本番nginxのIPアドレス制限は適用されない
// （会場スクリーンを任意の端末で表示する必要があるため、意図的にIP制限の外に置く）。
//
// 配信方式：Phase 0調査の結果、WebSocketプッシュではなくbattle.html・target-report.htmlと
// 同じHTTPポーリング方式に変更した（STEP3改訂、詳細はdocs/worklog.md参照）。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_RANKING_TYPES = ['user', 'target'];

/**
 * GET /api/v1/events/:eventId/ranking-snapshots/latest?rankingType=user|target
 */
exports.latest = async (req, res, next) => {
  const { eventId } = req.params;
  const { rankingType } = req.query;

  if (!UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }
  if (!VALID_RANKING_TYPES.includes(rankingType)) {
    return res.status(400).json({ error: 'INVALID_RANKING_TYPE' });
  }

  try {
    const event = await cheerQueries.getEventBasic(eventId);
    if (!event) {
      return res.status(404).json({ error: 'EVENT_NOT_FOUND' });
    }

    const snapshot = await cheerQueries.getLatestRankingSnapshot(eventId, rankingType);
    if (!snapshot) {
      // まだ一度も確定操作が行われていない状態。画面側で
      // 「まだ順位確定されていません」等を表示できるようにする。
      return res.json({ snapshotId: null, triggeredAt: null, entries: [] });
    }

    res.json(snapshot);
  } catch (err) {
    next(err);
  }
};
