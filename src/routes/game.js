const { Router } = require('express');
const gameController = require('../controllers/gameController');

const router = Router();

router.post('/control', gameController.control);

module.exports = router;
