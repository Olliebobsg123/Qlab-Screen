import { escapeHtml } from "/shared.js";

const buttons = document.querySelector("#deptButtons");
const form = document.querySelector("#loginForm");
const label = document.querySelector("#loginLabel");
const message = document.querySelector("#loginMessage");
const LAST_KEY = "qlab-last-department";
let selected = "";

loadDepartments();
checkExistingLogin();

buttons.addEventListener("click", (event) => {
  const button = event.target.closest("[data-dept]");
  if (!button) return;
  select(button.dataset.dept, button.dataset.name);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ departmentId: selected, password: form.elements.password.value })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    message.textContent = data.error || "Could not log in.";
    form.elements.password.select();
    return;
  }
  try {
    localStorage.setItem(LAST_KEY, selected);
  } catch {
    // Not remembered in private browsing.
  }
  window.location.href = "/dept.html";
});

async function loadDepartments() {
  const { departments = [] } = await fetch("/api/departments").then((response) => response.json()).catch(() => ({}));
  if (!departments.length) {
    buttons.innerHTML = `<p class="quiet">No departments have been set up yet. The admin can add them in <a href="/admin.html">Admin → Departments</a>.</p>`;
    return;
  }
  buttons.innerHTML = departments.map((department) => `
    <button type="button" class="dept-button" data-dept="${escapeHtml(department.id)}" data-name="${escapeHtml(department.name)}" data-color="${escapeHtml(department.color)}">
      <span class="dept-dot"></span>${escapeHtml(department.name)}
    </button>`).join("");

  let last = "";
  try {
    last = localStorage.getItem(LAST_KEY) || "";
  } catch {
    last = "";
  }
  const lastButton = buttons.querySelector(`[data-dept="${CSS.escape(last)}"]`);
  if (lastButton) select(last, lastButton.dataset.name);
}

function select(id, name) {
  selected = id;
  for (const button of buttons.querySelectorAll("[data-dept]")) {
    button.setAttribute("aria-pressed", String(button.dataset.dept === id));
  }
  label.textContent = `${name} password`;
  form.hidden = false;
  message.textContent = "";
  form.elements.password.value = "";
  form.elements.password.focus();
}

async function checkExistingLogin() {
  const response = await fetch("/api/dept/me", { cache: "no-store" });
  if (!response.ok) return;
  const data = await response.json();
  document.querySelector("#continueName").textContent = data.department.name;
  document.querySelector("#continueCard").hidden = false;
}
