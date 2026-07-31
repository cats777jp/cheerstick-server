-- =============================================================
-- migrations/010_add_events_hidden_at.sql
-- events に非表示化フラグ（hidden_at）を追加
-- =============================================================

-- 管理画面の「削除」操作を、物理削除ではなく非表示化（論理削除）で実現するための列。
-- cheer_logs -> events の外部キー制約（confdeltype='n'、SET NULL）により、
-- events を物理削除すると参照する cheer_logs.event_id が無言でNULL化されるため
-- （2026-07-31、staging環境で確認）、物理削除は行わず本列でフラグ管理する。
-- NULL = 表示中、非NULL（タイムスタンプ） = 非表示。
-- 詳細: docs/proposals/admin-hide-endpoint.md
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN events.hidden_at IS
  '非表示化した日時。NULLの場合は表示中。管理画面・一般公開系のいずれもこの列で除外判定する（物理削除は行わない）';

-- =============================================================
-- ロールバック用（実行する場合は別途）
-- =============================================================
-- ALTER TABLE events DROP COLUMN IF EXISTS hidden_at;
