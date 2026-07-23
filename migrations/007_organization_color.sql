-- =============================================================
-- migrations/007_organization_color.sql
-- organizations にチームカラー（color）を追加（LED制御・UIアクセントカラー用）
-- =============================================================

-- チームごとのブランドカラー（HEX形式、例: '#005AAA'）。
-- 応援中画面のLED色計算・フロントの--team-cssカスタムプロパティで使用する。
-- 新規チーム追加時はNULLのまま作成し、都度設定する運用を想定（今回は必須化しない）。
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS color VARCHAR(7);

COMMENT ON COLUMN organizations.color IS
  'チームカラー（HEX形式、例: #005AAA）。LED制御・UIアクセントカラーに使用。未設定の場合はNULL';

-- 既存データ（V・ファーレン長崎）の初期値
UPDATE organizations
SET color = '#005AAA'
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND color IS NULL;

-- =============================================================
-- ロールバック用（実行する場合は別途）
-- =============================================================
-- ALTER TABLE organizations DROP COLUMN IF EXISTS color;
