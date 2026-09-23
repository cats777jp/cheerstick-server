// src/routes/rankingSnapshots.js
// 順位確定機能：会場スクリーン向け閲覧用GET API（Phase 3、2026-09-23新設）。
// target-scores・event-battlesスコアAPIと同じく/api/v1直下（IP制限の対象外）に置く。

const { Router } = require('express');
const rankingSnapshotController = require('../controllers/rankingSnapshotController');

const router = Router();

router.get('/events/:eventId/ranking-snapshots/latest', rankingSnapshotController.latest);

module.exports = router;
