const { Router } = require('express');
const webviewController = require('../controllers/webviewController');
const referenceController = require('../controllers/referenceController');

const router = Router();

router.get('/geturl', webviewController.geturl);
router.get('/reference', referenceController.getReference);

module.exports = router;
