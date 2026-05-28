const { Router } = require('express');
const eventsController = require('../controllers/eventsController');

const router = Router();

// スマホアプリからの応援イベント送信
router.post('/', eventsController.create);
router.get('/', eventsController.list);

module.exports = router;
