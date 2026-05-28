const { Router } = require('express');
const devicesRouter = require('./devices');
const eventsRouter = require('./events');

const router = Router();

router.use('/devices', devicesRouter);
router.use('/events', eventsRouter);

module.exports = router;
