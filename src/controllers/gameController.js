const deviceStore = require('../store/deviceStore');

exports.control = (req, res, next) => {
  try {
    const { action, phase } = req.body;

    // ---- get-teams: teams一覧取得 ----
    if (action === 'get-teams') {
      return res.json({ status: 'ok', teams: deviceStore.getTeams() ?? [] });
    }

    // ---- get-game-state: 全デバイスの現在stat取得 ----
    if (action === 'get-game-state') {
      const states = deviceStore.getAllDeviceKeys().map((mac) => {
        const d = deviceStore.getDevice(mac);
        return { mac, name: d?.name, team_id: d?.team_id, stat: d?.stat };
      });
      return res.json({ status: 'ok', states });
    }

    // ---- get-cheer-last: 前試合スコアボード取得 ----
    if (action === 'get-cheer-last') {
      const board = deviceStore.getAllDeviceKeys()
        .map((mac) => {
          const d = deviceStore.getDevice(mac);
          return { mac, name: d?.name, team_id: d?.team_id, cheer_last: d?.cheer_last ?? 0, result: d?.result ?? '' };
        })
        .sort((a, b) => b.cheer_last - a.cheer_last);
      return res.json({ status: 'ok', board });
    }

    // ---- game-control: start / half / end ----
    if (action === 'game-control') {
      const keys = deviceStore.getAllDeviceKeys();
      const now = Date.now();

      if (phase === 'start') {
        for (const mac of keys) {
          deviceStore.setDevice(mac, { stat: 'on', start: now, cheer_sum: 0 });
        }
        return res.json({ status: 'ok', phase: 'start', started_at: now });
      }

      if (phase === 'half') {
        for (const mac of keys) {
          deviceStore.setDevice(mac, { stat: 'pause' });
        }
        return res.json({ status: 'ok', phase: 'half' });
      }

      if (phase === 'end') {
        // cheer_sum 降順でランキング付け
        const ranked = keys
          .map((mac) => ({ mac, cheer_sum: deviceStore.getDevice(mac)?.cheer_sum ?? 0 }))
          .sort((a, b) => b.cheer_sum - a.cheer_sum);

        ranked.forEach(({ mac, cheer_sum }, idx) => {
          const prev = deviceStore.getDevice(mac);
          deviceStore.setDevice(mac, {
            stat: 'end',
            last: now,
            cheer_last: cheer_sum,
            cheer_all: (prev?.cheer_all ?? 0) + cheer_sum,
            result: `${idx + 1}位`,
          });
        });

        const board = ranked.map(({ mac, cheer_sum }, idx) => {
          const d = deviceStore.getDevice(mac);
          return { mac, name: d?.name, team_id: d?.team_id, cheer_sum, rank: idx + 1, result: d?.result };
        });

        return res.json({ status: 'ok', phase: 'end', board });
      }

      return res.status(400).json({ error: `Unknown phase: ${phase}` });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    next(err);
  }
};
