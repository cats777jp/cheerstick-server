require('dotenv').config();
const db = require('./index');

const migrations = [
  `CREATE TABLE IF NOT EXISTS devices (
    id               UUID PRIMARY KEY,
    serial_number    VARCHAR(64) UNIQUE NOT NULL,
    firmware_version VARCHAR(32),
    location         VARCHAR(255),
    status           VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS events (
    id          UUID PRIMARY KEY,
    device_id   UUID REFERENCES devices(id) ON DELETE SET NULL,
    event_type  VARCHAR(64) NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_events_device_id  ON events(device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC)`,
];

(async () => {
  for (const sql of migrations) {
    await db.query(sql);
    console.log('OK:', sql.slice(0, 60).replace(/\s+/g, ' '));
  }
  console.log('Migration complete');
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
