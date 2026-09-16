// src/db/cheerstickQueries.js
// WebView（ユーザー名登録・チーム選択・推し選択・geturl）で使うDBクエリ集。
// コントローラー/WebSocketハンドラーからはこのモジュール経由でDBにアクセスする。

'use strict';

const crypto = require('crypto');

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
     WHERE cl.device_id = $1 AND e.hidden_at IS NULL
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
    `SELECT SUM(cl.intensity) AS total_intensity,
            SUM(cl.duration_ms) AS total_duration_ms,
            COUNT(*) AS total_cheer_count
     FROM cheer_logs cl
     JOIN events e ON cl.event_id = e.id
     WHERE cl.device_id = $1 AND e.hidden_at IS NULL`,
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
     WHERE organization_id = $1 AND status = 'live' AND hidden_at IS NULL
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
 * 管理画面：状態変更ログ（B-2）用に、変更前のtitle/statusのみを取得する。
 * 対象が無ければnull。
 */
async function getEventBasic(eventId) {
  const { rows } = await db.query(`SELECT id, title, status FROM events WHERE id = $1`, [eventId]);
  return rows[0] || null;
}

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
     WHERE e.hidden_at IS NULL
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
 * 管理画面：チーム（organizations）一覧を取得。
 * categoryId指定時はそのジャンルのみに絞り込む（B-4、2026-08-19拡張）。
 * 試合登録フォームのプルダウン（id/nameのみ使用）・チーム管理一覧（B-4）の両方で使う。
 */
async function listOrganizationsForAdmin(categoryId) {
  const whereClauses = [];
  const values = [];
  let i = 1;

  if (categoryId) {
    whereClauses.push(`o.category_id = $${i}`);
    values.push(categoryId);
    i += 1;
  }
  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT o.id, o.name, o.logo_url, o.category_id, c.name AS category_name,
            o.is_active, o.created_at
     FROM organizations o
     LEFT JOIN categories c ON c.id = o.category_id
     ${whereSql}
     ORDER BY o.name`,
    values
  );
  return rows;
}

/**
 * 管理画面：チームを新規登録する（B-4、2026-08-19新設）。
 * category_id（ジャンル）は必須（ジャンル未設定のチームはlistOrganizations()の
 * デバイス向けチーム一覧に一切現れず実質使えなくなるため、呼び出し元で必須チェックする）。
 *
 * typeはB-4指示書に無い列（organizations.type、NOT NULL、football_club/baseball_club等の
 * 組織種別ラベル。category_id＝ジャンルとは別軸で、現行コードのクエリからは一切参照されない）。
 * 指示書に登場しないため、指定が無ければ既存データ（V・ファーレン長崎）と同じ
 * 'football_club'をデフォルトとする。UI上の入力項目としては公開していない。
 */
async function createOrganizationAdmin({ name, categoryId, logoUrl, type }) {
  await assertCategoryExists(categoryId);

  const { rows } = await db.query(
    `INSERT INTO organizations (name, type, category_id, logo_url)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, type, category_id, logo_url, is_active, created_at`,
    [name, type || 'football_club', categoryId, logoUrl || null]
  );
  return rows[0];
}

/**
 * 管理画面：チームを部分更新する（B-4、2026-08-19新設。updateEventと同じ方式）。
 * fieldsに無いキーは更新しない。categoryIdが含まれる場合は実在確認する。
 * 対象が無い場合はnullを返す（呼び出し元で404にマッピングする）。
 */
async function updateOrganizationAdmin(organizationId, fields) {
  const columnMap = { name: 'name', categoryId: 'category_id', logoUrl: 'logo_url' };

  if (Object.prototype.hasOwnProperty.call(fields, 'categoryId') && fields.categoryId != null) {
    await assertCategoryExists(fields.categoryId);
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
      `SELECT id, name, type, category_id, logo_url, is_active, created_at
       FROM organizations WHERE id = $1`,
      [organizationId]
    );
    return rows[0] || null;
  }

  values.push(organizationId);
  const { rows } = await db.query(
    `UPDATE organizations SET ${setClauses.join(', ')}
     WHERE id = $${i}
     RETURNING id, name, type, category_id, logo_url, is_active, created_at`,
    values
  );
  return rows[0] || null;
}

/**
 * 管理画面：応援対象（targets、選手・マスコット等）一覧を取得（2026-09-13新設）。
 * organizationId指定時はそのチーム配下のみに絞り込む。
 * type='mascot'を先頭に出すORDER BYは、listTargetsByOrganization()
 * （WebView推し選択、既存実装）と同じ並び順の考え方を踏襲している。
 */
async function listTargetsAdmin(organizationId) {
  const whereClauses = [];
  const values = [];
  let i = 1;

  if (organizationId) {
    whereClauses.push(`t.organization_id = $${i}`);
    values.push(organizationId);
    i += 1;
  }
  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT t.id, t.organization_id, o.name AS organization_name, t.name, t.type,
            t.image_url, t.number, t.profile_text, t.is_active, t.created_at
     FROM targets t
     LEFT JOIN organizations o ON o.id = t.organization_id
     ${whereSql}
     ORDER BY o.name NULLS LAST, (t.type = 'mascot') DESC, t.number NULLS LAST, t.name`,
    values
  );
  return rows;
}

