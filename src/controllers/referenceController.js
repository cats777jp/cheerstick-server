// src/controllers/referenceController.js
// データ参照機能（BLE非接続時に過去の応援成績を見る）のコントローラー。
// NOTE: 本番の.envのALLOWED_ORIGINSに https://app.cheerstick.com を含める必要がある（未設定の場合はデプロイ時に追加）。
// NOTE: ENABLE_REFERENCE_TOKEN=true の場合はtokenクエリを検証してdevice_idを取得、
//       false（既定）の場合はidクエリ（MACアドレス）をそのままdevices.mac_addressに照合してdevice_idを取得する。
//       いずれの経路でもemailはgetDeviceReferenceProfile側でSELECTしないため、レスポンスに含まれない。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');
const { verifyReferenceToken } = require('../utils/referenceToken');

const TOKEN_ENABLED = process.env.ENABLE_REFERENCE_TOKEN === 'true';

async function resolveDeviceId(req, res) {
  if (TOKEN_ENABLED) {
    const { token } = req.query;
    if (!token) {
      res.status(401).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
      return null;
    }
    try {
      const payload = verifyReferenceToken(token);
      return payload.device_id;
    } catch (err) {
      res.status(401).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
      return null;
    }
  }

  const { id: macAddress } = req.query;
  if (!macAddress) {
    res.status(400).json({ error: 'MISSING_ID' });
    return null;
  }
  const device = await cheerQueries.getDeviceIdByMac(macAddress);
  if (!device) {
    res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
    return null;
  }
  return device.device_id;
}

exports.getReference = async (req, res, next) => {
  try {
    const deviceId = await resolveDeviceId(req, res);
    if (deviceId === null) return;

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
