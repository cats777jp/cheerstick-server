-- =============================================================
-- migrations/011_add_event_battles.sql
-- 「2チーム対抗応援合戦」機能：event_battles テーブルの新設
-- =============================================================

-- events テーブル自体には一切変更を加えない（1試合1組織のロジックは既存のまま）。
-- 対抗戦は「2つの既存イベント（event_a / event_b）をペアリングして、それぞれの
-- cheer_logs集計を左右に並べて表示する」という発想で実現する。
-- event_a_id＝画面左側、event_b_id＝画面右側として扱う（アプリ側の慣例。
-- DBスキーマ上はどちらが左右かを区別する意味は無い）。
CREATE TABLE event_battles (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    label      VARCHAR(255),
    event_a_id UUID         NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    event_b_id UUID         NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT event_battles_distinct_events CHECK (event_a_id <> event_b_id)
);

COMMENT ON TABLE  event_battles            IS '2チーム対抗応援合戦：2つのevents行のペアリング。集計はcheer_logsを都度SUMするのみで、このテーブル自体はスコアを保持しない';
COMMENT ON COLUMN event_battles.label      IS '画面表示用のラベル（任意）。例：「〇〇 vs △△」';
COMMENT ON COLUMN event_battles.event_a_id IS '画面左側として扱うイベント（アプリ側の慣例）';
COMMENT ON COLUMN event_battles.event_b_id IS '画面右側として扱うイベント（アプリ側の慣例）';

-- ON DELETE CASCADEの判断：event_battlesを参照する子テーブルは無い（末端テーブル）。
-- 元イベントが削除（非表示化ではなく物理削除）された場合、そのペアリングだけが
-- 無意味になるため、ペアリング行ごと削除して問題ない。spec.md 11.7章で既知の
-- events関連FKの削除時挙動の不統一（SET NULL/CASCADE混在）とは無関係の新規テーブルであり、
-- そちらの是正を待たずに判断してよいと考えられる。
-- （なお現状、events の物理削除経路自体が実装に存在しない。削除操作は
-- hideEvent()によるhidden_at設定のみであり、hidden_at設定はevent_battlesの
-- CASCADE条件に該当しない＝通常の運用ではこのCASCADEが発火する場面が無い）

CREATE INDEX idx_event_battles_event_a_id ON event_battles (event_a_id);
CREATE INDEX idx_event_battles_event_b_id ON event_battles (event_b_id);

-- =============================================================
-- ロールバック用（実行する場合は別途）
-- =============================================================
-- DROP TABLE IF EXISTS event_battles;
