// Used by the Mac installer: `node scripts/admin-password.mjs --is-default` exits 0 when the
// default admin password is still in use; `--set <password>` saves a new one.
import { updateServerSettings, usingDefaultAdminPassword } from "../src/settings.js";

const [flag, value] = process.argv.slice(2);
if (flag === "--is-default") {
  process.exit(usingDefaultAdminPassword() ? 0 : 1);
} else if (flag === "--set" && value) {
  await updateServerSettings({ adminPassword: value });
  console.log("Admin password saved.");
} else {
  console.error("Usage: node scripts/admin-password.mjs --is-default | --set <password>");
  process.exit(2);
}
