const { Router } = require('express');
const webviewController = require('../controllers/webviewController');

const router = Router();

router.get('/geturl', webviewController.geturl);

module.exports = router;
