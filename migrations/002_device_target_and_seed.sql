-- =============================================================
-- migrations/002_device_target_and_seed.sql
-- WebView（ユーザー名登録・推し選択）実装に伴うスキーマ追加
-- =============================================================

-- devices に「現在応援中の対象（推し）」を1つ持たせる
-- 恒久的なフォロー関係は user_target_follows で別途管理可能だが、
-- 「このデバイスは今どの対象を応援しているか」はUI表示上デバイス単位で持つ方が単純
ALTER TABLE devices
    ADD COLUMN current_target_id UUID REFERENCES targets(id) ON DELETE SET NULL;

COMMENT ON COLUMN devices.current_target_id IS 'このデバイスが現在応援対象として選択しているtarget（推し選択、WebView上のoshi_id相当）';

CREATE INDEX idx_devices_current_target_id
    ON devices (current_target_id);

-- =============================================================
-- シードデータ：V・ファーレン長崎 ＋ マスコット「ヴィヴィくん」
-- （動作確認用。実運用データはSTEP13のCSVインポート等で別途投入）
-- =============================================================

INSERT INTO organizations (id, name, type, country_code, logo_url)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'V・ファーレン長崎',
    'football_club',
    'JP',
    'https://app.cheerstick.com/images/teams/1.png'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO targets (id, organization_id, name, type, image_url, metadata)
VALUES (
    '00000000-0000-0000-0000-000000000101',
    '00000000-0000-0000-0000-000000000001',
    'ヴィヴィくん',
    'mascot',
    'https://app.cheerstick.com/images/members/1/1.png',
    '{"description": "V・ファーレン長崎の公式マスコットキャラクター"}'
)
ON CONFLICT (id) DO NOTHING;
