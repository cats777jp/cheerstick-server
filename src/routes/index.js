const { Router } = require('express');
const devicesRouter = require('./devices');
const eventsRouter = require('./events');
const userRouter = require('./user');
const gameRouter = require('./game');
const cheerRouter = require('./cheer');
const webviewRouter = require('./webview');

const router = Router();

router.use('/devices', devicesRouter);
router.use('/events', eventsRouter);
router.use('/user', userRouter);
router.use('/game', gameRouter);
router.use('/cheer', cheerRouter);
router.use('/webview', webviewRouter);

module.exports = router;
