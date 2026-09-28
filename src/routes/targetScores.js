// src/routes/targetScores.js
// チーム別・選手別の応援集計スコアの一般公開エンドポイント（2026-09-13新設、
// target-report.html用）。
// event-battles（src/routes/eventBattles.js）はbattle_id起点の単一パスだが、本機能は
// 「試合ごと」「全期間通算」の2パスをまとめて持つため、/api/v1直下に両方を定義する。

const { Router } = require('express');
const targetScoreController = require('../controllers/targetScoreController');
const { scoreIpLimiter, config } = require('../middleware/rateLimit');
const { createScoreCacheMiddleware } = require('../middleware/scoreCache');

const router = Router();

// スコア・閲覧系（(b)、大規模イベント対応トラックA）：別枠のIP上限＋短時間キャッシュ。
router.use(scoreIpLimiter, createScoreCacheMiddleware(config.scoreCacheTtlMs));

router.get('/events/:id/target-scores', targetScoreController.byEvent);
router.get('/target-scores', targetScoreController.allTime);

module.exports = router;
