// src/db/cheerstickQueries.js
// WebView（ユーザー名登録・チーム選択・推し選択・geturl）で使うDBクエリ集。
// コントローラー/WebSocketハンドラーからはこのモジュール経由でDBにアクセスする。

'use strict';

const db = require('./index');

/**
 * MACアドレスからデバイス情報（紐づくユーザー・選択中チーム・推し対象を含む）を取得。
 * 未登録デバイスの場合は null を返す。
 */
async function findDeviceWithProfile(macAddress) {
  const { rows } = await db.query(
    `
    SELECT
      d.id                       AS device_id,
      d.mac_address,
      d.owner_user_id,
      d.selected_organization_id,
      d.current_target_id,
      u.display_name,
      u.email,
      t.id                       AS target_id,
      t.name                     AS target_name,
      t.type                     AS target_type,
      t.image_url                AS target_image_url,
      t.number                   AS target_number,
      t.metadata                 AS target_metadata,
      o.id                       AS org_id,
      o.name                     AS org_name,
      o.logo_url                 AS org_logo_url
    FROM devices d
    LEFT JOIN users u         ON u.id = d.owner_user_id
    LEFT JOIN targets t       ON t.id = d.current_target_id
    LEFT JOIN organizations o ON o.id = d.selected_organization_id
    WHERE d.mac_address = $1
    `,
    [macAddress]
  );
  return rows[0] || null;
}

/**
 * デバイス行が無ければ作成する（owner_user_id は未設定のまま）。
 * 既にあれば何もしない。
 */
async function ensureDevice(macAddress) {
  await db.query(
    `
    INSERT INTO devices (mac_address, status)
    VALUES ($1, 'active')
    ON CONFLICT (mac_address) DO NOTHING
    `,
    [macAddress]
  );
}

/**
 * email でユーザーを検索、無ければ作成。あれば display_name を更新して返す。
 * （同じメールで再登録された場合、最新のニックネームに揃える）
 */
async function findOrCreateUserByEmail(email, displayName) {
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);

  if (existing.rows[0]) {
    const userId = existing.rows[0].id;
    await db.query('UPDATE users SET display_name = $1 WHERE id = $2', [displayName, userId]);
    return userId;
  }

  const { rows } = await db.query(
    `INSERT INTO users (email, display_name, auth_provider)
     VALUES ($1, $2, 'email')
     RETURNING id`,
    [email, displayName]
  );
  return rows[0].id;
}

/**
 * デバイスにユーザーを紐づける（ニックネーム＋メール登録の確定処理）。
 * デバイス行が無ければ作成してから紐づける。
 * ※チーム・推しの選択はこの時点では行わない（別ステップ）。
 */
async function registerDeviceOwner(macAddress, email, displayName) {
  await ensureDevice(macAddress);
  const userId = await findOrCreateUserByEmail(email, displayName);

  await db.query(
    `UPDATE devices
     SET owner_user_id = $1, registered_at = NOW()
     WHERE mac_address = $2`,
    [userId, macAddress]
  );

  return userId;
}

/**
 * 応援チーム一覧（organizations）を取得。
 */
async function listOrganizations() {
  const { rows } = await db.query(
    `SELECT id, name, logo_url FROM organizations WHERE is_active = TRUE ORDER BY name`
  );
  return rows;
}

/**
 * 指定チーム配下の応援対象（選手・マスコット等）一覧を取得。
 */
async function listTargetsByOrganization(organizationId) {
  const { rows } = await db.query(
    `SELECT id, name, type, image_url, number, metadata
     FROM targets
     WHERE organization_id = $1 AND is_active = TRUE
     ORDER BY (type = 'mascot') DESC, number NULLS LAST, name`,
    [organizationId]
  );
  return rows;
}

/**
 * デバイスの「応援チーム」を選択。チームを変更した場合は推し選択をリセットする。
 */
async function setDeviceOrganization(macAddress, organizationId) {
  await ensureDevice(macAddress);
  await db.query(
    `UPDATE devices
     SET selected_organization_id = $1, current_target_id = NULL
     WHERE mac_address = $2`,
    [organizationId, macAddress]
  );
}

/**
 * デバイスの「推し（現在応援中の対象）」を設定。
 * 選択中チームに属さないtarget_idは拒否する。
 */
async function setDeviceTarget(macAddress, targetId) {
  await ensureDevice(macAddress);

  const { rows } = await db.query(
    `SELECT d.selected_organization_id, t.organization_id AS target_org_id
     FROM devices d, targets t
     WHERE d.mac_address = $1 AND t.id = $2`,
    [macAddress, targetId]
  );

  const row = rows[0];
  if (!row || !row.selected_organization_id || row.selected_organization_id !== row.target_org_id) {
    const err = new Error('target does not belong to the selected team');
    err.code = 'TARGET_TEAM_MISMATCH';
    throw err;
  }

  await db.query(
    `UPDATE devices SET current_target_id = $1 WHERE mac_address = $2`,
    [targetId, macAddress]
  );
}

module.exports = {
  findDeviceWithProfile,
  ensureDevice,
  findOrCreateUserByEmail,
  registerDeviceOwner,
  listOrganizations,
  listTargetsByOrganization,
  setDeviceOrganization,
  setDeviceTarget,
};
