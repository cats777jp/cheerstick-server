const deviceStore = require('../store/deviceStore');
const wsServer = require('../websocket');

const WS_THROTTLE_MS = 5000;

function calcGameTime(stat, device, teams) {
  const now = Date.now();

  if (stat === 'off') {
    // teams.next.timestamp から試合開始までの時間を計算
    const nextTs = teams?.next?.timestamp;
    if (!nextTs) return '';
    const hoursLeft = (nextTs - now) / (1000 * 3600);
    if (hoursLeft <= 0) return '';
    return `試合開始まで ${hoursLeft.toFixed(2)}時間`;
  }

  if (stat === 'on' || stat === 'pause') {
    // teams[team_id].start を優先、なければ device.start を使用
    let startTs = null;
    if (Array.isArray(teams)) {
      const team = teams.find((t) => t.id === device.team_id || t.team_id === device.team_id);
      startTs = team?.start ?? null;
    } else if (teams && typeof teams === 'object') {
      startTs = teams[device.team_id]?.start ?? null;
    }
    startTs = startTs ?? device.start;

    if (!startTs) return '';
    const totalSec = Math.floor((now - startTs) / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `試合時間 ${min}分:${String(sec).padStart(2, '0')}経過`;
  }

  return ''; // stop, end
}

exports.device = (req, res, next) => {
  try {
    const { id: mac, cheer_point = 0, led } = req.body;

    if (!mac) {
      return res.status(400).json({ error: 'id is required' });
    }

    const device = deviceStore.getDevice(mac);
    if (!device) {
      return res.status(400).json({ error: 'Device not registered' });
    }

    const { stat } = device;
    const now = Date.now();

    // stat="stop" → LEDなし・ポイントなしで即返す
    if (stat === 'stop') {
      return res.json({ LED: null, cheer_sum: 0 });
    }

    // stat="off" かつ start !== 0 → 試合終了をデバイス側が検知したケース
    if (stat === 'off' && device.start !== 0) {
      deviceStore.setDevice(mac, {
        stat: 'stop',
        cheer_last: device.cheer_sum,
        cheer_all: device.cheer_all + device.cheer_sum,
        cheer_sum: 0,
        last: now,
      });
      return res.json({ LED: null, cheer_sum: 0 });
    }

    // pause 以外なら cheer_sum に加算
    const newCheerSum = stat !== 'pause'
      ? device.cheer_sum + cheer_point
      : device.cheer_sum;

    const prevLast = device.last;
    const teams = deviceStore.getTeams();

    deviceStore.setDevice(mac, { cheer_sum: newCheerSum, last: now });

    // 5秒以上経過していたら WS でチア情報を送信
    if (now - prevLast >= WS_THROTTLE_MS) {
      wsServer.sendToDevice(mac, {
        type: 'cheer-update',
        id: mac,
        team_id: device.team_id,
        oshi_id: device.oshi_id,
        stat,
        start: device.start,
        cheer_sum: newCheerSum,
        cheer_all: device.cheer_all,
        result: device.result,
        game_time: calcGameTime(stat, device, teams),
      });
    }

    // device.led ([r,g,b]) を { r, g, b } 形式でレスポンス
    const [r = 0, g = 0, b = 255] = device.led ?? [];
    return res.json({ LED: { r, g, b }, cheer_sum: cheer_point });

  } catch (err) {
    next(err);
  }
};
