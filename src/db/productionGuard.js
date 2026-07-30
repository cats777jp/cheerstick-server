// src/db/productionGuard.js
// 起動時に接続先DBを確認し、意図せず本番へ接続した状態での起動を防ぐガード。
// ALLOW_PRODUCTION_DB=true を明示しない限り、current_database()が
// cheerstick_production の場合は起動せずプロセスを終了する。

'use strict';

const defaultDb = require('./index');

async function assertNotConnectedToProduction(db = defaultDb) {
  const { rows } = await db.query('SELECT current_database() AS db');
  const currentDb = rows[0] && rows[0].db;

  if (currentDb === 'cheerstick_production' && process.env.ALLOW_PRODUCTION_DB !== 'true') {
    console.error(
      `FATAL: connected to "${currentDb}" but ALLOW_PRODUCTION_DB is not "true". ` +
      'Refusing to start to prevent accidental production access.'
    );
    process.exit(1);
  }
}

module.exports = { assertNotConnectedToProduction };
