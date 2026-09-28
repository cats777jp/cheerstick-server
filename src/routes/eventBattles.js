// src/routes/eventBattles.js
// 「2チーム対抗応援合戦」の一般公開エンドポイント（スコア表示用）。
// 管理系（登録・一覧・削除）は src/routes/admin.js 側（/api/v1/admin/event-battles）に置く。

const { Router } = require('express');
const eventBattleController = require('../controllers/eventBattleController');
const { scoreIpLimiter, config } = require('../middleware/rateLimit');
const { createScoreCacheMiddleware } = require('../middleware/scoreCache');

const router = Router();

// スコア・閲覧系（(b)、大規模イベント対応トラックA）：別枠のIP上限＋短時間キャッシュ。
// 詳細はsrc/middleware/rateLimit.js・scoreCache.js参照。
router.use(scoreIpLimiter, createScoreCacheMiddleware(config.scoreCacheTtlMs));

router.get('/:id/score', eventBattleController.getScore);

module.exports = router;