/**
 * 管理画面：応援対象（target）を新規登録する（2026-09-13新設）。
 * organization_idは必須（DB上のtargets.organization_idはNULL許容だが、所属チームの
 * 無いtargetはlistTargetsByOrganization()経由のWebView推し選択に一切現れず実質使えなく
 * なるため、organizations.category_idと同じ考え方でアプリ層で必須とする）。
 * organization_idが実在しない場合はORGANIZATION_NOT_FOUNDを投げる。
 * metadataは本APIの対象外（管理画面の入力項目に含まれないため、DB既定値'{}'のまま。
 * 既存の空枠仕様・profile_text追加時と同じ判断で、種別固有の追加属性は現時点では
 * 直接SQLでの編集対象のままとする）。
 */
async function createTargetAdmin({ name, organizationId, type, imageUrl, number, profileText, isActive }) {
  await assertOrganizationExists(organizationId);

  const { rows } = await db.query(
    `INSERT INTO targets (organization_id, name, type, image_url, number, profile_text, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, organization_id, name, type, image_url, number, profile_text, is_active, created_at`,
    [organizationId, name, type, imageUrl || null, number || null, profileText || null, isActive !== false]
  );
  return rows[0];
}

/**
 * 管理画面：応援対象（target）を部分更新する（2026-09-13新設。updateOrganizationAdminと
 * 同じ方式）。fieldsに無いキーは更新しない。organizationIdが含まれる場合は実在確認する。
 * 対象が無い場合はnullを返す（呼び出し元で404にマッピングする）。
 */
async function updateTargetAdmin(targetId, fields) {
  const columnMap = {
    name: 'name',
    organizationId: 'organization_id',
    type: 'type',
    imageUrl: 'image_url',
    number: 'number',
    profileText: 'profile_text',
    isActive: 'is_active',
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
      `SELECT id, organization_id, name, type, image_url, number, profile_text, is_active, created_at
       FROM targets WHERE id = $1`,
      [targetId]
    );
    return rows[0] || null;
  }

  values.push(targetId);
  const { rows } = await db.query(
    `UPDATE targets SET ${setClauses.join(', ')}
     WHERE id = $${i}
     RETURNING id, organization_id, name, type, image_url, number, profile_text, is_active, created_at`,
    values
  );
  return rows[0] || null;
}

/**
 * 管理画面：応援対象（target）を削除する（2026-09-13新設。物理削除）。
 *
 * devices.current_target_id・cheer_logs.target_idはいずれもON DELETE SET NULLのため、
 * DB制約上は削除自体を止めない。しかし11.7章（events削除時の同種問題）と同じ理由で、
 * 「どの選手への応援だったか分からなくなる孤児レコード化」を防ぐため、アプリ層で
 * 事前に参照有無を確認し、参照されている場合は削除をブロックしてTARGET_IN_USEを投げる。
 * event_targets・cheer_summaries・awards・user_target_followsはON DELETE CASCADEだが、
 * これらはいずれも現状未使用の機能（コード上参照箇所が無い）のため、参照チェックの
 * 対象には含めていない。
 * 対象が存在しない場合はnullを返す（呼び出し元で404にマッピングする）。
 */
