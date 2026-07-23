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
      d.category_id,
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
 * デバイスのcategory_idに属するチームのみに絞り込む
 * （グッズがジャンル単位で販売されるため、異なるジャンルのチームは選択肢に出さない）。
 */
async function listOrganizations(categoryId) {
  const { rows } = await db.query(
    `SELECT id, name, logo_url FROM organizations WHERE category_id = $1 AND is_active = TRUE ORDER BY name`,
    [categoryId]
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
 * 選択中デバイスのcategory_idに属さないorganizationは拒否する。
 */
async function setDeviceOrganization(macAddress, organizationId) {
  await ensureDevice(macAddress);

  const { rows } = await db.query(
    `SELECT d.category_id AS device_category_id, o.category_id AS org_category_id
     FROM devices d, organizations o
     WHERE d.mac_address = $1 AND o.id = $2`,
    [macAddress, organizationId]
  );

  const row = rows[0];
  if (!row || !row.device_category_id || row.device_category_id !== row.org_category_id) {
    const err = new Error('organization does not belong to the device category');
    err.code = 'CATEGORY_MISMATCH';
    throw err;
  }

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

/**
 * データ参照機能（トークン無効時）：MACアドレスからdevices.idのみを取得（ホワイトリスト照合用）。
 * メールアドレス等の個人情報は含めない。
 */
async function getDeviceIdByMac(macAddress) {
  const { rows } = await db.query(
    `SELECT id AS device_id FROM devices WHERE mac_address = $1`,
    [macAddress]
  );
  return rows[0] || null;
}

/**
 * データ参照機能：デバイスID（devices.id）からプロフィール（ニックネーム・チーム・推し）を取得。
 * メールアドレスは参照ページに出さないため、SELECTしない。
 */
async function getDeviceReferenceProfile(deviceId) {
  const { rows } = await db.query(
    `SELECT d.mac_address, u.display_name AS nickname,
            o.name AS team_name, o.logo_url AS team_logo_url,
            t.name AS player_name, t.image_url AS player_image_url, t.number AS player_number
     FROM devices d
     LEFT JOIN users u ON d.owner_user_id = u.id
     LEFT JOIN organizations o ON d.selected_organization_id = o.id
     LEFT JOIN targets t ON d.current_target_id = t.id
     WHERE d.id = $1`,
    [deviceId]
  );
  return rows[0] || null;
}

/**
 * データ参照機能：デバイスの直近イベント別の応援量集計（新しい順、limit件）を取得。
 */
async function getRecentEventCheerTotals(deviceId, limit) {
  const { rows } = await db.query(
    `SELECT cl.event_id, e.title, e.starts_at,
            SUM(cl.intensity) AS total_intensity,
            SUM(cl.duration_ms) AS total_duration_ms,
            COUNT(*) AS cheer_count
     FROM cheer_logs cl
     JOIN events e ON cl.event_id = e.id
     WHERE cl.device_id = $1
     GROUP BY cl.event_id, e.title, e.starts_at
     ORDER BY e.starts_at DESC
     LIMIT $2`,
    [deviceId, limit]
  );
  return rows;
}

/**
 * データ参照機能：デバイスの全期間累計応援量を取得。
 */
async function getAllTimeCheerTotal(deviceId) {
  const { rows } = await db.query(
    `SELECT SUM(intensity) AS total_intensity,
            SUM(duration_ms) AS total_duration_ms,
            COUNT(*) AS total_cheer_count
     FROM cheer_logs
     WHERE device_id = $1`,
    [deviceId]
  );
  return rows[0];
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
  getDeviceIdByMac,
  getDeviceReferenceProfile,
  getRecentEventCheerTotals,
  getAllTimeCheerTotal,
};
