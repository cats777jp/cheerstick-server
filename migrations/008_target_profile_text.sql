-- =============================================================
-- migrations/008_target_profile_text.sql
-- targets にプロフィール文（profile_text）を追加
-- =============================================================

-- 選手・マスコット等（targets、type列で汎用管理）のプロフィール文。
-- 既存の metadata.description（自由記述のJSONBフィールド）とは別に、
-- 「プロフィール枠」として画面に固定表示するための専用列を用意する。
-- 未設定の場合はNULLのまま（フロントは行ごと非表示にする）。
ALTER TABLE targets
  ADD COLUMN IF NOT EXISTS profile_text TEXT;

COMMENT ON COLUMN targets.profile_text IS
  'プロフィール文。未設定の場合はNULL（フロントは表示行ごと非表示にする）';

-- =============================================================
-- ロールバック用（実行する場合は別途）
-- =============================================================
-- ALTER TABLE targets DROP COLUMN IF EXISTS profile_text;
