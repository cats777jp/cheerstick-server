-- =============================================================
-- migrations/006_event_status.sql
-- events.status に許可値を制限するCHECK制約を追加（応援量カウント機能）
-- =============================================================

-- events.status は 001_initial_schema.sql で追加済み
-- （VARCHAR(20) NOT NULL DEFAULT 'scheduled'、コメントのみでDBレベルの値制約はなかった）。
-- 応援量カウント機能で status = 'live' を公式試合の判定条件に使うため、
-- ここで許可値をCHECK制約として明示する（デフォルト値 'scheduled' は変更しない）。
ALTER TABLE events
  ADD CONSTRAINT events_status_check
  CHECK (status IN ('scheduled', 'live', 'paused', 'finished', 'cancelled'));

COMMENT ON CONSTRAINT events_status_check ON events IS
  '応援量カウント機能：試合状態を scheduled/live/paused/finished/cancelled の5値に制限';

-- 応援量カウント機能：デバイスの selected_organization_id から
-- 「現在live中の試合があるか」を検索する際のインデックス
CREATE INDEX idx_events_status ON events (organization_id, status);

-- =============================================================
-- ロールバック用（実行する場合は別途）
-- =============================================================
-- DROP INDEX IF EXISTS idx_events_status;
-- ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
