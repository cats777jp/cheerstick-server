CREATE INDEX IF NOT EXISTS idx_cheer_logs_device_event
    ON cheer_logs (device_id, event_id);

COMMENT ON INDEX idx_cheer_logs_device_event IS
  'データ参照機能：デバイス単位×イベント別の応援量集計クエリ高速化用';
