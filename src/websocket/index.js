const { WebSocketServer } = require('ws');

class CheerWebSocketServer {
  constructor() {
    this.wss = null;
    // mac_address -> WebSocket session
    this.sessions = new Map();
  }

  attach(server, path = '/ws/cheer') {
    this.wss = new WebSocketServer({ server, path });

    this.wss.on('connection', (ws) => {
      let macAddress = null;

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'register' && msg.mac) {
            macAddress = msg.mac;
            this.sessions.set(macAddress, ws);
            console.log(`[WS] Device registered: ${macAddress}`);
            ws.send(JSON.stringify({ type: 'registered', mac: macAddress }));
            return;
          }

          // 登録済みデバイスからのメッセージはここで処理を追加できる
        } catch (err) {
          console.error('[WS] Invalid message:', err.message);
        }
      });

      ws.on('close', () => {
        if (macAddress) {
          this.sessions.delete(macAddress);
          console.log(`[WS] Device disconnected: ${macAddress}`);
        }
      });

      ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
      });
    });

    console.log(`[WS] WebSocket server attached at ${path}`);
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
