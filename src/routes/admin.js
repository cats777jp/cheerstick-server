// src/routes/admin.js
// 管理用エンドポイント。
//
// TODO: 本番公開前に認証必須。

const { Router } = require('express');
const adminEventController = require('../controllers/adminEventController');

const router = Router();

router.patch('/events/:id/status', adminEventController.updateStatus);

module.exports = router;
