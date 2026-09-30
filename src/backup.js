import { APP_VERSION, HTTP_PORT, QLAB_TCP_PORT } from "./config.js";
import { getSettings, updateSettings } from "./settings.js";
import { state } from "./state.js";

// A setup file (.qlabconnect, JSON inside) holds everything configured in Admin, so a show's
// setup can be saved, restored, or moved to another computer.
const FORMAT = "qlab-connect-setup";

export function exportSetup({ includeSecrets }) {
  const settings = getSettings();
  const secret = (value) => (includeSecrets ? value : undefined);
  return {
    format: FORMAT,
    version: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    includesSecrets: Boolean(includeSecrets),
    setup: {
      qlab: {
        host: settings.host,
        workspaceId: settings.workspaceId,
        // Only a label for people reading the file; the ID above is what's used.
        workspaceName: state.workspaceId && state.workspaceId === settings.workspaceId ? state.workspaceName : "",
        autoConnect: settings.autoConnect,
        passcode: secret(settings.passcode)
      },
      control: {
        enabled: settings.control.enabled,
        token: secret(settings.control.token),
        midiMappings: settings.control.midiMappings,
        midiOutput: settings.control.midiOutput,
        networkMidiAuto: settings.control.networkMidiAuto
      },
      lightingDesk: settings.lightingDesk,
      comms: settings.comms,
      secureAddress: { ...settings.secureAddress, token: secret(settings.secureAddress.token) },
      departments: settings.departments.map((department) => ({
        ...department,
        passwordHash: secret(department.passwordHash),
        passwordSalt: secret(department.passwordSalt)
      })),
      server: {
        httpPort: settings.server.httpPort,
        qlabTcpPort: settings.server.qlabTcpPort,
        adminUser: settings.server.adminUser,
        adminPassword: secret(settings.server.adminPassword)
      }
    }
  };
}

// Anything missing from the file (for example passwords, when it was saved without them)
// keeps its current value.
export async function importSetup(backup) {
  if (!backup || backup.format !== FORMAT || typeof backup.setup !== "object") {
    const error = new Error("This isn't a QLab Connect setup file.");
    error.status = 400;
    throw error;
  }
  const current = getSettings();
  const { qlab = {}, control = {}, departments, server = {}, lightingDesk, comms, secureAddress } = backup.setup;
  const pick = (value, fallback) => (value === undefined || value === null ? fallback : value);
  const currentDepartments = new Map(current.departments.map((department) => [department.id, department]));

  const next = {
    ...current,
    host: pick(qlab.host, current.host),
    workspaceId: pick(qlab.workspaceId, current.workspaceId),
    autoConnect: pick(qlab.autoConnect, current.autoConnect),
    passcode: pick(qlab.passcode, current.passcode),
    control: {
      ...current.control,
      enabled: pick(control.enabled, current.control.enabled),
      token: pick(control.token, current.control.token),
      midiMappings: pick(control.midiMappings, current.control.midiMappings),
      midiOutput: pick(control.midiOutput, current.control.midiOutput),
      networkMidiAuto: pick(control.networkMidiAuto, current.control.networkMidiAuto)
    },
    lightingDesk: lightingDesk && typeof lightingDesk === "object" ? { ...current.lightingDesk, ...lightingDesk } : current.lightingDesk,
    comms: comms && typeof comms === "object" ? { ...current.comms, ...comms } : current.comms,
    secureAddress: secureAddress && typeof secureAddress === "object"
      ? { ...current.secureAddress, ...secureAddress, token: pick(secureAddress.token, current.secureAddress.token) }
      : current.secureAddress,
    departments: Array.isArray(departments)
      ? departments.map((department) => ({
        ...department,
        passwordHash: pick(department.passwordHash, currentDepartments.get(department.id)?.passwordHash || ""),
        passwordSalt: pick(department.passwordSalt, currentDepartments.get(department.id)?.passwordSalt || "")
      }))
      : current.departments,
    server: {
      ...current.server,
      httpPort: pick(server.httpPort, current.server.httpPort),
      qlabTcpPort: pick(server.qlabTcpPort, current.server.qlabTcpPort),
      adminUser: pick(server.adminUser, current.server.adminUser),
      adminPassword: pick(server.adminPassword, current.server.adminPassword)
    }
  };
  const saved = await updateSettings(next);

  // Ports are read at startup; the admin login applies straight away.
  const restartRequired = saved.server.httpPort !== HTTP_PORT || saved.server.qlabTcpPort !== QLAB_TCP_PORT;
  return { saved, restartRequired };
}
