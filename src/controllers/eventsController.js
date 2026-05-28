const db = require('../db');
const { v4: uuidv4 } = require('uuid');

exports.create = async (req, res, next) => {
  try {
    const { device_id, event_type, payload } = req.body;
    const id = uuidv4();
    const { rows } = await db.query(
      `INSERT INTO events (id, device_id, event_type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, device_id, event_type, JSON.stringify(payload ?? {})]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { device_id, limit = 50, offset = 0 } = req.query;
    const params = [Number(limit), Number(offset)];
    let query =
      'SELECT * FROM events ORDER BY created_at DESC LIMIT $1 OFFSET $2';

    if (device_id) {
      query =
        'SELECT * FROM events WHERE device_id = $3 ORDER BY created_at DESC LIMIT $1 OFFSET $2';
      params.push(device_id);
    }

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
};
