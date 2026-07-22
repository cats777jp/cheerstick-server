// src/controllers/referenceController.js
// データ参照機能（BLE非接続時に過去の応援成績を見る）のコントローラー。
// NOTE: 本番の.envのALLOWED_ORIGINSに https://app.cheerstick.com を含める必要がある（未設定の場合はデプロイ時に追加）。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');
const { verifyReferenceToken } = require('../utils/referenceToken');

exports.getReference = async (req, res, next) => {
  const { token } = req.query;

  if (!token) {
    return res.status(401).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
  }

  let payload;
  try {
    payload = verifyReferenceToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
  }

  try {
    const deviceId = payload.device_id;
    const profile = await cheerQueries.getDeviceReferenceProfile(deviceId);

    if (!profile) {
      return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
    }

    const [recentEvents, allTime] = await Promise.all([
      cheerQueries.getRecentEventCheerTotals(deviceId, 3),
      cheerQueries.getAllTimeCheerTotal(deviceId),
    ]);

    res.json({
      nickname: profile.nickname,
      team: profile.team_name
        ? { name: profile.team_name, logo_url: profile.team_logo_url }
        : null,
      player: profile.player_name
        ? {
            name: profile.player_name,
            image_url: profile.player_image_url,
            number: profile.player_number,
          }
        : null,
      recent_events: recentEvents.map((row) => ({
        event_id: row.event_id,
        title: row.title,
        date: row.starts_at,
        intensity_total: row.total_intensity,
      })),
      all_time_intensity_total: allTime.total_intensity,
    });
  } catch (err) {
    next(err);
  }
};
