// src/routes/targetScores.js
// チーム別・選手別の応援集計スコアの一般公開エンドポイント（2026-09-13新設、
// target-report.html用）。
// event-battles（src/routes/eventBattles.js）はbattle_id起点の単一パスだが、本機能は
// 「試合ごと」「全期間通算」の2パスをまとめて持つため、/api/v1直下に両方を定義する。

const { Router } = require('express');
const targetScoreController = require('../controllers/targetScoreController');

const router = Router();

router.get('/events/:id/target-scores', targetScoreController.byEvent);
router.get('/target-scores', targetScoreController.allTime);

module.exports = router;
