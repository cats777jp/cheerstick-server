// src/routes/admin.js
// 管理用エンドポイント。
//
// TODO: 本番公開前に認証必須。

const { Router } = require('express');
const adminEventController = require('../controllers/adminEventController');

const router = Router();

router.get('/events', adminEventController.list);
router.post('/events', adminEventController.create);
router.patch('/events/:id', adminEventController.update);
router.patch('/events/:id/status', adminEventController.updateStatus);
router.delete('/events/:id', adminEventController.hide);

router.get('/organizations', adminEventController.listOrganizations);

module.exports = router;
