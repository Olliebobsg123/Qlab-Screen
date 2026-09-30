// One menu for every page, so they all match. Pages include <nav class="topnav" data-nav></nav>.
(() => {
  const groups = [
    { label: "Start", items: [{ href: "/start.html", text: "Start" }, { href: "/check.html", text: "Check" }] },
    {
      label: "Watch",
      items: [
        { href: "/", text: "Monitor" },
        { href: "/dashboard.html", text: "TV" }
      ]
    },
    {
      label: "Run cues",
      items: [
        { href: "/login.html", text: "Departments", also: ["/dept.html"] },
        { href: "/midi.html", text: "MIDI", locked: true }
      ]
    },
    {
      label: "Setup",
      items: [
        { href: "/report.html", text: "Report", locked: true },
        { href: "/admin.html", text: "Admin", locked: true, also: ["/viewers.html", "/meter-source.html", "/mac-settings.html"] }
      ]
    }
  ];

  const path = window.location.pathname === "/index.html" ? "/" : window.location.pathname;
  const html = groups.map((group) => `
    <span class="topnav-group" role="group" aria-label="${group.label}">
      ${group.items.map((item) => {
        const current = item.href === path || (item.also || []).includes(path);
        return `<a href="${item.href}"${current ? ' aria-current="page"' : ""}${item.locked ? ' title="Needs the admin login"' : ""}>${item.text}${item.locked ? '<span class="lock" aria-hidden="true"></span>' : ""}</a>`;
      }).join("")}
    </span>`).join('<span class="topnav-divider" aria-hidden="true"></span>');

  for (const nav of document.querySelectorAll("[data-nav]")) {
    nav.innerHTML = html;
    nav.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  // The logo, at the start of every page's title.
  for (const title of document.querySelectorAll(".topbar-title")) {
    if (title.querySelector(".brand-mark")) continue;
    const logo = document.createElement("img");
    logo.className = "brand-mark";
    logo.src = "/logo.svg";
    logo.alt = "";
    title.classList.add("has-brand");
    title.prepend(logo);
  }
})();

// Move to the secure address (e.g. https://frozenjr.duckdns.org, no "not secure" warning) when
// there is one, but only after checking this device can reach it: on a network whose name
// servers don't know it, stay on this address rather than land on "site can't be reached".
(async () => {
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || new URLSearchParams(location.search).has("stay")) return;
  const skipKey = "qlabConnect.secureSkip";
  try {
    if (sessionStorage.getItem(skipKey) === location.origin) return;
  } catch {
    // Storage blocked: just check every time.
  }
  try {
    const { origin } = await fetch("/api/secure-origin", { cache: "no-store" }).then((response) => response.json());
    if (!origin || origin === location.origin) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const reached = await fetch(`${origin}/api/secure-origin`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok).catch(() => false);
    clearTimeout(timer);
    if (reached) {
      location.replace(`${origin}${location.pathname}${location.search}${location.hash}`);
      return;
    }
  } catch {
    // No secure address, or this device can't reach it.
  }
  try {
    sessionStorage.setItem(skipKey, location.origin);
  } catch {
    // Ignore.
  }
})();

