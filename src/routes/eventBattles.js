// src/routes/eventBattles.js
// 「2チーム対抗応援合戦」の一般公開エンドポイント（スコア表示用）。
// 管理系（登録・一覧・削除）は src/routes/admin.js 側（/api/v1/admin/event-battles）に置く。

const { Router } = require('express');
const eventBattleController = require('../controllers/eventBattleController');

const router = Router();

router.get('/:id/score', eventBattleController.getScore);

module.exports = router;
