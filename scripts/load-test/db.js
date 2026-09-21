// scripts/load-test/db.js
// seed-dummy-devices.js / cleanup-dummy-devices.js が共有するDB接続ヘルパー。
// src/db/index.js とは別モジュール（アプリ本体のプールを負荷試験ツールと共有しない）。
//
// 本番誤接続防止：src/db/productionGuard.js と同じ考え方で、接続先DBが
// cheerstick_production の場合は ALLOW_PRODUCTION_DB=true を明示しない限り中断する。
// 負荷試験用のダミーデバイス投入・削除は本番DBに対して絶対に行ってはならない操作のため。

'use strict';

require('dotenv').config();
const { Pool } = require('pg');

function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (.env を確認してください)');
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
}

async function assertNotProduction(pool) {
  const { rows } = await pool.query('SELECT current_database() AS db');
  const currentDb = rows[0] && rows[0].db;
  if (currentDb === 'cheerstick_production' && process.env.ALLOW_PRODUCTION_DB !== 'true') {
    throw new Error(
      `接続先DBが "${currentDb}" です。負荷試験ツールを本番DBに対して実行することはできません ` +
      '（ALLOW_PRODUCTION_DB=true を明示しても、このツールでは許可しません）。'
    );
  }
  return currentDb;
}

module.exports = { createPool, assertNotProduction };
