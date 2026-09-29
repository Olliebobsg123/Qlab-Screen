import dgram from "node:dgram";

// Desk output watcher: listens to the lighting desk's own DMX output on the network (Art-Net and
// sACN) so QLab Connect can tell whether the lights actually changed after it sent the desk a GO.
// ZerOS never answers OSC, so this is the only way to see the desk respond from another room.
//
// Only packets from the desk's IP address count (QLab or other consoles may be sending Art-Net too).

const ARTNET_PORT = 6454;
const SACN_PORT = 5568;
const CHANGE_THRESHOLD = 2; // levels 0-255; ignore flicker of 1
const WATCH_MS = 3000;
const STALE_MS = 3000;

let config = { enabled: false, host: "", universes: [1] };
let artnet = null;
let sacn = null;
let sacnGroups = [];
// "artnet:0" / "sacn:1" -> { protocol, universe, source, at, levels: Uint8Array(512) }
const frames = new Map();
const others = new Map(); // other senders we heard (not the desk), for the setup hint

export function configureDeskOutput({ enabled, host, universes }) {
  const next = { enabled: Boolean(enabled && host), host: String(host || ""), universes: universes?.length ? universes : [1] };
  const changed = JSON.stringify(next) !== JSON.stringify(config);
  config = next;
  if (!changed) return;
  stop();
  if (config.enabled) start();
}

export function outputStatus() {
  const now = Date.now();
  const live = [...frames.values()].filter((frame) => now - frame.at < STALE_MS);
  return {
    enabled: config.enabled,
    receiving: live.length > 0,
    universes: live.map((frame) => ({ protocol: frame.protocol, universe: frame.universe, source: frame.source, ageMs: now - frame.at })),
    others: [...others.entries()].filter(([, at]) => now - at < 10_000).map(([source]) => source)
  };
}

export function outputLevels() {
  const now = Date.now();
  return [...frames.values()]
    .filter((frame) => now - frame.at < STALE_MS)
    .map((frame) => ({ protocol: frame.protocol, universe: frame.universe, levels: Array.from(frame.levels) }));
}

// Snapshot now; resolve true if the desk's output moves within WATCH_MS, false if it doesn't,
// null if we aren't hearing the desk's output at all.
export function watchForChange() {
  if (!config.enabled || !outputStatus().receiving) return Promise.resolve(null);
  const before = new Map([...frames].map(([key, frame]) => [key, Uint8Array.from(frame.levels)]));
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      for (const [key, frame] of frames) {
        const old = before.get(key);
        if (!old) continue;
        for (let channel = 0; channel < 512; channel += 1) {
          if (Math.abs(frame.levels[channel] - old[channel]) >= CHANGE_THRESHOLD) {
            clearInterval(timer);
            resolve({ changed: true, afterMs: Date.now() - startedAt, universe: frame.universe, channel: channel + 1 });
            return;
          }
        }
      }
      if (Date.now() - startedAt > WATCH_MS) {
        clearInterval(timer);
        resolve({ changed: false });
      }
    }, 25);
  });
}

function start() {
  artnet = dgram.createSocket({ type: "udp4", reuseAddr: true });
  artnet.on("message", (message, remote) => readArtnet(message, remote.address));
  artnet.on("error", (error) => console.warn(`Desk output (Art-Net): ${error.message}`));
  artnet.bind(ARTNET_PORT, () => {
    try { artnet.setBroadcast(true); } catch { /* not needed to receive */ }
  });

  sacn = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sacn.on("message", (message, remote) => readSacn(message, remote.address));
  sacn.on("error", (error) => console.warn(`Desk output (sACN): ${error.message}`));
  sacn.bind(SACN_PORT, () => {
    // sACN is multicast: 239.255.<universe high byte>.<universe low byte>.
    sacnGroups = config.universes.map((universe) => `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`);
    for (const group of sacnGroups) {
      try { sacn.addMembership(group); } catch (error) { console.warn(`Desk output: can't join sACN universe ${group}: ${error.message}`); }
    }
  });
}

function stop() {
  for (const socket of [artnet, sacn]) {
    try { socket?.close(); } catch { /* already closed */ }
  }
  artnet = null;
  sacn = null;
  frames.clear();
}

function fromDesk(source) {
  if (source === config.host || source === `::ffff:${config.host}`) return true;
  others.set(source, Date.now());
  return false;
}

// ArtDmx: "Art-Net\0", opcode 0x5000 (little-endian), version, sequence, physical,
// SubUni, Net, length (big-endian), then the levels.
function readArtnet(message, source) {
  if (message.length < 18 || message.toString("latin1", 0, 8) !== "Art-Net\0") return;
  if (message.readUInt16LE(8) !== 0x5000) return;
  if (!fromDesk(source)) return;
  const universe = message[14] | ((message[15] & 0x7f) << 8);
  const length = Math.min(message.readUInt16BE(16), message.length - 18, 512);
  store("artnet", universe, source, message.subarray(18, 18 + length));
}

// E1.31 data packet: universe at 113 (big-endian), start code at 125, levels from 126.
function readSacn(message, source) {
  if (message.length < 126 || message.toString("latin1", 4, 16) !== "ASC-E1.17\0\0\0") return;
  if (message[125] !== 0) return; // only plain DMX levels
  if (!fromDesk(source)) return;
  const universe = message.readUInt16BE(113);
  const count = Math.min(message.readUInt16BE(123) - 1, message.length - 126, 512);
  store("sacn", universe, source, message.subarray(126, 126 + Math.max(0, count)));
}

function store(protocol, universe, source, data) {
  const key = `${protocol}:${universe}`;
  let frame = frames.get(key);
  if (!frame) {
    frame = { protocol, universe, source, at: 0, levels: new Uint8Array(512) };
    frames.set(key, frame);
  }
  frame.levels.fill(0);
  frame.levels.set(data);
  frame.source = source;
  frame.at = Date.now();
}
