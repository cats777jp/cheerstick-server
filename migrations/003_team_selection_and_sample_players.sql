-- =============================================================
-- migrations/003_team_selection_and_sample_players.sql
-- 「チーム選択」ステップの追加、およびデモ用サンプル選手データ投入
-- =============================================================

-- devices に「選択中のチーム（組織）」を追加
-- current_target_id（推し選択）とは別に、まず「チーム」を選び、
-- そのチーム配下の選手/マスコットから「推し」を選ぶ2段階選択にする
ALTER TABLE devices
    ADD COLUMN selected_organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

COMMENT ON COLUMN devices.selected_organization_id IS 'このデバイスが選択した応援チーム（組織）。推し選手選択の前段階';

CREATE INDEX idx_devices_selected_organization_id
    ON devices (selected_organization_id);

-- =============================================================
-- デモ用サンプル選手データ
-- ※実名・実写真ではなく、選手選択UIの動作確認用プレースホルダーです。
--   実際の選手データは、選手写真等の使用許諾取得後にCSVインポート機能（STEP13）で投入します。
-- =============================================================

INSERT INTO targets (id, organization_id, name, type, image_url, number, metadata) VALUES
    ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001',
     'サンプル選手A', 'player', NULL, '7', '{"position": "FW"}'),
    ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001',
     'サンプル選手B', 'player', NULL, '10', '{"position": "MF"}'),
    ('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000001',
     'サンプル選手C', 'player', NULL, '1', '{"position": "GK"}')
ON CONFLICT (id) DO NOTHING;
