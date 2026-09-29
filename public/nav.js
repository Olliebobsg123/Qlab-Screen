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
})();
