-- =============================================================
-- migrations/012_add_ranking_snapshots.sql
-- 試合終了時の順位確定機能：ranking_snapshots / ranking_snapshot_entries テーブルの新設
-- =============================================================

-- 確定操作（管理画面の「順位確定」ボタン）の履歴ヘッダ。
-- 押すたびに1行INSERTされ、過去の確定結果を後から参照できるようにする（履歴方式）。
CREATE TABLE ranking_snapshots (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id     UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    triggered_by VARCHAR(255)
);

COMMENT ON TABLE  ranking_snapshots              IS '順位確定機能：確定操作1回ごとの履歴ヘッダ。押すたびに1行INSERTし、過去の確定結果を保持する';
COMMENT ON COLUMN ranking_snapshots.event_id     IS '確定対象の試合（events.id）';
COMMENT ON COLUMN ranking_snapshots.triggered_at IS '確定操作が実行された日時';
COMMENT ON COLUMN ranking_snapshots.triggered_by IS '操作元の識別情報（管理画面にログイン機構が無いため、操作元IP等を想定。取得できない場合はNULL可）';

CREATE INDEX idx_ranking_snapshots_event ON ranking_snapshots (event_id);

-- 確定操作1回分の結果明細（ユーザー別・選手別、それぞれ上位20件）。
-- entity_idはranking_typeによってusers.id／targets.idのいずれかを指すが、
-- 外部キー制約はあえて張らない（後からニックネーム・選手情報が変わっても、
-- display_name/cheer_valueは確定時点の値のまま変わらないようにする非正規化設計のため。
-- 参照先の削除・変更がこの履歴テーブルに影響しない）。
CREATE TABLE ranking_snapshot_entries (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id   UUID         NOT NULL REFERENCES ranking_snapshots(id) ON DELETE CASCADE,
    ranking_type  VARCHAR(10)  NOT NULL CHECK (ranking_type IN ('user', 'target')),
    rank          INTEGER      NOT NULL,
    entity_id     UUID         NOT NULL,
    display_name  VARCHAR(255) NOT NULL,
    cheer_value   BIGINT       NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  ranking_snapshot_entries               IS '順位確定機能：確定操作1回分の結果明細（ユーザー別・選手別、それぞれ上位20件）';
COMMENT ON COLUMN ranking_snapshot_entries.ranking_type  IS '順位の種別。user＝ユーザー別、target＝選手別';
COMMENT ON COLUMN ranking_snapshot_entries.rank          IS '順位（1始まり）。同点は同順位・以降の順位番号をスキップするRANK()方式';
COMMENT ON COLUMN ranking_snapshot_entries.entity_id     IS 'ranking_type=userならusers.id、targetならtargets.id（外部キー制約なし。非正規化のため参照先削除の影響を受けない）';
COMMENT ON COLUMN ranking_snapshot_entries.display_name  IS '確定時点のニックネーム／選手名を非正規化で保存（後から名前が変わっても記録は変わらない）';
COMMENT ON COLUMN ranking_snapshot_entries.cheer_value   IS '確定時点の応援量（SUM(intensity)、既存target-scores系APIと同じ集計式）';

CREATE INDEX idx_ranking_snapshot_entries_snapshot ON ranking_snapshot_entries (snapshot_id, ranking_type);

-- =============================================================
-- ロールバック用（実行する場合は別途）
-- =============================================================
-- DROP TABLE IF EXISTS ranking_snapshot_entries;
-- DROP TABLE IF EXISTS ranking_snapshots;
