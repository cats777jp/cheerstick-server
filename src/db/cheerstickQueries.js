// src/db/cheerstickQueries.js
// WebView（ユーザー名登録・推し選択・geturl）で使うDBクエリ集。
// コントローラー/WebSocketハンドラーからはこのモジュール経由でDBにアクセスする。

'use strict';

const db = require('./index');

/**
 * MACアドレスからデバイス情報（紐づくユーザー・推し対象を含む）を取得。
 * 未登録デバイスの場合は null を返す。
 */
async function findDeviceWithProfile(macAddress) {
  const { rows } = await db.query(
    `
    SELECT
      d.id                AS device_id,
      d.mac_address,
      d.owner_user_id,
      d.current_target_id,
      u.display_name,
      u.email,
      t.id                AS target_id,
      t.name              AS target_name,
      t.type              AS target_type,
      t.image_url         AS target_image_url,
      t.metadata          AS target_metadata,
      o.id                AS org_id,
      o.name              AS org_name,
      o.logo_url          AS org_logo_url
    FROM devices d
    LEFT JOIN users u        ON u.id = d.owner_user_id
    LEFT JOIN targets t      ON t.id = d.current_target_id
    LEFT JOIN organizations o ON o.id = t.organization_id
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
 * デバイスの「推し（現在応援中の対象）」を設定。
 */
async function setDeviceTarget(macAddress, targetId) {
  await ensureDevice(macAddress);
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
  setDeviceTarget,
};
