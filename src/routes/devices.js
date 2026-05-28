const { Router } = require('express');
const devicesController = require('../controllers/devicesController');

const router = Router();

router.get('/', devicesController.list);
router.post('/', devicesController.register);
router.get('/:deviceId', devicesController.get);
router.patch('/:deviceId', devicesController.update);

module.exports = router;
