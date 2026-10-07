// src/controllers/eventBattleRankingController.js
// 対抗戦（2チーム）向け順位発表画面（public/ranking-battle.html）用の閲覧API。
//
// 認証：eventBattleController（スコアAPI）と同じ。アプリケーションレベルの認証は無く、
// /api/v1/admin/ 配下ではないためnginxのIP制限も適用されない（会場スクリーンを任意の端末で
// 表示するため意図的）。battle_id（UUID）による簡易的な保護に留まる。
// レート制限・短時間キャッシュはsrc/routes/eventBattles.js側のルーター共通設定を継承する。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildTeam(eventId, eventTitle, org, metadata, snapshot) {
  const meta = metadata || {};
  return {
    event_id: eventId,
    event_title: eventTitle,
    organization: org.id
      ? { id: org.id, name: org.name, logo_url: org.logo_url, color: org.color }
      : null,
    // 装飾枠（events.metadata、チームごと＝試合ごと）。未設定はnull。
    decor: {
      background_url: meta.rankingBackgroundUrl || null,
      sponsor_logo_url: meta.sponsorLogoUrl || null,
    },
    // まだ確定されていないチームはsnapshotId: null・空配列（画面側で「確定待ち」を表示）
    snapshot: snapshot
      ? {
          snapshotId: snapshot.snapshotId,
          triggeredAt: snapshot.triggeredAt,
          user: snapshot.user,
          target: snapshot.target,
        }
      : { snapshotId: null, triggeredAt: null, user: [], target: [] },
  };
}

/**
 * GET /api/v1/event-battles/:id/ranking-snapshots/latest
 */
exports.getLatest = async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  try {
    const battle = await cheerQueries.getEventBattleMeta(id);
    if (!battle) {
      return res.status(404).json({ error: 'BATTLE_NOT_FOUND' });
    }

    const [snapA, snapB] = await Promise.all([
      cheerQueries.getLatestBattleRankingSnapshot(battle.event_a_id),
      cheerQueries.getLatestBattleRankingSnapshot(battle.event_b_id),
    ]);

    // テーマ画像はeventBattleController.getScoreと同じ採用ルール（試合A優先、無ければ試合B）。
    const themeImageUrl =
      (battle.event_a_metadata && battle.event_a_metadata.themeImageUrl) ||
      (battle.event_b_metadata && battle.event_b_metadata.themeImageUrl) ||
      null;

    // 画面全体の背景（スタジアム風の写真・イラスト、2026-10-07追加）。テーマ画像と同じ採用ルール
    // （試合A優先、無ければ試合B）。未設定ならnull（画面側はCSSで描いた既定の背景を使う）。
    const stageBackgroundUrl =
      (battle.event_a_metadata && battle.event_a_metadata.stageBackgroundUrl) ||
      (battle.event_b_metadata && battle.event_b_metadata.stageBackgroundUrl) ||
      null;

    res.json({
      battle_id: battle.id,
      label: battle.label,
      theme_image_url: themeImageUrl,
      stage_background_url: stageBackgroundUrl,
      team_a: buildTeam(
        battle.event_a_id, battle.event_a_title,
        { id: battle.org_a_id, name: battle.org_a_name, logo_url: battle.org_a_logo_url, color: battle.org_a_color },
        battle.event_a_metadata, snapA
      ),
      team_b: buildTeam(
        battle.event_b_id, battle.event_b_title,
        { id: battle.org_b_id, name: battle.org_b_name, logo_url: battle.org_b_logo_url, color: battle.org_b_color },
        battle.event_b_metadata, snapB
      ),
    });
  } catch (err) {
    next(err);
  }
};
