const DEFAULT_DEVICE_STATE = {
  name: '',
  team_id: 2,
  oshi_id: null,
  stat: 'off',
  start: 0,
  last: 0,
  led: [0, 0, 255],
  cheer_sum: 0,
  cheer_last: 0,
  cheer_all: 0,
  result: '',
};

class DeviceStore {
  constructor() {
    this.devices = new Map();
    this.teams = null;
  }

  // --- デバイス状態 ---

  getDevice(macAddress) {
    return this.devices.get(macAddress) ?? null;
  }

  setDevice(macAddress, state) {
    const current = this.devices.get(macAddress) ?? { ...DEFAULT_DEVICE_STATE };
    this.devices.set(macAddress, { ...current, ...state });
  }

  deleteDevice(macAddress) {
    this.devices.delete(macAddress);
  }

  initDevice(macAddress, overrides = {}) {
    this.devices.set(macAddress, { ...DEFAULT_DEVICE_STATE, ...overrides });
  }

  getAllDeviceKeys() {
    return [...this.devices.keys()];
  }

  getAllDevices() {
    return Object.fromEntries(this.devices);
  }

  // --- Teams情報 ---

  getTeams() {
    return this.teams;
  }

  setTeams(teams) {
    this.teams = teams;
  }
}

module.exports = new DeviceStore();
