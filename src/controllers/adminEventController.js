// src/controllers/adminEventController.js
// 試合状態（events.status）を操作する管理用コントローラー。
//
// TODO: 本番公開前に認証必須。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.list = async (req, res, next) => {
  try {
    const events = await cheerQueries.listEventsAdmin();
    res.json(events);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  const {
    title,
    organization_id: organizationId,
    starts_at: startsAt,
    ends_at: endsAt,
  } = req.body;

  if (!title || !organizationId || !startsAt) {
    return res.status(400).json({ error: 'title, organization_id and starts_at are required' });
  }

  try {
    const created = await cheerQueries.createEvent({
      title,
      organizationId,
      startsAt,
      endsAt: endsAt || null,
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'ORGANIZATION_NOT_FOUND') {
      return res.status(400).json({ error: 'ORGANIZATION_NOT_FOUND' });
    }
    next(err);
  }
};

exports.update = async (req, res, next) => {
  const { id } = req.params;
  const {
    title,
    organization_id: organizationId,
    starts_at: startsAt,
    ends_at: endsAt,
  } = req.body;

  const fields = {};
  if (title !== undefined) fields.title = title;
  if (organizationId !== undefined) fields.organizationId = organizationId;
  if (startsAt !== undefined) fields.startsAt = startsAt;
  if (endsAt !== undefined) fields.endsAt = endsAt;

  try {
    const updated = await cheerQueries.updateEvent(id, fields);
    if (!updated) {
      return res.status(404).json({ error: 'EVENT_NOT_FOUND' });
    }
    res.json(updated);
  } catch (err) {
    if (err.code === 'ORGANIZATION_NOT_FOUND') {
      return res.status(400).json({ error: 'ORGANIZATION_NOT_FOUND' });
    }
    next(err);
  }
};

exports.listOrganizations = async (req, res, next) => {
  try {
    const organizations = await cheerQueries.listOrganizationsForAdmin();
    res.json(organizations);
  } catch (err) {
    next(err);
  }
};

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
    if (err.code === 'LIVE_EVENT_CONFLICT') {
      return res.status(409).json({
        error: 'LIVE_EVENT_CONFLICT',
        conflicting_event: err.conflict,
      });
    }
    next(err);
  }
};

/**
 * 管理画面：試合を「削除」する（実体は非表示化。docs/proposals/admin-hide-endpoint.md参照）。
 * 物理削除は行わない（cheer_logs -> eventsのFKがSET NULLのため）。
 */
exports.hide = async (req, res, next) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  try {
    const hidden = await cheerQueries.hideEvent(id);
    if (!hidden) {
      return res.status(404).json({ error: 'EVENT_NOT_FOUND' });
    }
    console.log(
      `[admin] event hidden: id=${hidden.id} title="${hidden.title}" status=${hidden.status} hidden_at=${hidden.hidden_at.toISOString()}`
    );
    res.status(200).json(hidden);
  } catch (err) {
    if (err.code === 'CANNOT_HIDE_LIVE_EVENT') {
      return res.status(409).json({
        error: 'CANNOT_HIDE_LIVE_EVENT',
        message: '進行中の試合は削除できません。停止してから操作してください',
      });
    }
    next(err);
  }
};
