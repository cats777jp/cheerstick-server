-- =============================================================
-- migrations/001_initial_schema.sql
-- 初期スキーマ作成マイグレーション
-- 対象: Jリーグ以外のスポーツ・エンタメにも対応する汎用設計
-- =============================================================

-- pgcrypto拡張を有効化（gen_random_uuid() によるUUID生成に使用）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================
-- マスター系テーブル
-- =============================================================

-- ユーザーテーブル
-- メール認証・Google等のOAuth認証の両方に対応
CREATE TABLE users (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email            VARCHAR(255) NOT NULL,
    display_name     VARCHAR(100),
    avatar_url       TEXT,
    auth_provider    VARCHAR(50)  NOT NULL DEFAULT 'email', -- 認証プロバイダー種別（email / google / apple 等）
    auth_provider_id VARCHAR(255),                          -- OAuthプロバイダー側のユーザー識別子
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  users                  IS 'ユーザーアカウント。メール認証・OAuth認証両対応';
COMMENT ON COLUMN users.auth_provider    IS '認証プロバイダー種別（email / google / apple 等）';
COMMENT ON COLUMN users.auth_provider_id IS 'OAuthプロバイダー側のユーザー識別子。emailの場合はNULL';
COMMENT ON COLUMN users.is_active        IS 'アカウント有効フラグ。論理削除に使用';

-- updated_at 自動更新トリガー関数
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- デバイステーブル
-- MACアドレスでデバイスを一意識別し、ユーザーアカウントと紐づける
CREATE TABLE devices (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    mac_address      VARCHAR(17)  NOT NULL,          -- 形式: AA:BB:CC:DD:EE:FF
    serial_number    VARCHAR(100),
    firmware_version VARCHAR(50),
    lot_number       VARCHAR(50),
    status           VARCHAR(20)  NOT NULL DEFAULT 'active', -- デバイス状態（active / inactive / lost 等）
    owner_user_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
    registered_at    TIMESTAMPTZ,                    -- ユーザーへの登録日時
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  devices               IS 'チアースティックデバイス。MACアドレスで一意管理';
COMMENT ON COLUMN devices.mac_address   IS 'デバイスのMACアドレス（一意）。形式: AA:BB:CC:DD:EE:FF';
COMMENT ON COLUMN devices.status        IS 'デバイス状態（active / inactive / lost 等）';
COMMENT ON COLUMN devices.owner_user_id IS 'デバイスを所有するユーザー。紐づけ解除時はNULL';
COMMENT ON COLUMN devices.registered_at IS 'ユーザーがデバイスを登録した日時';

-- 組織テーブル
-- チーム・リーグ・プロダクション等を汎用管理
CREATE TABLE organizations (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(200) NOT NULL,
    type         VARCHAR(50)  NOT NULL,              -- 組織種別（football_club / baseball_club / music_label 等）
    country_code CHAR(2),                            -- 国コード（ISO 3166-1 alpha-2）
    logo_url     TEXT,
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  organizations              IS 'チーム・リーグ・プロダクション等の組織マスター';
COMMENT ON COLUMN organizations.type         IS '組織種別（football_club / baseball_club / music_label 等）';
COMMENT ON COLUMN organizations.country_code IS '国コード（ISO 3166-1 alpha-2）';

-- 会場テーブル
CREATE TABLE venues (
    id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(200)  NOT NULL,
    address      TEXT,
    country_code CHAR(2),                            -- 国コード（ISO 3166-1 alpha-2）
    latitude     NUMERIC(10, 7),                     -- 緯度（小数点以下7桁）
    longitude    NUMERIC(10, 7),                     -- 経度（小数点以下7桁）
    capacity     INTEGER,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  venues           IS 'スタジアム・アリーナ・ホール等の会場マスター';
COMMENT ON COLUMN venues.latitude  IS '緯度（小数点以下7桁）';
COMMENT ON COLUMN venues.longitude IS '経度（小数点以下7桁）';
COMMENT ON COLUMN venues.capacity  IS '収容人数';

-- 応援対象テーブル
-- 選手・チーム・アーティスト・ユニット等を汎用管理
CREATE TABLE targets (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID         REFERENCES organizations(id) ON DELETE SET NULL,
    name            VARCHAR(200) NOT NULL,
    type            VARCHAR(50)  NOT NULL,           -- 対象種別（player / team / artist / unit 等）
    image_url       TEXT,
    number          VARCHAR(20),                     -- 背番号・ユニット番号等
    metadata        JSONB        NOT NULL DEFAULT '{}', -- 種別固有の追加属性（ポジション・誕生日・ジャンル等）
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  targets              IS '応援対象マスター（選手・チーム・アーティスト等を汎用管理）';
COMMENT ON COLUMN targets.type         IS '対象種別（player / team / artist / unit 等）';
COMMENT ON COLUMN targets.number       IS '背番号・ユニット番号等の識別番号';
COMMENT ON COLUMN targets.metadata     IS '種別固有の追加属性をJSONBで柔軟に格納（例: {"position":"FW","birth_date":"1995-04-01"}）';

-- イベントテーブル
-- 試合・コンサート等のイベントを管理。同時刻の複数イベントを許容
CREATE TABLE events (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID         REFERENCES organizations(id) ON DELETE SET NULL,
    venue_id        UUID         REFERENCES venues(id) ON DELETE SET NULL,
    title           VARCHAR(300) NOT NULL,
    sport_type      VARCHAR(50),                     -- スポーツ・エンタメ種別（football / baseball / music_concert 等）
    starts_at       TIMESTAMPTZ  NOT NULL,
    ends_at         TIMESTAMPTZ,
    status          VARCHAR(20)  NOT NULL DEFAULT 'scheduled', -- イベント状態（scheduled / live / finished / cancelled）
    metadata        JSONB        NOT NULL DEFAULT '{}', -- イベント固有の追加情報（対戦相手・セットリスト等）
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  events             IS '試合・コンサート等のイベント。同時刻の複数イベントを許容（重複可）';
COMMENT ON COLUMN events.sport_type  IS 'スポーツ・エンタメ種別（football / baseball / music_concert 等）';
COMMENT ON COLUMN events.status      IS 'イベント状態（scheduled / live / finished / cancelled）';
COMMENT ON COLUMN events.metadata    IS 'イベント固有の追加情報（例: {"opponent":"チームB","attendance":45000}）';

-- イベント×応援対象 中間テーブル
-- 1イベントに複数の応援対象を紐づける（多対多）
CREATE TABLE event_targets (
    id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id  UUID        NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
    target_id UUID        NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    role      VARCHAR(50),                           -- イベント内の役割（home / away / performer 等）
    UNIQUE (event_id, target_id)
);

COMMENT ON TABLE  event_targets      IS 'イベントと応援対象の紐づけ（多対多）';
COMMENT ON COLUMN event_targets.role IS 'イベント内における対象の役割（home / away / performer 等）';

-- =============================================================
-- トランザクション系テーブル
-- =============================================================

-- 応援生ログテーブル
-- デバイスから送信される応援の生データを格納（集計前の原票）
CREATE TABLE cheer_logs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID        NOT NULL REFERENCES devices(id)  ON DELETE RESTRICT,
    user_id         UUID        REFERENCES users(id)   ON DELETE SET NULL,
    event_id        UUID        REFERENCES events(id)  ON DELETE SET NULL,
    target_id       UUID        REFERENCES targets(id) ON DELETE SET NULL,
    intensity       SMALLINT    NOT NULL CHECK (intensity BETWEEN 0 AND 100), -- 応援強度（0〜100）
    duration_ms     INTEGER     NOT NULL DEFAULT 0,    -- 1回の応援継続時間（ミリ秒）
    raw_sensor_data JSONB       NOT NULL DEFAULT '{}', -- デバイスセンサーの生データ（加速度・光量等）
    cheered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  cheer_logs                 IS '応援生ログ。デバイスからの生データを集計前に格納する原票テーブル';
COMMENT ON COLUMN cheer_logs.intensity       IS '応援強度（0〜100）';
COMMENT ON COLUMN cheer_logs.duration_ms     IS '1回の応援継続時間（ミリ秒）';
COMMENT ON COLUMN cheer_logs.raw_sensor_data IS 'デバイスセンサー生データ（例: {"accel_x":1.2,"accel_y":-0.5,"light":80}）';
COMMENT ON COLUMN cheer_logs.cheered_at      IS '応援が発生した日時';

-- 応援集計テーブル
-- イベント×ターゲット×ユーザー単位で集計した応援データ（生ログと分離）
CREATE TABLE cheer_summaries (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id          UUID        NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
    target_id         UUID        NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    user_id           UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    total_intensity   BIGINT      NOT NULL DEFAULT 0, -- 累計応援強度（intensity の合計）
    cheer_count       INTEGER     NOT NULL DEFAULT 0, -- 応援回数
    duration_total_ms BIGINT      NOT NULL DEFAULT 0, -- 累計応援時間（ミリ秒）
    rank_in_event     INTEGER,                        -- イベント内の応援ランキング順位
    calculated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  cheer_summaries                   IS '応援集計データ（イベント×ターゲット×ユーザー単位）。生ログと分離して管理';
COMMENT ON COLUMN cheer_summaries.total_intensity   IS '累計応援強度（cheer_logs.intensity の合計値）';
COMMENT ON COLUMN cheer_summaries.cheer_count       IS '応援イベント発生回数';
COMMENT ON COLUMN cheer_summaries.duration_total_ms IS '累計応援時間（ミリ秒）';
COMMENT ON COLUMN cheer_summaries.rank_in_event     IS 'イベント内の応援ランキング順位（1始まり）';
COMMENT ON COLUMN cheer_summaries.calculated_at     IS '集計バッチ実行日時';

-- アワードテーブル
-- イベント・期間ごとのランキング結果を保存
CREATE TABLE awards (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    UUID         REFERENCES events(id)  ON DELETE SET NULL,
    user_id     UUID         NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    target_id   UUID         REFERENCES targets(id) ON DELETE SET NULL,
    award_type  VARCHAR(50)  NOT NULL,               -- アワード種別（mvp_cheerer / top_fan / most_intense 等）
    period_type VARCHAR(20)  NOT NULL,               -- 集計期間種別（event / weekly / monthly / season）
    rank        INTEGER,
    score       NUMERIC(15, 2),
    awarded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  awards             IS 'ランキング・アワード結果。イベント単位・期間単位で保存';
COMMENT ON COLUMN awards.award_type  IS 'アワード種別（mvp_cheerer / top_fan / most_intense 等）';
COMMENT ON COLUMN awards.period_type IS '集計期間種別（event / weekly / monthly / season）';
COMMENT ON COLUMN awards.rank        IS 'ランキング順位（1始まり）';
COMMENT ON COLUMN awards.score       IS 'スコア（算出ロジックに依存）';

-- ユーザー応援対象フォローテーブル
CREATE TABLE user_target_follows (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    target_id   UUID        NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    followed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, target_id)
);

COMMENT ON TABLE user_target_follows IS 'ユーザーと応援対象のフォロー関係（多対多）';

-- デバイス×イベントセッションテーブル
-- デバイスのイベント接続状態を記録。通信品質の監視・デバッグに活用
CREATE TABLE device_event_sessions (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id        UUID        NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    event_id         UUID        NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
    connected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    disconnected_at  TIMESTAMPTZ,                    -- NULLの場合は接続中
    packets_received INTEGER     NOT NULL DEFAULT 0, -- 受信パケット数
    packets_lost     INTEGER     NOT NULL DEFAULT 0  -- 損失パケット数
);

COMMENT ON TABLE  device_event_sessions                   IS 'デバイスのイベント接続セッション。通信品質の監視・ログに使用';
COMMENT ON COLUMN device_event_sessions.disconnected_at   IS 'NULL の場合は現在接続中';
COMMENT ON COLUMN device_event_sessions.packets_received  IS '受信パケット数';
COMMENT ON COLUMN device_event_sessions.packets_lost      IS '損失パケット数。パケットロス率 = packets_lost / (packets_received + packets_lost)';

-- =============================================================
-- インデックス
-- =============================================================

-- users
CREATE UNIQUE INDEX idx_users_email
    ON users (email);
CREATE INDEX idx_users_auth_provider
    ON users (auth_provider, auth_provider_id);

-- devices
CREATE UNIQUE INDEX idx_devices_mac_address
    ON devices (mac_address);
CREATE INDEX idx_devices_owner_user_id
    ON devices (owner_user_id);
CREATE INDEX idx_devices_status
    ON devices (status);

-- organizations
CREATE INDEX idx_organizations_type
    ON organizations (type);

-- targets
CREATE INDEX idx_targets_organization_id
    ON targets (organization_id);
CREATE INDEX idx_targets_type
    ON targets (type);
CREATE INDEX idx_targets_is_active
    ON targets (is_active);
CREATE INDEX idx_targets_metadata
    ON targets USING gin (metadata); -- JSONB検索用GINインデックス

-- events
CREATE INDEX idx_events_organization_id
    ON events (organization_id);
CREATE INDEX idx_events_venue_id
    ON events (venue_id);
CREATE INDEX idx_events_starts_at
    ON events (starts_at);           -- 開始日時による絞り込み（直近イベント取得等）
CREATE INDEX idx_events_status
    ON events (status);
CREATE INDEX idx_events_sport_type
    ON events (sport_type);
CREATE INDEX idx_events_status_starts_at
    ON events (status, starts_at);   -- ライブ中イベント一覧取得等の複合検索
CREATE INDEX idx_events_metadata
    ON events USING gin (metadata);  -- JSONB検索用GINインデックス

-- event_targets
CREATE INDEX idx_event_targets_event_id
    ON event_targets (event_id);
CREATE INDEX idx_event_targets_target_id
    ON event_targets (target_id);

-- cheer_logs
CREATE INDEX idx_cheer_logs_device_id
    ON cheer_logs (device_id);
CREATE INDEX idx_cheer_logs_user_id
    ON cheer_logs (user_id);
CREATE INDEX idx_cheer_logs_event_id
    ON cheer_logs (event_id);
CREATE INDEX idx_cheer_logs_target_id
    ON cheer_logs (target_id);
CREATE INDEX idx_cheer_logs_cheered_at
    ON cheer_logs (cheered_at);
CREATE INDEX idx_cheer_logs_event_target
    ON cheer_logs (event_id, target_id); -- イベント×対象での集計クエリ用
CREATE INDEX idx_cheer_logs_raw_sensor_data
    ON cheer_logs USING gin (raw_sensor_data); -- JSONB検索用GINインデックス

-- cheer_summaries
CREATE UNIQUE INDEX idx_cheer_summaries_event_target_user
    ON cheer_summaries (event_id, target_id, user_id); -- 集計の一意制約
CREATE INDEX idx_cheer_summaries_event_id
    ON cheer_summaries (event_id);
CREATE INDEX idx_cheer_summaries_user_id
    ON cheer_summaries (user_id);
CREATE INDEX idx_cheer_summaries_rank_in_event
    ON cheer_summaries (event_id, rank_in_event); -- ランキング表示用

-- awards
CREATE INDEX idx_awards_event_id
    ON awards (event_id);
CREATE INDEX idx_awards_user_id
    ON awards (user_id);
CREATE INDEX idx_awards_target_id
    ON awards (target_id);
CREATE INDEX idx_awards_period_type_award_type
    ON awards (period_type, award_type);
CREATE INDEX idx_awards_awarded_at
    ON awards (awarded_at);

-- user_target_follows
CREATE INDEX idx_user_target_follows_user_id
    ON user_target_follows (user_id);
CREATE INDEX idx_user_target_follows_target_id
    ON user_target_follows (target_id);

-- device_event_sessions
CREATE INDEX idx_device_event_sessions_device_id
    ON device_event_sessions (device_id);
CREATE INDEX idx_device_event_sessions_event_id
    ON device_event_sessions (event_id);
CREATE INDEX idx_device_event_sessions_connected_at
    ON device_event_sessions (connected_at);
