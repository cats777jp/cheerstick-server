const deviceStore = require('../store/deviceStore');

// team_id → RGB。teamsデータにledフィールドがあればそちらを優先
const TEAM_LED_DEFAULTS = {
  1: [255, 0, 0],
  2: [0, 0, 255],
  3: [0, 255, 0],
  4: [255, 165, 0],
};

function getLedForTeam(teamId) {
  const teams = deviceStore.getTeams();
  if (Array.isArray(teams)) {
    const team = teams.find((t) => t.id === teamId || t.team_id === teamId);
    if (team?.led) return team.led;
    if (team?.color) return team.color;
  }
  return TEAM_LED_DEFAULTS[teamId] ?? [255, 255, 255];
}

exports.csUser = (req, res, next) => {
  try {
    const { id: mac, act, name, oshi_id, team_id, device } = req.query;

    if (!mac) {
      return res.status(400).json({ error: 'id (MAC address) is required' });
    }

    // ---- act=init: 新規ユーザー登録 ----
    if (act === 'init') {
      if (device === 'none') {
        return res.json({ status: 'skip', reason: 'device=none' });
      }

      // 名前重複チェック（自分自身は除外）
      const isDuplicate = deviceStore.getAllDeviceKeys().some((key) => {
        if (key === mac) return false;
        return deviceStore.getDevice(key)?.name === name;
      });
      if (isDuplicate) {
        return res.json({ status: 'ng', reason: 'name_duplicate' });
      }

      deviceStore.initDevice(mac, {
        name: name ?? '',
        oshi_id: oshi_id ?? null,
        team_id: team_id != null ? Number(team_id) : 2,
      });

      return res.json({ status: 'ok', ...deviceStore.getDevice(mac) });
    }

    // ---- act=chg: ユーザー情報変更 ----
    if (act === 'chg') {
      const updates = {};
      if (name !== undefined) updates.name = name;
      if (oshi_id !== undefined) updates.oshi_id = oshi_id;
      if (team_id !== undefined) updates.team_id = Number(team_id);

      deviceStore.setDevice(mac, updates);
      return res.json({ status: 'ok', ...deviceStore.getDevice(mac) });
    }

    // ---- act=team_set: チームID + LEDカラー設定 ----
    if (act === 'team_set') {
      const tid = Number(team_id);
      deviceStore.setDevice(mac, { team_id: tid, led: getLedForTeam(tid) });
      return res.json({ status: 'ok', ...deviceStore.getDevice(mac) });
    }

    // ---- 参照（actなし or 不明）----
    const state = deviceStore.getDevice(mac);
    if (!state) {
      return res.json({ status: 'not_found' });
    }
    return res.json({ status: 'ok', ...state });

  } catch (err) {
    next(err);
  }
};
