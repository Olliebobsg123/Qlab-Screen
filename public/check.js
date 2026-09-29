import { deptFetch, escapeHtml } from "/shared.js";

const $ = (selector) => document.querySelector(selector);
const ICONS = { ok: "✓", warn: "!", fail: "✕", info: "i" };
const ACTION_LABELS = { clearStandbys: "Clear standbys", clearPage: "Clear call", resetStarts: "Back to first cues" };
let checking = false;

runCheck();
// Keep it current while it's on screen (at the half, people fix things and look again).
setInterval(() => {
  if (document.visibilityState === "visible") runCheck(true);
}, 20000);
$("#recheckButton").addEventListener("click", () => runCheck());

$("#checkGroups").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-fix]");
  if (!button) return;
  button.disabled = true;
  const response = await deptFetch("/api/preshow/fix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fix: button.dataset.fix })
  });
  $("#checkMessage").textContent = response.ok ? "Done." : "That didn't work.";
  runCheck(true);
});

async function runCheck(quiet = false) {
  if (checking) return;
  checking = true;
  if (!quiet) {
    $("#verdict").dataset.verdict = "loading";
    $("#verdictTitle").textContent = "Checking…";
  }
  try {
    const response = await deptFetch("/api/preshow", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Log in as the stage manager (or admin) to run the check.");
    render(data);
  } catch (error) {
    $("#verdict").dataset.verdict = "fail";
    $("#verdictTitle").textContent = "Couldn't run the check";
    $("#verdictDetail").textContent = error.message;
  } finally {
    checking = false;
  }
}

function render(data) {
  const titles = {
    ok: "Ready for the show",
    warn: `Nearly ready: ${data.warnings} thing${data.warnings === 1 ? "" : "s"} to look at`,
    fail: `Not ready: ${data.failures} problem${data.failures === 1 ? "" : "s"}${data.warnings ? ` and ${data.warnings} warning${data.warnings === 1 ? "" : "s"}` : ""}`
  };
  $("#verdict").dataset.verdict = data.verdict;
  $("#verdictTitle").textContent = titles[data.verdict];
  $("#verdictDetail").textContent = `Checked at ${new Date(data.checkedAt).toLocaleTimeString()}`;

  const groups = new Map();
  for (const item of data.items) groups.set(item.group, [...(groups.get(item.group) || []), item]);
  const order = { fail: 0, warn: 1, info: 2, ok: 3 };
  $("#checkGroups").innerHTML = [...groups.entries()].map(([group, items]) => `
    <section class="panel check-group">
      <h2>${escapeHtml(group)}</h2>
      ${items.sort((a, b) => order[a.status] - order[b.status]).map((item) => `
        <div class="check-item" data-status="${item.status}">
          <span class="check-icon" aria-hidden="true">${ICONS[item.status]}</span>
          <div class="check-text">
            <strong>${escapeHtml(item.title)}</strong>
            ${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ""}
            ${item.fix ? `<span class="check-fix">${escapeHtml(item.fix)}</span>` : ""}
          </div>
          ${item.action ? `<button type="button" class="secondary small-button" data-fix="${escapeHtml(item.action)}">${escapeHtml(ACTION_LABELS[item.action] || "Fix")}</button>` : ""}
        </div>`).join("")}
    </section>`).join("");
}