async function deleteTargetAdmin(targetId) {
  const { rows: exists } = await db.query(`SELECT id FROM targets WHERE id = $1`, [targetId]);
  if (!exists[0]) return null;

  const { rows: deviceRefs } = await db.query(
    `SELECT id FROM devices WHERE current_target_id = $1 LIMIT 1`,
    [targetId]
  );
  if (deviceRefs[0]) {
    const err = new Error('target is referenced by a device (current_target_id)');
    err.code = 'TARGET_IN_USE';
    throw err;
  }

  const { rows: cheerLogRefs } = await db.query(
    `SELECT id FROM cheer_logs WHERE target_id = $1 LIMIT 1`,
    [targetId]
  );
  if (cheerLogRefs[0]) {
    const err = new Error('target is referenced by cheer_logs');
    err.code = 'TARGET_IN_USE';
    throw err;
  }

  await db.query(`DELETE FROM targets WHERE id = $1`, [targetId]);
  return true;
}

/**
 * チーム別・選手別の応援集計（2026-09-13新設）：指定イベントに絞ってtarget単位で
 * cheer_logs.intensityの合計を返す（target-report.html「試合ごと」表示用）。
 * getEventIntensityTotal（event_battlesスコアAPI、既存）と同じSUMパターンをtarget単位の
 * GROUP BYに拡張したもの。cheer_logs.target_idがNULL（推し未選択のままカウントされた行）は
 * targetsへのINNER JOINにより自然に除外される。
 */
async function getEventTargetScores(eventId) {
  const { rows } = await db.query(
    `SELECT t.id AS target_id, t.name AS target_name, t.type AS target_type,
            t.image_url AS target_image_url, t.number AS target_number,
            o.id AS organization_id, o.name AS organization_name, o.color AS organization_color,
            COALESCE(SUM(cl.intensity), 0) AS total_intensity
     FROM cheer_logs cl
     JOIN targets t ON t.id = cl.target_id
     LEFT JOIN organizations o ON o.id = t.organization_id
     WHERE cl.event_id = $1
     GROUP BY t.id, o.id
     ORDER BY total_intensity DESC`,
    [eventId]
  );
  return rows.map((r) => ({ ...r, total_intensity: parseInt(r.total_intensity, 10) }));
}

/**
 * チーム別・選手別の応援集計（2026-09-13新設）：全期間・全試合を通算してtarget単位で
 * intensity合計を返す（target-report.html「全期間通算」表示用）。event_idによる絞り込みが
 * 無いだけで、getEventTargetScoresと同じ集計方式。
 */
async function getAllTimeTargetScores() {
  const { rows } = await db.query(
    `SELECT t.id AS target_id, t.name AS target_name, t.type AS target_type,
            t.image_url AS target_image_url, t.number AS target_number,
            o.id AS organization_id, o.name AS organization_name, o.color AS organization_color,
            COALESCE(SUM(cl.intensity), 0) AS total_intensity
     FROM cheer_logs cl
     JOIN targets t ON t.id = cl.target_id
     LEFT JOIN organizations o ON o.id = t.organization_id
     GROUP BY t.id, o.id
     ORDER BY total_intensity DESC`
  );
  return rows.map((r) => ({ ...r, total_intensity: parseInt(r.total_intensity, 10) }));
}

