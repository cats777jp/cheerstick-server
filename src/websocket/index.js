// src/websocket/index.js
// CheerStick WebSocketサーバー。
//
// 対応イベント：
//   connect     : HTML -> Server { type: "connect", id }
//                 Server -> HTML { type: "connect", status, user, teams?, team, targets?, member, message?, reference_url? }
//                 status: "unregistered"      -> ニックネーム+メール登録フォーム表示
//                       | "team_selection"    -> チーム選択画面表示（teamsに選択肢）
//                       | "player_selection"  -> 選手/推し選択画面表示（targetsに選択肢）
//                       | "complete"          -> ウェルカム画面表示
//                       | "error"             -> category_id未設定デバイス等の異常系（messageに理由）
//   register    : HTML -> Server { type: "register", id, name, email }
//   select_team : HTML -> Server { type: "select_team", id, organization_id }
//   set_oshi    : HTML -> Server { type: "set_oshi", id, target_id }
//   （いずれも応答は type: "connect" の最新状態）
//   count       : HTML -> Server { type: "count", id, value, duration_ms }
//                 応援量カウント。選択中チームにstatus='live'の公式試合があれば
//                 cheer_logsへ記録する。無ければDB保存はスキップ（クライアント側表示のみ）。
//                 応答なし。

const { WebSocketServer } = require('ws');
const cheerQueries = require('../db/cheerstickQueries');
const { generateReferenceToken } = require('../utils/referenceToken');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENABLE_REFERENCE_TOKEN = process.env.ENABLE_REFERENCE_TOKEN === 'true';

function buildTeamPayload(row) {
  if (!row || !row.org_id) return null;
  return {
    id: row.org_id,
    name: row.org_name,
    logo_url: row.org_logo_url,
    color: row.org_color,
  };
}

function buildMemberPayload(row) {
  if (!row || !row.target_id) return null;
  return {
    id: row.target_id,
    name: row.target_name,
    type: row.target_type,
    image_url: row.target_image_url,
    number: row.target_number,
    metadata: row.target_metadata,
    profile_text: row.target_profile_text,
  };
}

function computeStatus(row) {
  // category_id未設定のデバイスは異常系として扱う（カテゴリー選択画面は作らない）。
  // ensureDeviceで作成されただけの未インポートデバイスは常にここに該当する。
  if (!row || !row.category_id) return 'error';
  // ★将来拡張用（今回は未実装）：preset_organization_idが入っている場合、
  //   team_selectionをスキップしてplayer_selectionから開始する分岐をここに追加する想定。
  if (!row.owner_user_id) return 'unregistered';
  if (!row.selected_organization_id) return 'team_selection';
  if (!row.current_target_id) return 'player_selection';
  return 'complete';
}

async function buildConnectResponse(macAddress) {
  const row = await cheerQueries.findDeviceWithProfile(macAddress);
  const status = computeStatus(row);

  const payload = {
    type: 'connect',
    status,
    user: row && row.owner_user_id ? { name: row.display_name, email: row.email } : null,
    team: buildTeamPayload(row),
    member: buildMemberPayload(row),
  };

  if (status === 'error') {
    payload.message = 'カテゴリー未設定のデバイスです。サポートまでお問い合わせください。';
  }
  if (status === 'team_selection') {
    payload.teams = await cheerQueries.listOrganizations(row.category_id);
  }
  if (status === 'player_selection') {
    payload.targets = await cheerQueries.listTargetsByOrganization(row.selected_organization_id);
  }

  if (row) {
    if (ENABLE_REFERENCE_TOKEN) {
      const token = generateReferenceToken(row.device_id, row.mac_address);
      payload.reference_url = `https://app.cheerstick.com/reference.html?token=${token}`;
    } else {
      payload.reference_url = `https://app.cheerstick.com/reference.html?id=${encodeURIComponent(row.mac_address)}`;
    }
  }

  return payload;
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
              this.send(ws, await buildConnectResponse(id));
              break;
            }

            case 'select_team': {
              const { id, organization_id: organizationId } = msg;
              if (!id || !organizationId) {
                return this.send(ws, {
                  type: 'error',
                  message: 'id and organization_id are required',
                });
              }
              await cheerQueries.setDeviceOrganization(id, organizationId);
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

            case 'count': {
              const { id, value, duration_ms: durationMs } = msg;
              if (!id || value == null) {
                return this.send(ws, {
                  type: 'error',
                  message: 'id and value are required',
                });
              }

              const row = await cheerQueries.findDeviceWithProfile(id);
              if (row && row.selected_organization_id) {
                const liveEvent = await cheerQueries.findLiveEventForOrganization(
                  row.selected_organization_id
                );
                if (liveEvent) {
                  await cheerQueries.insertCheerLog({
                    deviceId: row.device_id,
                    userId: row.owner_user_id,
                    eventId: liveEvent.id,
                    targetId: row.current_target_id,
                    intensity: value,
                    durationMs: durationMs || 0,
                  });
                }
                // 公式試合が無い場合はDB保存をスキップ（クライアント側表示のみ）。
              }
              // レスポンス不要。
              break;
            }

            default:
              this.send(ws, { type: 'error', message: `unknown type: ${msg.type}` });
          }
        } catch (err) {
          console.error('[WS] handler error:', err);
          const message =
            err.code === 'TARGET_TEAM_MISMATCH'
              ? '選択中のチームに属さない対象です'
              : err.code === 'CATEGORY_MISMATCH'
              ? '選択できないチームです。'
              : err.code === 'DEVICE_ALREADY_REGISTERED'
              ? 'このデバイスは既に別のユーザーが登録済みです'
              : 'internal server error';
          this.send(ws, { type: 'error', message });
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
