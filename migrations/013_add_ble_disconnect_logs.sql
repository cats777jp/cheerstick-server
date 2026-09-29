-- =============================================================
-- migrations/013_add_ble_disconnect_logs.sql
-- BLE切断のサーバー記録：ble_disconnect_logs テーブルの新設
-- =============================================================

-- public/index.htmlがAPPからの異常データ（accel全軸ゼロ・volt/rssiゼロ）を検知した際、
-- WebSocket経由（type: "ble_disconnect"）で1件INSERTされる。連続して異常データを
-- 受信し続けている間（＝BLEが切断されたまま）は、クライアント側で立ち上がりエッジ
-- （最初の1回）のみ送信するため、1回の物理的な切断につき1行が記録される想定。
CREATE TABLE ble_disconnect_logs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID        NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    event_id    UUID        REFERENCES events(id) ON DELETE SET NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  ble_disconnect_logs             IS 'BLEペアリング切断の記録。public/index.htmlがAPPからの異常データ（accel全ゼロ等）を検知した際、WebSocket経由で1件INSERTされる（連続検知中はクライアント側のエッジ検出により最初の1回のみ）';
COMMENT ON COLUMN ble_disconnect_logs.device_id   IS '切断を検知したデバイス（devices.id）。ON DELETE RESTRICTはcheer_logs.device_idと同じ方針（デバイスは通常削除しない）';
COMMENT ON COLUMN ble_disconnect_logs.event_id    IS '検知時点で、デバイスの選択中チームにstatus=liveの試合があればそのevents.id。無ければNULL（cheer_logsの記録判定と同じロジック、src/websocket/index.jsのcountハンドラ参照）';
COMMENT ON COLUMN ble_disconnect_logs.occurred_at IS 'サーバーがWebSocketメッセージを受信した日時（デバイス側で切断を検知した時刻そのものではない）';

CREATE INDEX idx_ble_disconnect_logs_device_id   ON ble_disconnect_logs (device_id);
CREATE INDEX idx_ble_disconnect_logs_event_id    ON ble_disconnect_logs (event_id);
CREATE INDEX idx_ble_disconnect_logs_occurred_at ON ble_disconnect_logs (occurred_at);

-- =============================================================
-- ロールバック用（実行する場合は別途）
-- =============================================================
-- DROP TABLE IF EXISTS ble_disconnect_logs;
