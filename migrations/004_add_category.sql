-- ============================================================
-- Migration 004: カテゴリー（ジャンル）機能の追加
-- 作成日: 2026-07-22
--
-- 概要:
--   応援グッズは「Jリーグ用」「Vリーグ用」のようにジャンル単位で
--   販売されるため、量産機のMACアドレスは入荷ロット段階で
--   KMT側がカテゴリーを振り分けてCSVインポートする前提。
--
--   将来の拡張（チーム専用グッズ）に備え、devices側には
--   preset_organization_id という予約カラムも合わせて用意しておく
--   （今回は未使用・NULL固定）。
-- ============================================================

-- ------------------------------------------------------------
-- 1. カテゴリーマスタ
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,   -- 例: "Jリーグ", "Vリーグ"
  slug        VARCHAR(50)  NOT NULL UNIQUE, -- 例: "j-league", "v-league"
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- 初期データ（判明している分。必要に応じて追加）
INSERT INTO categories (id, name, slug)
VALUES ('10000000-0000-0000-0000-000000000001', 'Jリーグ', 'j-league')
ON CONFLICT (slug) DO NOTHING;

-- ------------------------------------------------------------
-- 2. organizations にカテゴリーを紐付け（必須）
-- ------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id);

-- 既存データ（V・ファーレン長崎）をJリーグに紐付け
UPDATE organizations
SET category_id = '10000000-0000-0000-0000-000000000001'
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND category_id IS NULL;

-- 今後、新規organizationsを追加する際はcategory_idを必須運用とする
-- (アプリケーション側でバリデーション。DB制約でのNOT NULL化は
--  全既存レコードにcategory_idが入ったことを確認後、別マイグレーションで実施)

-- ------------------------------------------------------------
-- 3. devices にカテゴリー・将来拡張用カラムを追加
-- ------------------------------------------------------------
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id);

-- 【将来拡張用・今回は未使用】
-- チーム専用グッズ（例: Jリーグ・Vファーレン長崎専用）が登場した際、
-- MACアドレス単位でチームまで確定させるための予約カラム。
-- 値が入っている場合、team_selectionをスキップしてplayer_selectionへ
-- 直接遷移させる想定（今回は実装しない。カラムのみ用意）。
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS preset_organization_id UUID REFERENCES organizations(id);

-- 既存の動作確認用デバイス（テスト機）があれば、暫定でJリーグに紐付け
-- ※本番の量産機MACリストは今後CSVインポート機能で正式投入する想定
UPDATE devices
SET category_id = '10000000-0000-0000-0000-000000000001'
WHERE category_id IS NULL;

-- ============================================================
-- ロールバック用（実行する場合は別途）
-- ============================================================
-- ALTER TABLE devices DROP COLUMN IF EXISTS preset_organization_id;
-- ALTER TABLE devices DROP COLUMN IF EXISTS category_id;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS category_id;
-- DROP TABLE IF EXISTS categories;
