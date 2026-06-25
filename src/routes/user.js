const { Router } = require('express');
const userController = require('../controllers/userController');

const router = Router();

router.get('/cs_user', userController.csUser);

module.exports = router;