/**
 * 管理画面：試合を非表示化する（物理削除ではない。詳細はdocs/proposals/admin-hide-endpoint.md）。
 *
 * cheer_logs -> events の外部キー制約がconfdeltype='n'（SET NULL）であり、
 * 物理削除すると参照するcheer_logs.event_idが無言でNULL化されるため、
 * hidden_atへのタイムスタンプ設定で代替する。
 *
 * status='live'の試合は非表示化を許可しない（UPDATEのWHERE句で弾くことで
 * チェックと更新の間の競合を避ける。既知の課題11.2と同種の問題を再生産しないため）。
 * 対象が存在しない場合はnullを返す。live不許可の場合はCANNOT_HIDE_LIVE_EVENTを投げる。
 */
async function hideEvent(eventId) {
  const { rows } = await db.query(
    `UPDATE events
     SET hidden_at = NOW()
     WHERE id = $1 AND status <> 'live'
     RETURNING id, title, status, hidden_at`,
    [eventId]
  );
  if (rows[0]) return rows[0];

  const { rows: existing } = await db.query(`SELECT status FROM events WHERE id = $1`, [eventId]);
  if (!existing[0]) return null;

  const err = new Error('cannot hide a live event');
  err.code = 'CANNOT_HIDE_LIVE_EVENT';
  throw err;
}

/**
 * 管理画面：category_idが実在するか確認する。
 * 無ければCATEGORY_NOT_FOUNDを投げる（呼び出し元で400にマッピングする）。
 */
async function assertCategoryExists(categoryId) {
  const { rows } = await db.query(`SELECT id FROM categories WHERE id = $1`, [categoryId]);
  if (!rows[0]) {
    const err = new Error('category not found');
    err.code = 'CATEGORY_NOT_FOUND';
    throw err;
  }
}

/**
 * 管理画面：ジャンル（categories）一覧をname順で取得。デバイス画面のプルダウン用。
 */
async function listCategoriesForAdmin() {
  const { rows } = await db.query(`SELECT id, name FROM categories ORDER BY name`);
  return rows;
}

/**
 * categories.slug（NOT NULL UNIQUE、migrations/004_add_category.sql）用の値を生成する。
 * この列はアプリコードのどこからも参照されない（`docs/spec.md`調査済み）ため、
 * organizations.type（8.3章）と同じ扱いでUI入力項目としては公開せず、サーバー側で
 * 自動生成する。nameが日本語のみの場合スラグ化すると空文字になるため、常にランダムな
 * サフィックスを付与して一意性を保証する（衝突検知・リトライは行わない）。
 */
function generateCategorySlug(name) {
  const base = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = crypto.randomBytes(4).toString('hex');
  return base ? `${base}-${suffix}` : `category-${suffix}`;
}

/**
 * 管理画面：ジャンルを新規登録する（改善3件フェーズ1、2026-09-16新設）。
 * nameのみを入力項目とする（slugの扱いはgenerateCategorySlug参照）。
 */
async function createCategoryAdmin({ name }) {
  const slug = generateCategorySlug(name);
  const { rows } = await db.query(
    `INSERT INTO categories (name, slug) VALUES ($1, $2)
     RETURNING id, name, slug, created_at`,
    [name, slug]
  );
  return rows[0];
}

/**
 * 管理画面：ジャンルを部分更新する（改善3件フェーズ1、2026-09-16新設。
 * updateOrganizationAdminと同じ部分更新方式）。nameのみ更新可能（slugは更新対象外）。
 * 対象が無い場合はnullを返す（呼び出し元で404にマッピングする）。
 */
async function updateCategoryAdmin(categoryId, fields) {
  if (!Object.prototype.hasOwnProperty.call(fields, 'name')) {
    const { rows } = await db.query(
      `SELECT id, name, slug, created_at FROM categories WHERE id = $1`,
      [categoryId]
    );
    return rows[0] || null;
  }

  const { rows } = await db.query(
    `UPDATE categories SET name = $1 WHERE id = $2
     RETURNING id, name, slug, created_at`,
    [fields.name, categoryId]
  );
  return rows[0] || null;
}

/**
 * 管理画面：デバイス一覧をページング付きで取得。
 * unsetOnly指定時はcategory_id IS NULLのみ、categoryId指定時はそのジャンルのみに絞り込む
 * （両方同時指定は呼び出し元で起きない前提。unsetOnlyを優先する）。
 * macQueryは部分一致（ILIKE）。
 */
