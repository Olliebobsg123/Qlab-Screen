const $ = (selector) => document.querySelector(selector);

search();
window.launcher.current().then((current) => {
  if (current.lastError) $("#message").textContent = current.lastError;
  if (current.serverUrl) $("#address").value = current.serverUrl.replace(/^http:\/\//, "");
});
$("#searchButton").addEventListener("click", search);
$("#serverButton").addEventListener("click", () => window.launcher.choose({ mode: "server" }));
$("#joinButton").addEventListener("click", () => join($("#address").value));
$("#address").addEventListener("keydown", (event) => {
  if (event.key === "Enter") join($("#address").value);
});
$("#servers").addEventListener("click", (event) => {
  const button = event.target.closest("[data-url]");
  if (button) window.launcher.choose({ mode: "client", serverUrl: button.dataset.url, httpsPort: button.dataset.https });
});

async function search() {
  $("#servers").innerHTML = "<p>Looking on the network…</p>";
  const servers = await window.launcher.discover();
  $("#servers").innerHTML = servers.length
    ? servers.map((server) => `
      <div class="server">
        <span><strong>${escape(server.name)}</strong><br><small>${escape(server.ip)}${server.workspace ? ` · ${escape(server.workspace)}` : ""}</small></span>
        <button type="button" data-url="http://${escape(server.ip)}:${Number(server.httpPort) || 3030}" data-https="${Number(server.httpsPort) || 3443}">Join</button>
      </div>`).join("")
    : "<p>No show computers found. Make sure QLab Connect is running there and you're on the same network, or type its address below.</p>";
}

function join(value) {
  const text = String(value || "").trim();
  if (!text) {
    $("#message").textContent = "Type the show computer's address.";
    return;
  }
  const url = /^https?:\/\//.test(text) ? text : `http://${text}${/:\d+$/.test(text) ? "" : ":3030"}`;
  try {
    const parsed = new URL(url);
    window.launcher.choose({ mode: "client", serverUrl: parsed.origin });
  } catch {
    $("#message").textContent = "That doesn't look like an address.";
  }
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
