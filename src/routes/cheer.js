const { Router } = require('express');
const cheerController = require('../controllers/cheerController');

const router = Router();

router.post('/device', cheerController.device);

module.exports = router;
