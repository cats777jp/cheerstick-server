// src/controllers/eventBattleController.js
// 「2チーム対抗応援合戦」のスコア表示用コントローラー（一般公開エンドポイント）。
//
// 認証：管理API（B-3、docs/spec.md 8章）と同じ「アプリケーションレベルの認証は追加しない」
// 方針を踏襲する。ただし本エンドポイントは /api/v1/admin/ 配下ではないため、
// 本番nginxのIPアドレス制限（docs/runbook.md「管理API アクセス制限」）は適用されない
// （対抗戦スクリーンを会場等の任意の端末で表示する必要があるため、意図的にIP制限の外に置く）。
// battle_id（UUID）を知っている者は誰でもスコアを閲覧できる状態であり、
// reference機能（MACアドレス直指定方式）と同種の「推測困難なIDによる簡易的な保護」に留まる。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.getScore = async (req, res, next) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  try {
    const battle = await cheerQueries.getEventBattleMeta(id);
    if (!battle) {
      return res.status(404).json({ error: 'BATTLE_NOT_FOUND' });
    }

    // statusによる分岐は行わない：停止中・終了後もその時点のcheer_logs集計を
    // そのまま返し続ける（既存の応援量カウント判定ロジック側でstatus='live'以外は
    // そもそもcheer_logsへ書き込まれないため、ここで重ねて絞り込む必要が無い）。
    const [totalA, totalB] = await Promise.all([
      cheerQueries.getEventIntensityTotal(battle.event_a_id),
      cheerQueries.getEventIntensityTotal(battle.event_b_id),
    ]);

    // テーマ画像（対抗戦テーマ画像機能、2026-09-25追加）：event_battlesではなく
    // 個々のevents.metadataに保存する設計のため（指示書の設計方針）、対抗戦全体で
    // 1枚に決めるにあたり試合A→試合Bの優先順で採用する（8.4章の「event_a=画面左側」
    // という既存の慣例に合わせた判断。両方に設定された場合は試合A側を優先）。
    const themeImageUrl =
      (battle.event_a_metadata && battle.event_a_metadata.themeImageUrl) ||
      (battle.event_b_metadata && battle.event_b_metadata.themeImageUrl) ||
      null;

    res.json({
      battle_id: battle.id,
      label: battle.label,
      theme_image_url: themeImageUrl,
      team_a: {
        event_id: battle.event_a_id,
        event_title: battle.event_a_title,
        organization: battle.org_a_id
          ? {
              id: battle.org_a_id,
              name: battle.org_a_name,
              logo_url: battle.org_a_logo_url,
              color: battle.org_a_color,
            }
          : null,
        total_intensity: totalA,
      },
      team_b: {
        event_id: battle.event_b_id,
        event_title: battle.event_b_title,
        organization: battle.org_b_id
          ? {
              id: battle.org_b_id,
              name: battle.org_b_name,
              logo_url: battle.org_b_logo_url,
              color: battle.org_b_color,
            }
          : null,
        total_intensity: totalB,
      },
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
};
