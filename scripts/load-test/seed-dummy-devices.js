#!/usr/bin/env node
// scripts/load-test/seed-dummy-devices.js
// 負荷試験用：category_id設定済みのダミーデバイスをdevicesテーブルへ一括投入する。
//
// 「organization_id設定済み」について：devices テーブルには単純な organization_id 列は
// 無く（selected_organization_id はWebSocket select_team で初めて設定される値のため、
// 事前投入の対象にしていない）、実際に必要なのは「select_teamで選択できるorganizationが
// 存在し、そのcategory_idがダミーデバイスのcategory_idと一致していること」（一致しないと
// CATEGORY_MISMATCHで拒否される）。そのため本スクリプトは --organization-id を必須の
// 検証対象として受け取り、指定organizationのcategory_idとダミーデバイスのcategory_idが
// 一致することを事前に確認したうえで投入する（devices側には書き込まない）。
//
// 使い方:
//   node scripts/load-test/seed-dummy-devices.js --count=2000
//   node scripts/load-test/seed-dummy-devices.js --count=20000 --start-index=2000
//   node scripts/load-test/seed-dummy-devices.js --count=100 --category-id=<uuid> --organization-id=<uuid>
//
// 既定値：
//   --category-id      10000000-0000-0000-0000-000000000001 （migrations/004、Jリーグ）
//   --organization-id  00000000-0000-0000-0000-000000000001 （migrations/002、V・ファーレン長崎）
//   --mac-prefix        AA:00:00:00
//   --start-index       0
//
// 冪等性：mac_addressのUNIQUE制約により ON CONFLICT (mac_address) DO UPDATE で
// category_idを揃える（再実行しても安全）。

'use strict';

const { createPool, assertNotProduction } = require('./db');
const { DEFAULT_MAC_PREFIX, macForIndex } = require('./mac-range');

const DEFAULT_CATEGORY_ID = '10000000-0000-0000-0000-000000000001';
const DEFAULT_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';
const BATCH_SIZE = 500;

function parseArgs(argv) {
  const args = {
    count: 100,
    categoryId: DEFAULT_CATEGORY_ID,
    organizationId: DEFAULT_ORGANIZATION_ID,
    macPrefix: DEFAULT_MAC_PREFIX,
    startIndex: 0,
  };
  for (const raw of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case 'count': args.count = parseInt(value, 10); break;
      case 'category-id': args.categoryId = value; break;
      case 'organization-id': args.organizationId = value; break;
      case 'mac-prefix': args.macPrefix = value; break;
      case 'start-index': args.startIndex = parseInt(value, 10); break;
      default:
        throw new Error(`unknown option: --${key}`);
    }
  }
  if (!Number.isInteger(args.count) || args.count <= 0) {
    throw new Error('--count must be a positive integer');
  }
  if (!Number.isInteger(args.startIndex) || args.startIndex < 0) {
    throw new Error('--start-index must be a non-negative integer');
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const pool = createPool();

  try {
    const currentDb = await assertNotProduction(pool);
    console.log(`[seed] connected to database: ${currentDb}`);

    const categoryRes = await pool.query('SELECT id, name FROM categories WHERE id = $1', [args.categoryId]);
    if (categoryRes.rowCount === 0) {
      throw new Error(`category not found: ${args.categoryId}`);
    }
    console.log(`[seed] category: ${categoryRes.rows[0].name} (${args.categoryId})`);

    const orgRes = await pool.query('SELECT id, name, category_id FROM organizations WHERE id = $1', [args.organizationId]);
    if (orgRes.rowCount === 0) {
      throw new Error(`organization not found: ${args.organizationId}`);
    }
    if (orgRes.rows[0].category_id !== args.categoryId) {
      throw new Error(
        `organization "${orgRes.rows[0].name}" belongs to category ${orgRes.rows[0].category_id}, ` +
        `not the requested category ${args.categoryId}. select_team would fail with CATEGORY_MISMATCH ` +
        'for these dummy devices. Pass --organization-id / --category-id consistently.'
      );
    }
    console.log(`[seed] organization for select_team: ${orgRes.rows[0].name} (${args.organizationId})`);

    console.log(
      `[seed] inserting ${args.count} dummy devices ` +
      `(mac ${macForIndex(args.macPrefix, args.startIndex)} .. ${macForIndex(args.macPrefix, args.startIndex + args.count - 1)})`
    );

    let inserted = 0;
    let updated = 0;

    for (let batchStart = 0; batchStart < args.count; batchStart += BATCH_SIZE) {
      const batchCount = Math.min(BATCH_SIZE, args.count - batchStart);
      const values = [];
      const params = [];
      for (let i = 0; i < batchCount; i++) {
        const index = args.startIndex + batchStart + i;
        const mac = macForIndex(args.macPrefix, index);
        const base = params.length;
        params.push(mac, args.categoryId);
        values.push(`($${base + 1}, $${base + 2}, 'active')`);
      }

      const macsInBatch = params.filter((_, idx) => idx % 2 === 0);
      // "xmax = 0" によるINSERT/UPDATE判定はpg-mem未対応のため、事前に既存分をSELECTして判定する
      // （実PostgreSQL・pg-memの両方で動く実装を優先し、あえてこの方式に揃えている）。
      const existingRes = await pool.query(
        'SELECT mac_address FROM devices WHERE mac_address = ANY($1)',
        [macsInBatch]
      );
      const existingSet = new Set(existingRes.rows.map((r) => r.mac_address));

      await pool.query(
        `
        INSERT INTO devices (mac_address, category_id, status)
        VALUES ${values.join(', ')}
        ON CONFLICT (mac_address) DO UPDATE
          SET category_id = EXCLUDED.category_id,
              status = 'active'
        `,
        params
      );

      for (const mac of macsInBatch) {
        if (existingSet.has(mac)) updated++;
        else inserted++;
      }

      process.stdout.write(
        `\r[seed] progress: ${Math.min(batchStart + batchCount, args.count)}/${args.count}`
      );
    }
    process.stdout.write('\n');

    console.log(`[seed] done. inserted=${inserted} updated(existing)=${updated} total=${inserted + updated}`);
  } finally {
    await pool.end();
  }
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main().catch((err) => {
    console.error('[seed] failed:', err.message);
    process.exit(1);
  });
}
