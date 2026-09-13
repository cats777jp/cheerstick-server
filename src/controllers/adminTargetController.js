// src/controllers/adminTargetController.js
// 管理画面：targets（選手・マスコット等の応援対象）のCRUDを扱う管理用コントローラー
// （2026-09-13新設）。
//
// 判断済み（2026-08-18時点）：アプリケーションレベルの認証は追加しない。理由・詳細は
// src/routes/admin.jsのコメント、docs/spec.md 8章参照（B-3、2026-08-19）。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.list = async (req, res, next) => {
  const { organization_id: organizationId } = req.query;
  try {
    const targets = await cheerQueries.listTargetsAdmin(organizationId || null);
    res.json(targets);
  } catch (err) {
    next(err);
  }
};

/**
 * name・organization_id・typeは必須。organization_idは、DB上はNULL許容だが、
 * 所属チームの無いtargetはWebViewの推し選択（listTargetsByOrganization）に一切現れず
 * 実質使えなくなるため、organizations.category_idと同じ考え方でアプリ層で必須とする。
 * typeはDB列がNOT NULLのため必須（自由入力。既存値のdatalistは画面側で提示）。
 */
exports.create = async (req, res, next) => {
  const {
    name,
    organization_id: organizationId,
    type,
    image_url: imageUrl,
    number,
    profile_text: profileText,
    is_active: isActive,
  } = req.body || {};

  if (!name || !organizationId || !type) {
    return res.status(400).json({ error: 'name, organization_id and type are required' });
  }

  try {
    const created = await cheerQueries.createTargetAdmin({
      name,
      organizationId,
      type,
      imageUrl,
      number,
      profileText,
      isActive,
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
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  const {
    name,
    organization_id: organizationId,
    type,
    image_url: imageUrl,
    number,
    profile_text: profileText,
    is_active: isActive,
  } = req.body || {};

  const fields = {};
  if (name !== undefined) fields.name = name;
  if (organizationId !== undefined) fields.organizationId = organizationId;
  if (type !== undefined) fields.type = type;
  if (imageUrl !== undefined) fields.imageUrl = imageUrl;
  if (number !== undefined) fields.number = number;
  if (profileText !== undefined) fields.profileText = profileText;
  if (isActive !== undefined) fields.isActive = isActive;

  try {
    const updated = await cheerQueries.updateTargetAdmin(id, fields);
    if (!updated) {
      return res.status(404).json({ error: 'TARGET_NOT_FOUND' });
    }
    res.json(updated);
  } catch (err) {
    if (err.code === 'ORGANIZATION_NOT_FOUND') {
      return res.status(400).json({ error: 'ORGANIZATION_NOT_FOUND' });
    }
    next(err);
  }
};

/**
 * 物理削除。devices.current_target_id または cheer_logs.target_id で参照されている場合は
 * 409 TARGET_IN_USE を返す（詳細はcheerstickQueries.deleteTargetAdminのコメント参照）。
 */
exports.remove = async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  try {
    const deleted = await cheerQueries.deleteTargetAdmin(id);
    if (deleted === null) {
      return res.status(404).json({ error: 'TARGET_NOT_FOUND' });
    }
    res.status(200).json({ deleted: true });
  } catch (err) {
    if (err.code === 'TARGET_IN_USE') {
      return res.status(409).json({ error: 'TARGET_IN_USE' });
    }
    next(err);
  }
};
