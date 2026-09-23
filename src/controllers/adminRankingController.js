// src/controllers/adminRankingController.js
// 試合終了時の順位確定機能（ユーザー別・選手別、上位20名）の管理用コントローラー。
//
// 認証：他の管理API（adminEventController等）と同じくアプリケーションレベルの認証は
// 追加しない。nginx側のIPアドレス制限（/api/v1/admin/、docs/runbook.md参照）に依拠する。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// WS接続ログ・adminEventControllerと同じ方式：X-Real-IPヘッダー優先、
// 無ければsocketのremoteAddressにフォールバックする。
function getClientIp(req) {
  return (req && req.headers && req.headers['x-real-ip']) ||
    (req && req.socket && req.socket.remoteAddress) ||
    'unknown';
}

/**
 * POST /api/v1/admin/events/:eventId/ranking-snapshot
 * 「順位確定」ボタン。押すたびに実行可能（履歴として複数回分を保存する）。
 */
exports.createSnapshot = async (req, res, next) => {
  const { eventId } = req.params;
  if (!UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  try {
    const result = await cheerQueries.createRankingSnapshot(eventId, getClientIp(req));
    if (!result) {
      return res.status(404).json({ error: 'EVENT_NOT_FOUND' });
    }

    res.status(201).json({
      snapshotId: result.snapshotId,
      eventId,
      triggeredAt: result.triggeredAt,
      userEntries: result.userEntries,
      targetEntries: result.targetEntries,
    });
  } catch (err) {
    if (err.code === 'INVALID_EVENT_STATUS') {
      return res.status(400).json({ error: 'INVALID_EVENT_STATUS' });
    }
    next(err);
  }
};
