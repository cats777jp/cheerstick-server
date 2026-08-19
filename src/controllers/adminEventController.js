// src/controllers/adminEventController.js
// 試合状態（events.status）を操作する管理用コントローラー。
//
// 判断済み（2026-08-18時点）：アプリケーションレベルの認証は追加しない。理由・詳細は
// src/routes/admin.jsのコメント、docs/spec.md 8章参照（B-3、2026-08-19）。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// WS接続ログ（src/websocket/index.js）と同じ方式：X-Real-IPヘッダー優先、
// 無ければsocketのremoteAddressにフォールバックする（B-2、2026-08-19追加）。
function getClientIp(req) {
  return (req && req.headers && req.headers['x-real-ip']) ||
    (req && req.socket && req.socket.remoteAddress) ||
    'unknown';
}

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

// category_idクエリパラメータを指定するとそのジャンルのみに絞り込む（B-4、2026-08-19拡張）。
// 未指定時は従来通り全件（試合登録フォームのチームプルダウンからの呼び出しと互換）。
exports.listOrganizations = async (req, res, next) => {
  try {
    const { category_id: categoryId } = req.query;
    const organizations = await cheerQueries.listOrganizationsForAdmin(categoryId || null);
    res.json(organizations);
  } catch (err) {
    next(err);
  }
};

/**
 * 管理画面：チームを新規登録する（B-4、2026-08-19新設）。
 * name・category_idは必須（category_id未設定のチームはデバイス向け一覧に出せず
 * 実質使えないため、登録時点で必須とした）。logo_urlは任意。
 */
exports.createOrganization = async (req, res, next) => {
  const { name, category_id: categoryId, logo_url: logoUrl } = req.body || {};

  if (!name || !categoryId) {
    return res.status(400).json({ error: 'name and category_id are required' });
  }

  try {
    const created = await cheerQueries.createOrganizationAdmin({ name, categoryId, logoUrl });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'CATEGORY_NOT_FOUND') {
      return res.status(400).json({ error: 'CATEGORY_NOT_FOUND' });
    }
    next(err);
  }
};

/**
 * 管理画面：チームを部分更新する（B-4、2026-08-19新設）。
 */
exports.updateOrganization = async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  const { name, category_id: categoryId, logo_url: logoUrl } = req.body || {};
  const fields = {};
  if (name !== undefined) fields.name = name;
  if (categoryId !== undefined) fields.categoryId = categoryId;
  if (logoUrl !== undefined) fields.logoUrl = logoUrl;

  try {
    const updated = await cheerQueries.updateOrganizationAdmin(id, fields);
    if (!updated) {
      return res.status(404).json({ error: 'ORGANIZATION_NOT_FOUND' });
    }
    res.json(updated);
  } catch (err) {
    if (err.code === 'CATEGORY_NOT_FOUND') {
      return res.status(400).json({ error: 'CATEGORY_NOT_FOUND' });
    }
    next(err);
  }
};

/**
 * 管理画面：試合状態(status)を変更する。
 *
 * B-2（2026-08-19追加）：変更前のstatusを取得したうえで、hide()（非表示化）と同じ形式で
 * 変更ログを出力する。2026-08-10の事故（誤ってfinishedにした試合を本番DBへの手動SQLで
 * 削除）に相当する操作がこれまで一切ログに残らなかったための対応。
 * メールアドレス・ニックネームは出力しない。
 */
exports.updateStatus = async (req, res, next) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  try {
    const before = await cheerQueries.getEventBasic(id);
    const updated = await cheerQueries.updateEventStatus(id, status);
    if (!updated) {
      return res.status(404).json({ error: 'EVENT_NOT_FOUND' });
    }
    console.log(
      `[ADMIN] status change time=${new Date().toISOString()} event_id=${updated.id} ` +
      `title="${before ? before.title : ''}" from=${before ? before.status : 'unknown'} ` +
      `to=${updated.status} ip=${getClientIp(req)}`
    );
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