async function listDevicesAdmin({ categoryId, unsetOnly, macQuery, limit, offset }) {
  const whereClauses = [];
  const values = [];
  let i = 1;

  if (unsetOnly) {
    whereClauses.push(`d.category_id IS NULL`);
  } else if (categoryId) {
    whereClauses.push(`d.category_id = $${i}`);
    values.push(categoryId);
    i += 1;
  }
  if (macQuery) {
    whereClauses.push(`d.mac_address ILIKE $${i}`);
    values.push(`%${macQuery}%`);
    i += 1;
  }
  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS total FROM devices d ${whereSql}`,
    values
  );
  const total = parseInt(countRows[0].total, 10);

  const listValues = [...values, limit, offset];
  const { rows } = await db.query(
    `SELECT d.id, d.mac_address, d.category_id, c.name AS category_name,
            d.is_demo, d.owner_user_id, d.created_at
     FROM devices d
     LEFT JOIN categories c ON c.id = d.category_id
     ${whereSql}
     ORDER BY d.created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    listValues
  );
  return { rows, total };
}

/**
 * 管理画面：デバイス1件のcategory_id・is_demoを部分更新する（updateEventと同じ方式）。
 * fieldsに無いキーは更新しない。category_idが含まれ、かつnullでない場合は実在確認する。
 * 対象デバイスが無い場合はnullを返す（呼び出し元で404にマッピングする）。
 */
async function updateDeviceAdmin(deviceId, fields) {
  const columnMap = { categoryId: 'category_id', isDemo: 'is_demo' };

  if (Object.prototype.hasOwnProperty.call(fields, 'categoryId') && fields.categoryId != null) {
    await assertCategoryExists(fields.categoryId);
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
      `SELECT id, mac_address, category_id, is_demo, owner_user_id, created_at
       FROM devices WHERE id = $1`,
      [deviceId]
    );
    return rows[0] || null;
  }

  values.push(deviceId);
  const { rows } = await db.query(
    `UPDATE devices SET ${setClauses.join(', ')}
     WHERE id = $${i}
     RETURNING id, mac_address, category_id, is_demo, owner_user_id, created_at`,
    values
  );
  return rows[0] || null;
}

/**
 * 管理画面：複数デバイス（id指定）へ同一のcategory_id・is_demoを一括適用する。
 * 更新件数（rowCount）を返す。
 */
async function bulkUpdateDevicesByIds(ids, fields) {
  const columnMap = { categoryId: 'category_id', isDemo: 'is_demo' };
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
  if (setClauses.length === 0) return 0;

  values.push(ids);
  const { rowCount } = await db.query(
    `UPDATE devices SET ${setClauses.join(', ')} WHERE id = ANY($${i}::uuid[])`,
    values
  );
  return rowCount;
}

/**
 * 管理画面：絞り込み条件（filter）に一致する全デバイスへ同一のcategory_id・is_demoを
 * 一括適用する。IDを1件ずつ送らずに済むため、ページをまたいだ「全件」操作に使う。
 *
 * 誤操作防止：filterに何も条件が無い場合（devices全件が対象になる場合）はFILTER_REQUIREDを
 * 投げて拒否する。絞り込みは呼び出し元（GET /admin/devicesの一覧）と同じ条件を使うこと。
 */
