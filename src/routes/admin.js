// src/routes/admin.js
// 管理用エンドポイント。
//
// TODO: 本番公開前に認証必須。

const express = require('express');
const { Router } = express;
const adminEventController = require('../controllers/adminEventController');
const adminDeviceController = require('../controllers/adminDeviceController');

const router = Router();

router.get('/events', adminEventController.list);
router.post('/events', adminEventController.create);
router.patch('/events/:id', adminEventController.update);
router.patch('/events/:id/status', adminEventController.updateStatus);
router.delete('/events/:id', adminEventController.hide);

router.get('/organizations', adminEventController.listOrganizations);

router.get('/categories', adminDeviceController.listCategories);

// B-5（devices管理機能、2026-08-19新設）
// /devices/bulk・/devices/import は /devices/:id より前に置くこと
// （後ろに置くと ":id" が "bulk"/"import" を文字列として拾ってしまう）。
router.get('/devices', adminDeviceController.list);
router.post('/devices', adminDeviceController.create);
router.post(
  '/devices/import',
  // CSV取り込みは2000件規模の生テキストを受け取るため、グローバルのexpress.json（16kb上限、
  // src/app.js）とは別に、このルート専用でexpress.textを適用する（上限は本ルートのみ2mbへ緩和。
  // グローバル側の上限は変更しない＝他エンドポイントへの影響なし）。
  express.text({ type: '*/*', limit: '2mb' }),
  adminDeviceController.importDevices
);
router.patch('/devices/bulk', adminDeviceController.bulkUpdate);
router.patch('/devices/:id', adminDeviceController.update);

module.exports = router;
