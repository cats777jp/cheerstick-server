const db = require('../db');
const { v4: uuidv4 } = require('uuid');

exports.list = async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM devices ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

exports.register = async (req, res, next) => {
  try {
    const { serial_number, firmware_version, location } = req.body;
    const id = uuidv4();
    const { rows } = await db.query(
      `INSERT INTO devices (id, serial_number, firmware_version, location)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, serial_number, firmware_version, location]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM devices WHERE id = $1',
      [req.params.deviceId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { firmware_version, location, status } = req.body;
    const { rows } = await db.query(
      `UPDATE devices
       SET firmware_version = COALESCE($1, firmware_version),
           location         = COALESCE($2, location),
           status           = COALESCE($3, status),
           updated_at       = NOW()
       WHERE id = $4
       RETURNING *`,
      [firmware_version, location, status, req.params.deviceId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Device not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};
