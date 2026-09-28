// src/routes/admin.js
// 管理用エンドポイント。
//
// 判断済み（2026-08-18時点）：アプリケーションレベルの認証は追加しない。nginx側の
// IPアドレス制限（/api/v1/admin/、KMT様オフィス固定IP限定）に依拠する設計でKMT様と
// 合意済み（B-3、2026-08-19）。詳細はdocs/spec.md 8章・docs/runbook.md
// 「管理API アクセス制限」参照。運用者が複数人になる、または外部からの操作が
// 必要になった時点でBasic認証等への移行を検討する。

const express = require('express');
const multer = require('multer');
const { Router } = express;
const adminEventController = require('../controllers/adminEventController');
const adminDeviceController = require('../controllers/adminDeviceController');
const adminTargetController = require('../controllers/adminTargetController');
const adminRankingController = require('../controllers/adminRankingController');
const uploadController = require('../controllers/uploadController');
const { adminIpLimiter } = require('../middleware/rateLimit');

const router = Router();

// 管理API（(c)、大規模イベント対応トラックA）：一般枠から外し、暴走検知用の別枠上限を
// 適用する。nginxのオフィスIP制限（上記コメント参照）はそのまま残る。詳細は
// src/middleware/rateLimit.js・docs/proposals/large-event-scaling.md参照。
router.use(adminIpLimiter);

// 画像アップロード（改善3件フェーズ2、2026-09-16新設）：メモリストレージ＋5MB上限。
// ディスクへの書き込みはuploadController側でマジックバイト検証後に行うため、
// multer自体はディスクに触れないmemoryStorageを使う。
const uploadImageMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function handleImageUpload(req, res, next) {
  uploadImageMiddleware.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'FILE_TOO_LARGE', message: 'ファイルサイズは5MBまでです' });
      }
      return res.status(400).json({ error: 'UPLOAD_ERROR', message: err.message });
    }
    next();
  });
}

router.get('/events', adminEventController.list);
router.post('/events', adminEventController.create);
router.patch('/events/:id', adminEventController.update);
router.patch('/events/:id/status', adminEventController.updateStatus);
router.delete('/events/:id', adminEventController.hide);

// 順位確定機能（試合終了時のユーザー別・選手別順位確定、2026-09-23新設）
router.post('/events/:eventId/ranking-snapshot', adminRankingController.createSnapshot);

router.get('/organizations', adminEventController.listOrganizations);
router.post('/organizations', adminEventController.createOrganization);
router.patch('/organizations/:id', adminEventController.updateOrganization);

router.get('/categories', adminDeviceController.listCategories);
router.post('/categories', adminDeviceController.createCategory);
router.patch('/categories/:id', adminDeviceController.updateCategory);

// 対抗戦ペア（event_battles）管理：2チーム対抗応援合戦機能（2026-09-11新設）
router.get('/event-battles', adminEventController.listBattles);
router.post('/event-battles', adminEventController.createBattle);
router.delete('/event-battles/:id', adminEventController.deleteBattle);

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

// 選手・推し対象（targets）管理（2026-09-13新設）
router.get('/targets', adminTargetController.list);
router.post('/targets', adminTargetController.create);
router.patch('/targets/:id', adminTargetController.update);
router.delete('/targets/:id', adminTargetController.remove);

// 画像アップロード（チームロゴ・選手/推し対象写真、改善3件フェーズ2、2026-09-16新設）
router.post('/uploads/image', handleImageUpload, uploadController.uploadImage);

module.exports = router;
