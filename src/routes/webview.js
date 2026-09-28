const { Router } = require('express');
const webviewController = require('../controllers/webviewController');
const referenceController = require('../controllers/referenceController');
const { audienceIpLimiter, audienceDeviceLimiter } = require('../middleware/rateLimit');

const router = Router();

// 観客の入口（(a)、大規模イベント対応トラックA）：IPごとの上限とデバイスごとの上限を
// 両方適用する。詳細はsrc/middleware/rateLimit.js参照。
router.use(audienceIpLimiter, audienceDeviceLimiter);

router.get('/geturl', webviewController.geturl);
router.get('/reference', referenceController.getReference);

module.exports = router;
