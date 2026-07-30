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
      t.profile_text             AS target_profile_text,
      o.id                       AS org_id,
      o.name                     AS org_name,
      o.logo_url                 AS org_logo_url,
      o.color                    AS org_color
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
 *
 * TOFU方式：未登録デバイス、または既に同一ユーザーが登録済みの場合のみ更新する。
 * 別ユーザーが既に登録済みのデバイスへの上書きはWHERE句で弾く（rowCount === 0）。
 */
async function registerDeviceOwner(macAddress, email, displayName) {
  await ensureDevice(macAddress);
  const userId = await findOrCreateUserByEmail(email, displayName);

  const { rowCount } = await db.query(
    `UPDATE devices
     SET owner_user_id = $1, registered_at = NOW()
     WHERE mac_address = $2
       AND (owner_user_id IS NULL OR owner_user_id = $1)`,
    [userId, macAddress]
  );

  if (rowCount === 0) {
    const err = new Error('device is already registered to a different user');
    err.code = 'DEVICE_ALREADY_REGISTERED';
    throw err;
  }

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

/**
 * 応援量カウント機能：指定organizationで現在status='live'のイベントを1件取得。
 * 無ければnull（公式試合外のためDB保存をスキップする判定に使う）。
 */
async function findLiveEventForOrganization(organizationId) {
  const { rows } = await db.query(
    `SELECT id, title, starts_at
     FROM events
     WHERE organization_id = $1 AND status = 'live'
     ORDER BY starts_at DESC
     LIMIT 1`,
    [organizationId]
  );
  return rows[0] || null;
}

/**
 * 応援量カウント機能：応援ログ（cheer_logs）へ1件INSERTする。
 */
async function insertCheerLog({ deviceId, userId, eventId, targetId, intensity, durationMs }) {
  await db.query(
    `INSERT INTO cheer_logs (device_id, user_id, event_id, target_id, intensity, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [deviceId, userId, eventId, targetId, intensity, durationMs || 0]
  );
}

// 006_event_status.sql のCHECK制約と一致させる許可値
const EVENT_STATUSES = ['scheduled', 'live', 'paused', 'finished', 'cancelled'];

/**
 * 管理用：イベントの試合状態(status)を更新。
 * EVENT_STATUSES以外の値は拒否する（DBのCHECK制約より前にアプリ側で弾く）。
 *
 * statusを'live'にする場合、同じorganization_idに既にstatus='live'の
 * 別イベントが無いかを確認する。findLiveEventForOrganizationはLIMIT 1
 * のため、liveが重複すると応援ログが意図しない試合へ記録されてしまう。
 */
async function updateEventStatus(eventId, status) {
  if (!EVENT_STATUSES.includes(status)) {
    const err = new Error(`invalid status: ${status}`);
    err.code = 'INVALID_STATUS';
    throw err;
  }

  if (status === 'live') {
    const { rows: currentRows } = await db.query(
      `SELECT organization_id FROM events WHERE id = $1`,
      [eventId]
    );
    const organizationId = currentRows[0] && currentRows[0].organization_id;

    if (organizationId) {
      const { rows: conflictRows } = await db.query(
        `SELECT id, title FROM events
         WHERE organization_id = $1 AND status = 'live' AND id <> $2
         LIMIT 1`,
        [organizationId, eventId]
      );
      if (conflictRows[0]) {
        const err = new Error('another event is already live for this organization');
        err.code = 'LIVE_EVENT_CONFLICT';
        err.conflict = conflictRows[0];
        throw err;
      }
    }
  }

  const { rows } = await db.query(
    `UPDATE events SET status = $1 WHERE id = $2 RETURNING id, status`,
    [status, eventId]
  );
  return rows[0] || null;
}

/**
 * 管理画面：organization_idが実在するか確認する。
 * 無ければORGANIZATION_NOT_FOUNDを投げる（呼び出し元で400にマッピングする）。
 */
async function assertOrganizationExists(organizationId) {
  const { rows } = await db.query(`SELECT id FROM organizations WHERE id = $1`, [organizationId]);
  if (!rows[0]) {
    const err = new Error('organization not found');
    err.code = 'ORGANIZATION_NOT_FOUND';
    throw err;
  }
}

/**
 * 管理画面：試合管理API用に全イベントをstarts_at DESCで取得。
 * organization名もJOINして含める（プルダウン表示は別途listOrganizationsForAdminを使う）。
 */
async function listEventsAdmin() {
  const { rows } = await db.query(
    `SELECT e.id, e.title, e.organization_id, o.name AS organization_name,
            e.starts_at, e.ends_at, e.status, e.created_at
     FROM events e
     LEFT JOIN organizations o ON o.id = e.organization_id
     ORDER BY e.starts_at DESC`
  );
  return rows;
}

/**
 * 管理画面：試合を新規登録する（statusは既定値'scheduled'のまま）。
 * organization_idが実在しない場合はORGANIZATION_NOT_FOUNDを投げる。
 */
async function createEvent({ title, organizationId, startsAt, endsAt }) {
  await assertOrganizationExists(organizationId);

  const { rows } = await db.query(
    `INSERT INTO events (organization_id, title, starts_at, ends_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, organization_id, title, starts_at, ends_at, status, created_at`,
    [organizationId, title, startsAt, endsAt || null]
  );
  return rows[0];
}

/**
 * 管理画面：渡されたフィールドのみを部分更新する。
 * fieldsに無いキーは更新しない。organizationIdが含まれる場合は実在確認する。
 * 対象イベントが無い場合、または更新対象フィールドが無い場合はnullを返す
 * （呼び出し元で404にマッピングする）。
 */
async function updateEvent(eventId, fields) {
  const columnMap = {
    title: 'title',
    organizationId: 'organization_id',
    startsAt: 'starts_at',
    endsAt: 'ends_at',
  };

  if (Object.prototype.hasOwnProperty.call(fields, 'organizationId')) {
    await assertOrganizationExists(fields.organizationId);
  }

  const setClauses = [];
  const values = [];
  let i = 1;

  for (const [key, column] of Object.entries(columnMap)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      setClauses.push(`${column} = $${i}`);
      values.push(fields[key]);
      i += 1;
    }
  }

  if (setClauses.length === 0) {
    const { rows } = await db.query(
      `SELECT id, organization_id, title, starts_at, ends_at, status, created_at
       FROM events WHERE id = $1`,
      [eventId]
    );
    return rows[0] || null;
  }

  values.push(eventId);
  const { rows } = await db.query(
    `UPDATE events SET ${setClauses.join(', ')}
     WHERE id = $${i}
     RETURNING id, organization_id, title, starts_at, ends_at, status, created_at`,
    values
  );
  return rows[0] || null;
}

/**
 * 管理画面：試合登録フォームのプルダウン用にid/nameのみ取得。
 */
async function listOrganizationsForAdmin() {
  const { rows } = await db.query(`SELECT id, name FROM organizations ORDER BY name`);
  return rows;
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
  findLiveEventForOrganization,
  insertCheerLog,
  updateEventStatus,
  listEventsAdmin,
  createEvent,
  updateEvent,
  listOrganizationsForAdmin,
};
