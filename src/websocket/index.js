// src/websocket/index.js
// CheerStick WebSocketサーバー。
//
// 対応イベント：
//   connect  : HTML -> Server { type: "connect", id }
//              Server -> HTML { type: "connect", status, user, team, member }
//              status: "unregistered"（未登録→名前+メール登録フォーム表示）
//                    | "registered"（登録済み→ウェルカム画面表示）
//   register : HTML -> Server { type: "register", id, name, email }
//              Server -> HTML { type: "connect", ... }（登録後の最新状態を返す）
//   set_oshi : HTML -> Server { type: "set_oshi", id, target_id }
//              Server -> HTML { type: "connect", ... }

const { WebSocketServer } = require('ws');
const cheerQueries = require('../db/cheerstickQueries');
const { DEFAULT_TARGET_ID } = require('../config/cheerstickDefaults');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildTeamPayload(row) {
  if (!row || !row.org_id) return null;
  return {
    id: row.org_id,
    name: row.org_name,
    logo_url: row.org_logo_url,
  };
}

function buildMemberPayload(row) {
  if (!row || !row.target_id) return null;
  return {
    id: row.target_id,
    name: row.target_name,
    type: row.target_type,
    image_url: row.target_image_url,
    metadata: row.target_metadata,
  };
}

async function buildConnectResponse(macAddress) {
  const row = await cheerQueries.findDeviceWithProfile(macAddress);

  const isRegistered = !!(row && row.owner_user_id);

  return {
    type: 'connect',
    status: isRegistered ? 'registered' : 'unregistered',
    user: isRegistered ? { name: row.display_name, email: row.email } : null,
    team: buildTeamPayload(row),
    member: buildMemberPayload(row),
  };
}

class CheerWebSocketServer {
  constructor() {
    this.wss = null;
    // mac_address -> WebSocket（将来、応援演出のプッシュ配信等に使用）
    this.sessions = new Map();
  }

  attach(server, path = '/cheer') {
    this.wss = new WebSocketServer({ server, path });

    this.wss.on('connection', (ws) => {
      let deviceId = null;

      ws.on('message', async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch (err) {
          return this.send(ws, { type: 'error', message: 'invalid JSON' });
        }

        try {
          switch (msg.type) {
            case 'connect': {
              if (!msg.id) {
                return this.send(ws, { type: 'error', message: 'id is required' });
              }
              deviceId = msg.id;
              this.sessions.set(deviceId, ws);
              await cheerQueries.ensureDevice(deviceId);
              this.send(ws, await buildConnectResponse(deviceId));
              break;
            }

            case 'register': {
              const { id, name, email } = msg;
              if (!id || !name || !email) {
                return this.send(ws, {
                  type: 'error',
                  message: 'id, name and email are required',
                });
              }
              if (!EMAIL_RE.test(email)) {
                return this.send(ws, { type: 'error', message: 'invalid email format' });
              }
              await cheerQueries.registerDeviceOwner(id, email, name);

              // 現状は1チーム・1推し対象のみのため、登録と同時に既定の推しを割り当てる
              await cheerQueries.setDeviceTarget(id, DEFAULT_TARGET_ID);

              this.send(ws, await buildConnectResponse(id));
              break;
            }

            case 'set_oshi': {
              const { id, target_id: targetId } = msg;
              if (!id || !targetId) {
                return this.send(ws, {
                  type: 'error',
                  message: 'id and target_id are required',
                });
              }
              await cheerQueries.setDeviceTarget(id, targetId);
              this.send(ws, await buildConnectResponse(id));
              break;
            }

            default:
              this.send(ws, { type: 'error', message: `unknown type: ${msg.type}` });
          }
        } catch (err) {
          console.error('[WS] handler error:', err);
          this.send(ws, { type: 'error', message: 'internal server error' });
        }
      });

      ws.on('close', () => {
        if (deviceId) {
          this.sessions.delete(deviceId);
        }
      });

      ws.on('error', (err) => {
        console.error('[WS] socket error:', err.message);
      });
    });

    console.log(`[WS] CheerStick WebSocket server attached at ${path}`);
  }

  send(ws, payload) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  sendToDevice(macAddress, payload) {
    const ws = this.sessions.get(macAddress);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  broadcast(payload) {
    const message = JSON.stringify(payload);
    let count = 0;
    for (const ws of this.sessions.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
        count++;
      }
    }
    return count;
  }

  getConnectedDevices() {
    return [...this.sessions.keys()];
  }
}

module.exports = new CheerWebSocketServer();
