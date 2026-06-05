require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

// 適用済みマイグレーションを管理するテーブルを作成
const ENSURE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

async function getApplied() {
  const { rows } = await db.query('SELECT filename FROM schema_migrations ORDER BY filename');
  return new Set(rows.map((r) => r.filename));
}

async function run() {
  await db.query(ENSURE_TRACKING_TABLE);

  const applied = await getApplied();

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`SKIP  ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    // 1ファイルをトランザクションで適用し、完了後に記録
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await db.query('COMMIT');
      console.log(`APPLY ${file}`);
      count++;
    } catch (err) {
      await db.query('ROLLBACK');
      throw new Error(`Failed on ${file}: ${err.message}`);
    }
  }

  console.log(`\nMigration complete. ${count} file(s) applied.`);
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
