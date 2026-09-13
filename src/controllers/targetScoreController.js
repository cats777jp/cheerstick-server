// src/controllers/targetScoreController.js
// チーム別・選手別の応援集計スコア表示用コントローラー（一般公開エンドポイント、
// 2026-09-13新設）。
//
// 認証方針：event-battles（src/controllers/eventBattleController.js）と同じく、
// アプリケーションレベルの認証を追加しない。/api/v1/admin/ 配下ではないため
// 本番nginxのIPアドレス制限（docs/runbook.md「管理API アクセス制限」）は適用されない
// （target-report.htmlを会場等の任意の端末で表示する必要があるため、意図的にIP制限の外に
// 置く。event_battlesのスコアAPIと同じ「推測困難というほどでもないが、書き込みAPIでは
// なく参照のみ」という位置づけ）。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatRows(rows) {
  return rows.map((r) => ({
    target_id: r.target_id,
    target_name: r.target_name,
    target_type: r.target_type,
    target_image_url: r.target_image_url,
    target_number: r.target_number,
    organization: r.organization_id
      ? { id: r.organization_id, name: r.organization_name, color: r.organization_color }
      : null,
    total_intensity: r.total_intensity,
  }));
}

/**
 * GET /api/v1/events/:id/target-scores
 * statusによる分岐は行わない（event-battlesスコアAPIと同じ考え方。4.3章の判定ロジック側で
 * status='live'以外はそもそもcheer_logsへ書き込まれないため、ここで重ねて絞り込む必要が無い）。
 */
exports.byEvent = async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  try {
    const event = await cheerQueries.getEventBasic(id);
    if (!event) {
      return res.status(404).json({ error: 'EVENT_NOT_FOUND' });
    }

    const rows = await cheerQueries.getEventTargetScores(id);
    res.json({
      event_id: event.id,
      event_title: event.title,
      targets: formatRows(rows),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
};

/** GET /api/v1/target-scores（全期間通算、event_idの絞り込み無し） */
exports.allTime = async (req, res, next) => {
  try {
    const rows = await cheerQueries.getAllTimeTargetScores();
    res.json({
      targets: formatRows(rows),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
};
