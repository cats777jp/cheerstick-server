#!/usr/bin/env node
// scripts/load-test/cleanup-dummy-devices.js
// 負荷試験用ダミーデバイス（seed-dummy-devices.jsで投入した分）の一括削除。
// mac_addressのprefixで絞り込んでDELETEする。
//
// devices を直接DELETEする前に、外部キー制約が ON DELETE RESTRICT の子テーブル
// （cheer_logs, device_event_sessions）から先に削除する必要がある
// （RESTRICTのため、参照が残っているとdevicesのDELETEがエラーになる）。
//
// 既定では実際の削除は行わず、削除対象件数を表示するだけ（dry run）。
// 実際に削除するには --yes を付ける。
//
// 使い方:
//   node scripts/load-test/cleanup-dummy-devices.js                  # dry run（件数確認のみ）
//   node scripts/load-test/cleanup-dummy-devices.js --yes            # 実際に削除
//   node scripts/load-test/cleanup-dummy-devices.js --mac-prefix=AA:00:00:00 --yes

'use strict';

const { createPool, assertNotProduction } = require('./db');
const { DEFAULT_MAC_PREFIX } = require('./mac-range');

const MIN_PREFIX_LENGTH = 8; // "AA:00:00" 相当以上。短すぎるprefixでの誤爆を避ける安全弁

function parseArgs(argv) {
  const args = { macPrefix: DEFAULT_MAC_PREFIX, yes: false };
  for (const raw of argv) {
    if (raw === '--yes') { args.yes = true; continue; }
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'mac-prefix') args.macPrefix = value;
    else throw new Error(`unknown option: --${key}`);
  }
  if (args.macPrefix.length < MIN_PREFIX_LENGTH) {
    throw new Error(
      `--mac-prefix "${args.macPrefix}" is too short (min ${MIN_PREFIX_LENGTH} chars). ` +
      'A short prefix risks matching real devices.'
    );
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const pool = createPool();
  const likePattern = `${args.macPrefix}%`;

  try {
    const currentDb = await assertNotProduction(pool);
    console.log(`[cleanup] connected to database: ${currentDb}`);
    console.log(`[cleanup] target mac_address LIKE '${likePattern}'`);

    // 対象デバイスの絞り込みはmac_addressのLIKE条件を都度そのままサブクエリで使う
    // （UUID配列パラメータの型キャストに依存する ANY($1) 方式は、ドライバ・DB実装によって
    //  型推論の挙動が変わりうるため避ける）。
    const targetCountRes = await pool.query(
      'SELECT COUNT(*)::int AS n FROM devices WHERE mac_address LIKE $1',
      [likePattern]
    );
    const targetCount = targetCountRes.rows[0].n;
    console.log(`[cleanup] matching devices: ${targetCount}`);

    if (targetCount === 0) {
      console.log('[cleanup] nothing to delete.');
      return;
    }

    const deviceSubquery = 'SELECT id FROM devices WHERE mac_address LIKE $1';

    if (!args.yes) {
      const cheerLogsRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM cheer_logs WHERE device_id IN (${deviceSubquery})`,
        [likePattern]
      );
      const sessionsRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM device_event_sessions WHERE device_id IN (${deviceSubquery})`,
        [likePattern]
      );
      console.log(
        `[cleanup] dry run only. would delete: devices=${targetCount}, ` +
        `cheer_logs=${cheerLogsRes.rows[0].n}, device_event_sessions=${sessionsRes.rows[0].n}`
      );
      console.log('[cleanup] pass --yes to actually delete.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const cheerLogsDel = await client.query(
        `DELETE FROM cheer_logs WHERE device_id IN (${deviceSubquery})`,
        [likePattern]
      );
      const sessionsDel = await client.query(
        `DELETE FROM device_event_sessions WHERE device_id IN (${deviceSubquery})`,
        [likePattern]
      );
      const devicesDel = await client.query(
        'DELETE FROM devices WHERE mac_address LIKE $1',
        [likePattern]
      );

      await client.query('COMMIT');

      console.log(
        `[cleanup] deleted: cheer_logs=${cheerLogsDel.rowCount}, ` +
        `device_event_sessions=${sessionsDel.rowCount}, devices=${devicesDel.rowCount}`
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main().catch((err) => {
    console.error('[cleanup] failed:', err.message);
    process.exit(1);
  });
}