async function bulkUpdateDevicesByFilter(filter, fields) {
  const columnMap = { categoryId: 'category_id', isDemo: 'is_demo' };
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
  if (setClauses.length === 0) return 0;

  const whereClauses = [];
  if (filter.unsetOnly) {
    whereClauses.push(`category_id IS NULL`);
  } else if (filter.categoryId) {
    whereClauses.push(`category_id = $${i}`);
    values.push(filter.categoryId);
    i += 1;
  }
  if (filter.macQuery) {
    whereClauses.push(`mac_address ILIKE $${i}`);
    values.push(`%${filter.macQuery}%`);
    i += 1;
  }

  if (whereClauses.length === 0) {
    const err = new Error('filter must narrow down at least one condition');
    err.code = 'FILTER_REQUIRED';
    throw err;
  }

  const { rowCount } = await db.query(
    `UPDATE devices SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
    values
  );
  return rowCount;
}

/**
 * 管理画面：デバイスを1件、単体登録する。macAddressは呼び出し元で正規化済みのこと。
 * 重複（UNIQUE制約違反、pg_code 23505）はDEVICE_ALREADY_EXISTSとして投げる。
 */
async function createDeviceAdmin({ macAddress, categoryId, isDemo }) {
  if (categoryId) await assertCategoryExists(categoryId);

  try {
    const { rows } = await db.query(
      `INSERT INTO devices (mac_address, status, category_id, is_demo)
       VALUES ($1, 'active', $2, $3)
       RETURNING id, mac_address, category_id, is_demo, owner_user_id, created_at`,
      [macAddress, categoryId || null, !!isDemo]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const e = new Error('device already exists');
      e.code = 'DEVICE_ALREADY_EXISTS';
      throw e;
    }
    throw err;
  }
}

/**
 * 管理画面：CSV取り込み。呼び出し元で正規化・重複除去済みのMACアドレス配列を受け取り、
 * ON CONFLICT DO NOTHINGで一括INSERTする。実際に新規作成された行のmac_addressのみを返す
 * （RETURNINGにはON CONFLICT DO NOTHINGでスキップされた行は含まれないため、
 *  戻り値との差分＝DB側で既存だった重複件数として呼び出し元で算出する）。
 */
async function importDevices(macAddresses) {
  if (macAddresses.length === 0) return [];

  const values = [];
  const placeholders = macAddresses
    .map((mac, idx) => {
      values.push(mac);
      return `($${idx + 1}, 'active')`;
    })
    .join(',');

  const { rows } = await db.query(
    `INSERT INTO devices (mac_address, status)
     VALUES ${placeholders}
     ON CONFLICT (mac_address) DO NOTHING
     RETURNING mac_address`,
    values
  );
  return rows.map((r) => r.mac_address);
}

// =============================================================
// 2チーム対抗応援合戦（event_battles）機能
// events テーブルには一切変更を加えず、既存の2イベントをペアリングするだけの
// 別テーブル（migrations/011_add_event_battles.sql）として実装する。
// =============================================================

/**
 * event_battles作成・更新時の共通チェック：eventIdが実在するか確認する。
 * 無ければEVENT_NOT_FOUNDを投げる（呼び出し元で400にマッピングする）。
 */
async function assertEventExists(eventId) {
  const { rows } = await db.query(`SELECT id FROM events WHERE id = $1`, [eventId]);
  if (!rows[0]) {
    const err = new Error('event not found');
    err.code = 'EVENT_NOT_FOUND';
    throw err;
  }
}

/**
 * 管理画面：対抗戦ペアを新規登録する。
 * event_a_id / event_b_id とも実在確認する（無ければEVENT_NOT_FOUND）。
 * 同一イベント同士の指定はDBのCHECK制約でも弾かれるが、エラーメッセージを
 * 分かりやすくするためアプリ側でも先にSAME_EVENTとして弾く。
 */
async function createEventBattle({ label, eventAId, eventBId }) {
  if (eventAId === eventBId) {
    const err = new Error('event_a_id and event_b_id must be different');
    err.code = 'SAME_EVENT';
    throw err;
  }
  await assertEventExists(eventAId);
  await assertEventExists(eventBId);

  const { rows } = await db.query(
    `INSERT INTO event_battles (label, event_a_id, event_b_id)
     VALUES ($1, $2, $3)
     RETURNING id, label, event_a_id, event_b_id, created_at`,
    [label || null, eventAId, eventBId]
  );
  return rows[0];
}

/**
 * 管理画面：対抗戦ペア一覧を取得。一覧表示用に両イベントのtitle・組織名もJOINして返す。
 * events.hidden_at（非表示化）で絞り込みはしない：ペアリング自体の管理台帳のため、
 * 元イベントが非表示化されても一覧からは消さず、表示側でstatus等を見て判断できるようにする。
 */
async function listEventBattles() {
  const { rows } = await db.query(
    `SELECT eb.id, eb.label, eb.created_at,
            ea.id AS event_a_id, ea.title AS event_a_title, ea.status AS event_a_status,
            oa.name AS event_a_organization_name,
            ebv.id AS event_b_id, ebv.title AS event_b_title, ebv.status AS event_b_status,
            ob.name AS event_b_organization_name
     FROM event_battles eb
     JOIN events ea  ON ea.id  = eb.event_a_id
     JOIN events ebv ON ebv.id = eb.event_b_id
     LEFT JOIN organizations oa ON oa.id = ea.organization_id
     LEFT JOIN organizations ob ON ob.id = ebv.organization_id
     ORDER BY eb.created_at DESC`
  );
  return rows;
}

/**
 * 管理画面：対抗戦ペアを削除する（物理削除）。
 * event_battlesは他テーブルから参照されない末端テーブルであり、events/cheer_logsのような
 * SET NULL孤児レコード問題（spec.md 11.7章）が起きないため、非表示化方式は採らない。
 * 対象が無い場合はnullを返す（呼び出し元で404にマッピングする）。
 */
async function deleteEventBattle(battleId) {
  const { rows } = await db.query(
    `DELETE FROM event_battles WHERE id = $1 RETURNING id`,
    [battleId]
  );
  return rows[0] || null;
}

/**
 * スコア表示API：対抗戦ペアのメタ情報（両イベントの組織情報含む）を取得。
 * 無ければnull。status（live/paused/finished等）による絞り込みは行わない
 * （停止中・終了後もその時点のcheer_logs集計をそのまま表示し続ける設計のため）。
 */
async function getEventBattleMeta(battleId) {
  const { rows } = await db.query(
    `SELECT eb.id, eb.label,
            ea.id AS event_a_id, ea.title AS event_a_title,
            oa.id AS org_a_id, oa.name AS org_a_name, oa.logo_url AS org_a_logo_url, oa.color AS org_a_color,
            ebv.id AS event_b_id, ebv.title AS event_b_title,
            ob.id AS org_b_id, ob.name AS org_b_name, ob.logo_url AS org_b_logo_url, ob.color AS org_b_color
     FROM event_battles eb
     JOIN events ea  ON ea.id  = eb.event_a_id
     JOIN events ebv ON ebv.id = eb.event_b_id
     LEFT JOIN organizations oa ON oa.id = ea.organization_id
     LEFT JOIN organizations ob ON ob.id = ebv.organization_id
     WHERE eb.id = $1`,
    [battleId]
  );
  return rows[0] || null;
}

/**
 * スコア表示API：指定イベントのcheer_logs.intensity合計を取得。
 * getAllTimeCheerTotal（デバイス単位・全期間）と同じSUMパターンをevent単位に絞ったもの。
 * 行が無い場合はSUMがNULLになるためCOALESCEで0に丸める。
 */
async function getEventIntensityTotal(eventId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(intensity), 0) AS total_intensity
     FROM cheer_logs
     WHERE event_id = $1`,
    [eventId]
  );
  return parseInt(rows[0].total_intensity, 10);
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
  hideEvent,
  getEventBasic,
  createOrganizationAdmin,
  updateOrganizationAdmin,
  assertCategoryExists,
  listCategoriesForAdmin,
  createCategoryAdmin,
  updateCategoryAdmin,
  listDevicesAdmin,
  updateDeviceAdmin,
  bulkUpdateDevicesByIds,
  bulkUpdateDevicesByFilter,
  createDeviceAdmin,
  importDevices,
  createEventBattle,
  listEventBattles,
  deleteEventBattle,
  getEventBattleMeta,
  getEventIntensityTotal,
  listTargetsAdmin,
  createTargetAdmin,
  updateTargetAdmin,
  deleteTargetAdmin,
  getEventTargetScores,
  getAllTimeTargetScores,
};
