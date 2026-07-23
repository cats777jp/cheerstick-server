// src/controllers/adminEventController.js
// 試合状態（events.status）を操作する管理用コントローラー。
//
// TODO: 本番公開前に認証必須。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');

exports.updateStatus = async (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  try {
    const updated = await cheerQueries.updateEventStatus(id, status);
    if (!updated) {
      return res.status(404).json({ error: 'EVENT_NOT_FOUND' });
    }
    res.json(updated);
  } catch (err) {
    if (err.code === 'INVALID_STATUS') {
      return res.status(400).json({ error: 'INVALID_STATUS' });
    }
    next(err);
  }
};
