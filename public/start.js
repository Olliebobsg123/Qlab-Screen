// Tick off the setup steps that are already done.
const mark = (id, done, note) => {
  const step = document.querySelector(`#${id}`);
  step.classList.toggle("done", Boolean(done));
  if (note) step.querySelector("div span").textContent = note;
};

const [status, departments] = await Promise.all([
  fetch("/api/status", { cache: "no-store" }).then((response) => response.json()).catch(() => ({})),
  fetch("/api/departments", { cache: "no-store" }).then((response) => response.json()).catch(() => ({}))
]);

mark("stepQlab", status.connected, status.connected ? `Connected to ${status.workspaceName}.` : "");
mark("stepControl", status.controlEnabled, status.controlEnabled ? "Control is on." : "");
const list = departments.departments || [];
const stageManager = list.find((department) => department.role === "stageManager");
mark("stepStageManager", Boolean(stageManager), stageManager ? "The Stage Manager can log in." : "");
const count = list.filter((department) => department.role !== "stageManager").length;
mark("stepDepartments", count > 0, count ? `${count} department${count === 1 ? "" : "s"} set up.` : "");
let backedUp = false;
try {
  backedUp = Boolean(localStorage.getItem("qlab-last-backup"));
} catch {
  backedUp = false;
}
mark("stepBackup", backedUp, backedUp ? "Saved from this browser before. Save again after changes." : "");
