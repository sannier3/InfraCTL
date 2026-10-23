const app = document.querySelector("#app");
let generation = 0;
let toastTimer = 0;
let currentPath = "";

const NAV = [
  ["/", "Vue d'ensemble"],
  ["/agents", "Agents"],
  ["/machines", "Machines"],
  ["/updates", "Mises à jour"],
  ["/packages", "Paquets"],
  ["/jobs", "Travaux"],
  ["/clusters", "Clusters"],
  ["/alerts", "Alertes"],
  ["/settings", "Paramètres"],
];

const STATUS = {
  ONLINE: ["En ligne", "ok live"],
  UNREACHABLE: ["Injoignable", "warn"],
  OFFLINE: ["Hors ligne", "bad"],
  RUNNING: ["En marche", "ok live"],
  STOPPED: ["Arrêté", "warn"],
  UNKNOWN: ["Inconnu", "warn"],
  QUEUED: ["En file", "info"],
  ASSIGNED: ["Assigné", "info"],
  SUCCESS: ["Réussi", "ok"],
  FAILED: ["Échec", "bad"],
  SKIPPED: ["Ignoré", "warn"],
  INTERRUPTED: ["Interrompu", "bad"],
  CANCELLED: ["Annulé", ""],
  REQUIRES_CONFIRMATION: ["Confirmation", "warn"],
  ok: ["Disponible", "ok"],
  degraded: ["Dégradé", "bad"],
  INFO: ["Info", "info"],
  WARNING: ["Avertissement", "warn"],
  CRITICAL: ["Critique", "bad"],
};

const CAPABILITIES = ["system", "apt", "systemd", "journal", "local.metrics", "proxmox.inventory", "proxmox.resources", "lxc.exec", "proxmox.host"];
const SHARED_TARGETS = ["PROXMOX_NODE", "LXC", "VM", "PHYSICAL"];
const ACTIONS = [
  { name: "system.info", label: "État du système", targets: SHARED_TARGETS },
  { name: "system.rebootRequired", label: "Redémarrage requis", targets: SHARED_TARGETS },
  { name: "system.reboot", label: "Redémarrer", targets: SHARED_TARGETS, mutating: true },
  { name: "system.shutdown", label: "Arrêter", targets: SHARED_TARGETS, mutating: true },
  { name: "apt.refresh", label: "Rafraîchir APT", targets: SHARED_TARGETS, mutating: true },
  { name: "apt.check", label: "Voir les mises à jour", targets: SHARED_TARGETS },
  { name: "apt.packages", label: "Paquets installés", targets: SHARED_TARGETS },
  { name: "apt.upgrade", label: "Mettre à jour", targets: SHARED_TARGETS, mutating: true },
  { name: "systemd.failed", label: "Unités en échec", targets: SHARED_TARGETS },
  { name: "systemd.serviceStatus", label: "État d'une unité", targets: SHARED_TARGETS, unit: true },
  { name: "systemd.restart", label: "Redémarrer une unité", targets: SHARED_TARGETS, unit: true, mutating: true },
  { name: "journal.system", label: "Journal système", targets: SHARED_TARGETS, lines: true },
  { name: "journal.service", label: "Journal d'une unité", targets: SHARED_TARGETS, unit: true, lines: true },
  { name: "proxmox.nodeInfo", label: "État du nœud", targets: ["PROXMOX_NODE"] },
  { name: "proxmox.inventory", label: "Inventaire Proxmox", targets: ["PROXMOX_NODE"] },
  { name: "proxmox.resources", label: "Ressources du cluster", targets: ["PROXMOX_NODE"] },
  { name: "proxmox.host.update", label: "Mise à jour de l'hôte", targets: ["PROXMOX_NODE"], mutating: true },
  { name: "lxc.info", label: "Fiche LXC", targets: ["LXC"] },
  { name: "lxc.resources", label: "Ressources LXC", targets: ["LXC"] },
];
const TERMINAL = new Set(["SUCCESS", "FAILED", "SKIPPED", "INTERRUPTED", "UNKNOWN", "CANCELLED", "REQUIRES_CONFIRMATION"]);
const TYPE_LABEL = {
  PROXMOX_NODE: "Nœud Proxmox",
  LXC: "LXC",
  VM: "VM",
  PHYSICAL: "Machine physique",
};
let directory = { machines: [], nodes: [], clusters: [] };
let packageIndex = [];
let installedIndex = [];

window.addEventListener("popstate", () => { void render(); });
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href^='/ui']") : null;
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go(link.getAttribute("href") ?? "/ui");
});

void render();

function go(href) {
  closeDialog();
  const url = new URL(href, location.origin);
  history.pushState(null, "", url.pathname + url.search);
  void render();
}

async function render() {
  const token = ++generation;
  const path = location.pathname.replace(/^\/ui/, "") || "/";
  const samePath = path === currentPath;
  currentPath = path;
  const view = await match(path);
  if (token !== generation || !app) return;
  app.innerHTML = shell(view, samePath);
}

function shell(content, calm) {
  const path = location.pathname.replace(/^\/ui/, "") || "/";
  const links = NAV.map(([href, label]) => {
    const active = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
    return `<a href="/ui${href}" class="${active ? "active" : ""}">${escapeHtml(label)}</a>`;
  }).join("");
  return `<div class="shell">
    <aside class="rail">
      <div class="brand"><strong>Infra</strong><span>Maintenance contrôlée</span></div>
      <nav class="nav">${links}</nav>
      <div class="rail-foot"><button class="ghost" type="button" id="logout">Fermer la session</button></div>
    </aside>
    <main class="main view${calm ? " calm" : ""}">${content}</main>
  </div>`;
}

document.addEventListener("click", (event) => {
  if (event.target instanceof HTMLElement && event.target.id === "logout") {
    void logout();
  }
});

async function match(path) {
  if (path === "/") return overview();
  if (path === "/agents") return agents();
  if (path === "/machines") return machines();
  if (path === "/updates") return updates();
  if (path === "/packages") return installedPackages();
  const machine = path.match(/^\/machines\/([^/]+)$/);
  if (machine) return machineDetail(decodeURIComponent(machine[1] ?? ""));
  if (path === "/jobs") return jobs();
  const job = path.match(/^\/jobs\/([^/]+)$/);
  if (job) return jobDetail(decodeURIComponent(job[1] ?? ""));
  if (path === "/clusters") return clusters();
  if (path === "/alerts") return alerts();
  if (path === "/settings") return settingsPage();
  return `<div class="heading"><div><h1 class="title">Introuvable</h1></div></div>`;
}

async function overview() {
  const [health, agentsPage, jobsPage] = await Promise.all([
    api("/health"),
    api("/agents", { query: { limit: 8 } }),
    api("/jobs", { query: { limit: 8 } }),
    loadDirectory(),
  ]);
  return `<div class="heading"><div><p class="eyebrow">Salle de contrôle</p><h1 class="title">Vue d'ensemble</h1><p class="subtitle">Le serveur attend les agents. Rien n'est poussé vers eux.</p></div>
    <div class="actions"><button class="primary" type="button" data-action="launch">Lancer une action</button></div></div>
    <section class="grid stagger">
      ${stat("Service", health.status)}${stat("Base", health.database)}
      ${stat("Agents en ligne", String(health.agents?.online ?? 0))}
      ${stat("Travaux en cours", String(health.jobs?.running ?? 0))}
    </section>
    <section class="section split trio">
      <div class="panel">${headingRow("Agents", "/ui/agents")}<div class="table-wrap"><table><thead><tr><th>Nom</th><th>Présence</th><th>Vu</th></tr></thead><tbody>${agentRows(agentsPage.data ?? [])}</tbody></table></div></div>
      <div class="panel pending">${headingRow("À mettre à jour", "/ui/updates")}<div class="table-wrap"><table><thead><tr><th>Machine</th><th>Paquets</th></tr></thead><tbody>${pendingRows(directory.machines)}</tbody></table></div></div>
      <div class="panel">${headingRow("Travaux récents", "/ui/jobs")}${jobRows(jobsPage.data ?? [])}</div>
    </section>`;
}

async function agents() {
  const page = await api("/agents", { query: { limit: 100 } });
  const rows = (page.data ?? []).map((agent) => `<tr>
    <td><strong>${escapeHtml(agent.name)}</strong><div class="muted">${escapeHtml(agent.id)}</div></td>
    <td>${escapeHtml(agent.type)}</td>
    <td>${chip(agent.presence)}</td>
    <td>${escapeHtml(String(agent.maxConcurrency))}</td>
    <td class="muted">${escapeHtml((agent.capabilities ?? []).join(", "))}</td>
    <td><button class="ghost" type="button" data-agent-config="${escapeHtml(agent.id)}">Configuration</button> <button class="ghost" type="button" data-edit="${escapeHtml(agent.id)}">Régler</button></td>
  </tr>`).join("");
  return pageHeading("Agents", "Le bouton Configuration donne le fichier YAML ou la commande d'installation.", `<button class="primary" type="button" data-create-agent>Nouvel agent</button>`)
    + table(["Nom", "Type", "Présence", "Concurrence", "Capacités", ""], rows || emptyRow(6));
}

async function machines() {
  const params = new URLSearchParams(location.search);
  const items = await allPages("/machines", { includeHidden: params.get("includeHidden") ?? "false", type: params.get("type") ?? "", status: params.get("status") ?? "" });
  const rows = items.map((machine) => `<tr>
    <td><a href="/ui/machines/${encodeURIComponent(machine.id)}"><strong>${escapeHtml(machine.displayName)}</strong></a><div class="muted">${escapeHtml(machine.hostname)}</div></td>
    <td>${escapeHtml(identityOf(machine))}</td>
    <td>${escapeHtml(addressText(machine))}</td>
    <td>${escapeHtml(updateText(machine))}</td>
    <td>${escapeHtml(typeLabel(machine.type))}</td>
    <td>${chip(machine.status)}</td>
  </tr>`).join("");
  return pageHeading("Machines", "Le nombre de mises à jour vient de la dernière recherche.", `<a class="ghost" href="/ui/machines?includeHidden=true">Inclure les masquées</a>`)
    + searchable("machines", "Nom, IP, type…", table(["Machine", "Identifiant", "IP", "Mises à jour", "Type", "État"], rows || emptyRow(6), { list: "machines" }));
}

async function updates() {
  packageIndex = await packageCatalog();
  const rows = packageIndex.map((item, index) => `<tr>
    <td><button class="text-button" type="button" data-package="${index}">${escapeHtml(item.name)}</button></td>
    <td>${escapeHtml(String(item.machineCount))}</td>
    <td>${escapeHtml(item.newVersions.join(", ") || "—")}</td>
    <td>${item.security ? "Oui" : "—"}</td>
    <td>${escapeHtml(item.changeTypes.join(", ") || "—")}</td>
  </tr>`).join("");
  return pageHeading("Mises à jour", "Dernière recherche de chaque machine. Un clic sur le paquet montre les machines concernées.", "")
    + searchable("updates", "Nom du paquet…", table(["Paquet", "Machines", "Nouvelle version", "Sécurité", "Changement"], rows || emptyRow(5), { list: "updates", sort: { index: 1, dir: "desc" } }));
}

async function installedPackages() {
  installedIndex = await installedCatalog();
  const rows = installedIndex.map((item, index) => `<tr>
    <td><button class="text-button" type="button" data-installed="${index}">${escapeHtml(item.name)}</button></td>
    <td>${escapeHtml(String(item.machineCount))}</td>
    <td>${escapeHtml(versionList(item.versions))}</td>
  </tr>`).join("");
  return pageHeading("Paquets", "Paquets installés relevés sur chaque machine. Un clic montre les machines et la version installée.", `<button class="primary" type="button" data-collect-packages>Relever les paquets</button>`)
    + searchable("packages", "Nom du paquet…", table(["Paquet", "Machines", "Versions"], rows || emptyRow(3), { list: "packages", sort: { index: 1, dir: "desc" } }));
}

function versionList(versions) {
  if (!versions || versions.length === 0) return "—";
  if (versions.length <= 3) return versions.join(", ");
  return `${versions.length} versions`;
}

async function installedCatalog() {
  try {
    const page = await api("/packages");
    return page.data ?? [];
  } catch (error) {
    if (!(error instanceof Error) || error.status !== 404) throw error;
    return [];
  }
}

async function machineDetail(id) {
  const [machine, resources, updates, jobsPage] = await Promise.all([
    api(`/machines/${encodeURIComponent(id)}`),
    api(`/machines/${encodeURIComponent(id)}/resources`, { query: { limit: 12 } }),
    api(`/machines/${encodeURIComponent(id)}/updates`, { query: { limit: 1 } }),
    api(`/machines/${encodeURIComponent(id)}/jobs`, { query: { limit: 8 } }),
    loadDirectory(),
  ]);
  const current = resources.current;
  const memory = current ? percent(current.memoryUsed, current.memoryTotal) : "—";
  const snapshot = updates.data?.[0];
  const packages = (snapshot?.packages ?? []).map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.currentVersion ?? "—")}</td><td>${escapeHtml(item.newVersion ?? "—")}</td><td>${escapeHtml(item.changeType)}</td></tr>`).join("");
  const machineId = escapeHtml(machine.id);
  const link = machine.type === "VM" ? `<button class="ghost" type="button" data-link-proxmox="${machineId}">${machine.proxmox?.vmid ? "Changer le lien Proxmox" : "Lier au Proxmox"}</button>` : "";
  const unlink = machine.type === "VM" && machine.proxmox?.vmid ? `<button class="ghost" type="button" data-unlink-proxmox="${machineId}">Délier</button>` : "";
  const buttons = `${link}${unlink}<button class="ghost" type="button" data-apt="apt.check" data-apt-machine="${machineId}">Rechercher les mises à jour</button><button class="ghost" type="button" data-view-updates="${machineId}">Voir les mises à jour</button><button class="primary" type="button" data-apt="apt.upgrade" data-apt-machine="${machineId}">Mettre à jour</button><button class="ghost" type="button" data-action data-machine="${machineId}" data-type="${escapeHtml(machine.type)}">Lancer une action</button>`;
  const scope = machine.type === "PROXMOX_NODE" ? `<label class="scope"><input id="guest-scope" type="checkbox" /><span class="switch" aria-hidden="true"></span><span><strong>Tous les invités</strong><small>Les boutons agissent aussi sur chaque LXC et chaque VM de ce nœud.</small></span></label>` : "";
  const disk = current?.diskTotal ? `${bytes(current.diskUsed)} / ${bytes(current.diskTotal)}` : "—";
  return pageHeading(machine.displayName, identityLine(machine), buttons)
    + scope
    + `<section class="grid stagger">${stat("Mises à jour", updateText(machine))}${stat("CPU", current ? `${current.cpuUsage} %` : "—")}${stat("Mémoire", memory)}${stat("Disque", disk)}</section>`
    + `<section class="section panel facts">${fact("IP", addressText(machine))}${fact("Identifiant", identityOf(machine))}${fact("État", STATUS[machine.status]?.[0] ?? machine.status)}${fact("Agent", machine.agentId ?? "—")}${fact("Système", machine.system?.prettyName || machine.system?.kernel || "—")}${fact("Disponibilité", uptimeText(current?.uptime))}</section>`
    + `<section class="section panel" id="updates"><h2>Mises à jour APT</h2>${snapshot ? table(["Paquet", "Version", "Nouvelle", "Changement"], packages || emptyRow(4)) : `<p class="empty">Aucune recherche terminée. Le bouton « Rechercher les mises à jour » interroge la machine.</p>`}</section>`
    + `<section class="section panel"><h2>Travaux</h2>${jobRows(jobsPage.data ?? [])}</section>`;
}

async function jobs() {
  const params = new URLSearchParams(location.search);
  const [page] = await Promise.all([
    api("/jobs", { query: { limit: 50, page: params.get("page") ?? "1", status: params.get("status") ?? "" } }),
    loadDirectory(),
  ]);
  return pageHeading("Travaux", "Une action sur plusieurs machines apparaît en une ligne, avec son état. La fiche détaille chaque machine.", `<button class="primary" type="button" data-action>Lancer une action</button>`)
    + table(["Action", "État", "Cible", "Demandé", ""], jobRows(page.data ?? [], true) || emptyRow(5))
    + pager(page.pagination, "/ui/jobs");
}

async function jobDetail(id) {
  const [job, logs] = await Promise.all([
    api(`/jobs/${encodeURIComponent(id)}`),
    api(`/jobs/${encodeURIComponent(id)}/logs`, { query: { limit: 100 } }),
    loadDirectory(),
  ]);
  if (!TERMINAL.has(job.status)) {
    window.setTimeout(() => { if (location.pathname.endsWith(`/jobs/${id}`)) void render(); }, 2000);
  }
  const children = job.executionKind === "PARENT" ? await allPages("/jobs", { parentId: id }) : [];
  const args = Array.isArray(job.resolvedArguments) ? job.resolvedArguments.join(" ") : "";
  const buttons = [];
  if (job.status === "QUEUED" || job.status === "ASSIGNED") buttons.push(`<button class="danger" type="button" data-cancel="${escapeHtml(job.id)}">Annuler</button>`);
  if (["UNKNOWN", "INTERRUPTED", "REQUIRES_CONFIRMATION"].includes(job.status) && !job.acknowledgedAt) buttons.push(`<button class="ghost" type="button" data-ack="${escapeHtml(job.id)}">Acquitter</button>`);
  const logBlocks = (logs.data ?? []).map((line) => `<pre class="log">[${escapeHtml(line.stream)}] ${escapeHtml(line.data)}</pre>`).join("");
  const childRows = children.map((child) => `<tr><td><a href="/ui/jobs/${encodeURIComponent(child.id)}">${escapeHtml(actionLabel(child.action))}</a></td><td>${chip(child.status)}</td><td>${escapeHtml(jobTarget(child))}</td><td>${escapeHtml(exitText(child, []))}</td><td>${escapeHtml(durationText(child, []))}</td><td>${escapeHtml(agentText(child, []))}</td></tr>`).join("");
  return pageHeading(actionLabel(job.action), jobTarget(job), buttons.join(""))
    + `<section class="grid stagger">${stat("État", STATUS[job.status]?.[0] ?? job.status)}${stat("Code", exitText(job, children))}${stat("Durée", durationText(job, children))}${stat("Agent", agentText(job, children))}</section>`
    + `<section class="section panel"><h2>Exécution</h2><p>${escapeHtml(job.resolvedExecutable ?? "Pas encore résolu")} ${escapeHtml(args)}</p>${job.errorMessage ? `<p>${escapeHtml(job.errorCode ?? "")} — ${escapeHtml(job.errorMessage)}</p>` : ""}<pre class="log">${escapeHtml(JSON.stringify(job.result, null, 2) || "Aucun résultat")}</pre></section>`
    + (job.executionKind === "PARENT" ? `<section class="section panel"><h2>Machines</h2>${table(["Action", "État", "Cible", "Code", "Durée", "Agent"], childRows || emptyRow(6))}</section>` : "")
    + `<section class="section"><h2>Journaux</h2>${logBlocks || `<p class="empty">Aucune ligne.</p>`}</section>`;
}

async function clusters() {
  const [clusterPage, nodePage] = await Promise.all([api("/clusters", { query: { limit: 100 } }), api("/nodes", { query: { limit: 100 } })]);
  const clusterRows = (clusterPage.data ?? []).map((cluster) => `<tr><td>${escapeHtml(cluster.name)}</td><td>${escapeHtml(cluster.slug)}</td><td>${escapeHtml(cluster.type)}</td></tr>`).join("");
  const nodeRows = (nodePage.data ?? []).map((node) => `<tr><td>${escapeHtml(node.name)}</td><td>${escapeHtml(node.agentId ?? "—")}</td><td>${escapeHtml(node.version ?? "—")}</td></tr>`).join("");
  return pageHeading("Clusters", "Ces listes se remplissent avec un inventaire Proxmox. Elles restent vides avec seulement des agents linux-node.", "")
    + `<section class="split"><div class="panel"><h2>Clusters</h2>${table(["Nom", "Slug", "Type"], clusterRows || emptyRow(3))}</div><div class="panel"><h2>Nœuds</h2>${table(["Nom", "Agent", "Version"], nodeRows || emptyRow(3))}</div></section>`;
}

async function alerts() {
  const page = await api("/alerts", { query: { limit: 50 } });
  const rows = (page.data ?? []).map((alert) => `<tr><td>${chip(alert.severity)}</td><td><strong>${escapeHtml(alert.title)}</strong><div class="muted">${escapeHtml(alert.message)}</div></td><td class="muted">${escapeHtml(formatDate(alert.createdAt))}</td></tr>`).join("");
  return pageHeading("Alertes", "Ouvertes seulement. Une alerte de nœud offline regroupe ses guests.", "") + table(["Niveau", "Message", "Date"], rows || emptyRow(3));
}

const SETTING_GROUPS = [
  { id: "server", title: "Écoute", note: "Ces valeurs sont enregistrées tout de suite et prises en compte au redémarrage du service.", fields: [
    ["server.bind", "Adresse d'écoute", "text", "Redémarrage du service"],
    ["server.port", "Port", "number", "Redémarrage du service"],
    ["server.logLevel", "Niveau de journal", "select", "Redémarrage du service", ["debug", "info", "warn", "error"]],
    ["server.exposeSwagger", "Documentation API", "boolean", "Redémarrage du service"],
    ["server.bodyLimitBytes", "Taille maximale d'une requête", "number", "octets · redémarrage du service"],
  ]},
  { id: "security", title: "Sécurité des agents", note: "Appliqué immédiatement.", fields: [
    ["security.hmacWindowSeconds", "Fenêtre de signature", "number", "secondes"],
    ["security.longPollSeconds", "Attente longue des travaux", "number", "secondes"],
    ["security.dispatchLeaseSeconds", "Bail d'exécution", "number", "secondes"],
  ]},
  { id: "agents", title: "Présence des agents", note: "Appliqué immédiatement. Hors ligne doit rester supérieur à injoignable.", fields: [
    ["agents.unreachableAfterSeconds", "Injoignable après", "number", "secondes"],
    ["agents.offlineAfterSeconds", "Hors ligne après", "number", "secondes"],
  ]},
  { id: "inventory", title: "Inventaire", note: "Appliqué immédiatement.", fields: [
    ["inventory.hideStoppedAfterSeconds", "Masquer un invité arrêté après", "number", "secondes"],
  ]},
  { id: "metrics", title: "Métriques", note: "Appliqué immédiatement.", fields: [
    ["metrics.retentionDays", "Conservation", "number", "jours"],
  ]},
  { id: "concurrency", title: "Concurrence", note: "Appliqué immédiatement. Pour les mises à jour APT d'un nœud, le serveur retient le plus élevé entre ce plafond et la concurrence APT annoncée par l'agent, sans dépasser la file d'attente de cet agent.", fields: [
    ["concurrency.global", "Travaux simultanés", "number"],
    ["concurrency.perAgent", "Par agent", "number"],
    ["concurrency.perProxmoxNode", "Par nœud Proxmox", "number"],
    ["concurrency.aptPerProxmoxNode", "Mises à jour APT par nœud", "number", "Les LXC d'un nœud partagent ce budget avec l'hôte"],
    ["concurrency.perMachineWrite", "Écriture par machine", "number"],
    ["concurrency.proxmoxHostMaintenancePerCluster", "Maintenance d'hôte par cluster", "number"],
  ]},
  { id: "scheduler", title: "Planificateur", note: "Le rythme est repris immédiatement.", fields: [
    ["scheduler.tickMs", "Rythme", "number", "millisecondes"],
    ["scheduler.noncePurgeEveryTicks", "Purge des signatures", "number", "cycles"],
    ["scheduler.metricPurgeEveryTicks", "Purge des métriques", "number", "cycles"],
  ]},
  { id: "ui", title: "Interface", note: "Le mot de passe, la durée de session et le rechargement s'appliquent tout de suite. Activer ou couper l'interface demande un redémarrage.", fields: [
    ["ui.enabled", "Interface activée", "boolean", "Redémarrage du service"],
    ["ui.sessionHours", "Durée de session", "number", "heures"],
    ["ui.noCache", "Recharger à chaque affichage", "boolean"],
  ]},
];

async function settingsPage() {
  const [settings, agentsPage] = await Promise.all([
    api("/settings"),
    api("/agents", { query: { limit: 100 } }),
  ]);
  const groups = SETTING_GROUPS.map((group) => settingsCard(group, settings)).join("");
  const options = (agentsPage.data ?? []).map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`).join("");
  const agent = `<form class="panel" data-settings="agent"><h2>Agent</h2><p class="muted">Identité, secret, capacités et exécution. L'exécution part à l'agent à son prochain contact. Le nouveau secret doit être recopié dans son fichier.</p><div class="field"><label>Agent</label><select id="settings-agent" name="agentId"><option value="">Choisir</option>${options}</select></div><div id="agent-fields"></div><div class="actions"><button class="primary" type="submit">Enregistrer cet agent</button></div></form>`;
  const state = settings.secrets ?? {};
  const secrets = `<form class="panel" data-settings="secrets"><h2>Secrets</h2><p class="muted">Un champ vide conserve la valeur actuelle. Générer en propose une nouvelle, affichée une seule fois après l'enregistrement. Jeton d'administration : en place. Jeton de lecture : ${state.readToken ? "en place" : "absent"}. Mot de passe de l'interface : ${state.uiPassword ? "en place" : "absent"}. Adresse de la base : en place. Clé de chiffrement des agents : en place, elle reste dans le fichier du serveur.</p><div class="settings-grid">${secretField("secrets.apiToken", "Jeton d'administration", "16 caractères minimum", 16)}${secretField("secrets.readToken", "Jeton de lecture", "Vide pour le conserver", 16)}${secretField("secrets.databaseUrl", "Adresse de la base", "Prise en compte au redémarrage")}${secretField("secrets.uiPassword", "Mot de passe de l'interface", "12 caractères minimum, vide pour le conserver", 12)}</div><label class="scope"><input name="secrets.clearReadToken" type="checkbox" /><span class="switch"></span><span><strong>Retirer le jeton de lecture</strong><span class="hint">Ignoré si un nouveau jeton est saisi au-dessus.</span></span></label><div class="actions"><button class="primary" type="submit">Enregistrer les secrets</button></div></form>`;
  return pageHeading("Paramètres", "Chaque carte s'enregistre seule. Les secrets ne sont jamais réaffichés.", "") + `<section class="settings">${groups}${secrets}${agent}</section>`;
}

function settingsCard(group, settings) {
  const fields = group.fields.map(([path, label, type, extra, choices]) => settingField(path, label, type, valueAt(settings, path), extra, choices)).join("");
  return `<form class="panel" data-settings="${group.id}"><h2>${escapeHtml(group.title)}</h2><p class="muted">${escapeHtml(group.note)}</p><div class="settings-grid">${fields}</div><div class="actions"><button class="primary" type="submit">Enregistrer</button></div></form>`;
}

function settingField(path, label, type, value, extra, choices) {
  const hint = extra ? `<span class="hint">${escapeHtml(extra)}</span>` : "";
  if (type === "boolean" && value == null) {
    return `<label class="field"><span>${escapeHtml(label)}</span><select name="${escapeHtml(path)}" data-bool><option value="">Conserver</option><option value="true">Oui</option><option value="false">Non</option></select>${hint}</label>`;
  }
  if (type === "boolean") {
    return `<label class="scope"><input name="${escapeHtml(path)}" type="checkbox" ${value ? "checked" : ""} /><span class="switch"></span><span><strong>${escapeHtml(label)}</strong>${hint}</span></label>`;
  }
  if (type === "select") {
    const keep = value == null ? `<option value="">Conserver</option>` : "";
    const options = keep + (choices ?? []).map((item) => `<option value="${escapeHtml(item)}" ${item === value ? "selected" : ""}>${escapeHtml(item)}</option>`).join("");
    return `<label class="field"><span>${escapeHtml(label)}</span><select name="${escapeHtml(path)}">${options}</select>${hint}</label>`;
  }
  const placeholder = value == null ? ` placeholder="Conserver"` : "";
  return `<label class="field"><span>${escapeHtml(label)}</span><input name="${escapeHtml(path)}" type="${type}" value="${escapeHtml(value == null ? "" : String(value))}"${placeholder} />${hint}</label>`;
}

function secretField(path, label, hint, min = 0) {
  const button = min > 0 ? `<button class="ghost" type="button" data-generate-secret>Générer</button>` : "";
  const marker = min > 0 ? ` data-secret="${min}" data-secret-label="${escapeHtml(label)}"` : "";
  return `<div class="field"><label>${escapeHtml(label)}</label><span class="secret-line"><input name="${escapeHtml(path)}" type="text" autocomplete="off" spellcheck="false" placeholder="Conserver"${marker} />${button}</span><span class="hint">${escapeHtml(hint)}</span></div>`;
}

function generatedSecret() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let secret = "";
  for (const byte of bytes) secret += alphabet[byte % alphabet.length];
  return secret;
}

function secretValues(form) {
  return [...form.querySelectorAll("input[data-secret]")].flatMap((input) => {
    if (!(input instanceof HTMLInputElement) || input.value.trim() === "") return [];
    return [{ label: input.dataset.secretLabel || "Secret", value: input.value }];
  });
}

function showSecrets(items) {
  if (items.length === 0) return;
  const rows = items.map((item) => `<label class="field"><span>${escapeHtml(item.label)}</span><input readonly value="${escapeHtml(item.value)}" /></label>`).join("");
  openDialog("Secret à recopier", `<p>Cette valeur ne sera plus affichée.</p>${rows}<div class="actions"><button class="ghost" type="button" data-copy-secret>Copier</button><button class="primary" type="button" data-close>Fermer</button></div>`);
}

async function showAgentConfig(id) {
  const result = await api(`/agents/${encodeURIComponent(id)}/config`);
  const warnings = (result.warnings ?? []).map((warning) => `<p class="muted">${escapeHtml(warning)}</p>`).join("");
  openDialog("Configuration de l'agent", `<p>Le fichier se dépose dans <code>/etc/infra-agent/config.yaml</code>. La commande télécharge <code>run-infractl.sh</code> depuis ce site et l'installe avec cette configuration. La machine doit pouvoir cloner le dépôt. Une configuration déjà présente est copiée, puis remplacée.</p>${warnings}<label class="field"><span>Fichier YAML</span><textarea class="config-file" data-config-part="yaml" readonly rows="12">${escapeHtml(result.yaml)}</textarea></label><div class="actions"><button class="ghost" type="button" data-copy-config="yaml">Copier le YAML</button><button class="ghost" type="button" data-download-config="yaml">Télécharger le YAML</button></div><label class="field"><span>Commande d'installation</span><textarea class="config-file" data-config-part="command" readonly rows="12">${escapeHtml(result.command)}</textarea></label><div class="actions"><button class="ghost" type="button" data-copy-config="command">Copier la commande</button><button class="ghost" type="button" data-download-config="command">Télécharger la commande</button><button class="primary" type="button" data-close>Fermer</button></div>`);
}

function valueAt(source, path) {
  return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), source);
}

function putPath(target, path, value) {
  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    cursor[key] ??= {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

function readSettingsForm(form) {
  const body = {};
  for (const element of form.elements) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement) || !element.name || element.name === "agentId") continue;
    if (element.name === "secrets.clearReadToken" || element.name === "capabilities" || element.name.startsWith("identity.")) continue;
    if (element.dataset.bool) {
      if (element.value === "true" || element.value === "false") putPath(body, element.name, element.value === "true");
      continue;
    }
    if (element instanceof HTMLInputElement && element.type === "checkbox") {
      putPath(body, element.name, element.checked);
      continue;
    }
    if (element.value.trim() === "") continue;
    putPath(body, element.name, element.type === "number" ? Number(element.value) : element.value);
  }
  const clear = form.elements.namedItem("secrets.clearReadToken");
  if (clear instanceof HTMLInputElement && clear.checked && !body.secrets?.readToken) {
    body.secrets ??= {};
    body.secrets.readToken = null;
  }
  return body;
}

async function loadDirectory() {
  const [machines, nodes, clusters] = await Promise.all([
    allPages("/machines", { includeHidden: "true" }),
    allPages("/nodes"),
    allPages("/clusters"),
  ]);
  directory = { machines, nodes, clusters };
}

async function allPages(path, query = {}) {
  const first = await api(path, { query: { ...query, limit: 100, page: "1" } });
  const items = [...(first.data ?? [])];
  const pages = Math.min(first.pagination?.pages ?? 1, 10);
  for (let page = 2; page <= pages; page += 1) {
    const next = await api(path, { query: { ...query, limit: 100, page: String(page) } });
    items.push(...(next.data ?? []));
  }
  return items;
}

function typeLabel(type) {
  return TYPE_LABEL[type] ?? type ?? "—";
}

function addressText(machine) {
  const addresses = machine.addresses ?? [];
  return addresses.length > 0 ? addresses.join(", ") : "—";
}

function updateText(machine) {
  if (!machine.updates) return "—";
  const count = String(machine.updates.availableCount);
  return machine.updates.requiresReboot ? `${count} · redémarrage` : count;
}

function fact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function bytes(value) {
  if (value == null || value < 0) return "—";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const rounded = size >= 10 || index === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[index]}`;
}

function uptimeText(seconds) {
  if (seconds == null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days} j ${hours} h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function identityOf(machine) {
  if (machine.proxmox?.vmid) return String(machine.proxmox.vmid);
  if (machine.type === "PROXMOX_NODE") return machine.proxmox?.nodeName || machine.hostname;
  return "—";
}

function identityLine(machine) {
  const kind = typeLabel(machine.type);
  if (machine.proxmox?.vmid) return `${kind} · ${machine.proxmox.vmid} · ${machine.hostname}`;
  if (machine.type === "PROXMOX_NODE") return `${kind} · ${machine.proxmox?.nodeName || machine.hostname}`;
  return `${kind} · ${machine.hostname}`;
}

function machineLabel(machine) {
  const kind = typeLabel(machine.type);
  if (machine.proxmox?.vmid) return `${machine.displayName} · ${kind} · ${machine.proxmox.vmid}`;
  return `${machine.displayName} · ${kind}`;
}

function actionLabel(name) {
  return ACTIONS.find((action) => action.name === name)?.label ?? name;
}

function exitText(job, children) {
  if (job.exitCode != null) return String(job.exitCode);
  const codes = children.map((child) => child.exitCode).filter((code) => code != null);
  if (codes.length === 0) return "—";
  return String(codes.find((code) => code !== 0) ?? 0);
}

function durationText(job, children) {
  if (job.durationMs != null) return formatDuration(job.durationMs);
  const start = Date.parse(job.startedAt ?? "");
  const end = job.finishedAt ? Date.parse(job.finishedAt) : (TERMINAL.has(job.status) ? Number.NaN : Date.now());
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return formatDuration(end - start);
  const durations = children.map((child) => child.durationMs).filter((value) => value != null);
  if (durations.length === 0) return "—";
  return formatDuration(Math.max(...durations));
}

function agentText(job, children) {
  if (job.agentId) return job.agentId;
  const ids = [...new Set(children.map((child) => child.agentId).filter(Boolean))];
  if (ids.length === 0) return "—";
  if (ids.length === 1) return ids[0];
  return `${ids.length} agents`;
}

function formatDuration(value) {
  const ms = Math.max(0, Math.round(value));
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return minuteRest ? `${hours} h ${minuteRest} min` : `${hours} h`;
}

function jobTarget(job) {
  if (job.executionKind === "PARENT") {
    const total = groupFacts(job).total;
    if (total === 1) return "Groupe · 1 machine";
    if (total > 1) return `Groupe · ${total} machines`;
    return "Groupe";
  }
  const machine = directory.machines.find((item) => item.id === job.machineId);
  return machine ? machineLabel(machine) : "—";
}

function groupFacts(job) {
  const counts = job.result?.counts;
  if (!counts || typeof counts !== "object") return { total: 0, text: "" };
  const entries = Object.entries(counts).filter(([, count]) => Number(count) > 0);
  const total = entries.reduce((sum, [, count]) => sum + Number(count), 0);
  return { total, text: entries.map(([status, count]) => countPhrase(status, Number(count))).join(" · ") };
}

function countPhrase(status, count) {
  const forms = {
    SUCCESS: ["réussie", "réussies"],
    FAILED: ["en échec", "en échec"],
    SKIPPED: ["ignorée", "ignorées"],
    RUNNING: ["en cours", "en cours"],
    QUEUED: ["en file", "en file"],
    ASSIGNED: ["assignée", "assignées"],
    INTERRUPTED: ["interrompue", "interrompues"],
    UNKNOWN: ["inconnue", "inconnues"],
    CANCELLED: ["annulée", "annulées"],
    REQUIRES_CONFIRMATION: ["à confirmer", "à confirmer"],
  };
  const pair = forms[status] ?? [status, status];
  return `${count} ${count > 1 ? pair[1] : pair[0]}`;
}

function guestsOf(machine) {
  const nodeName = machine.proxmox?.nodeName;
  if (!nodeName) return [];
  return directory.machines.filter((item) => item.id !== machine.id && item.proxmox?.nodeName === nodeName && item.proxmox?.vmid != null);
}

function guestScopeOn() {
  const input = document.querySelector("#guest-scope");
  return input instanceof HTMLInputElement && input.checked;
}

function selectorFor(machineId) {
  if (guestScopeOn()) return { type: "proxmox-node", id: machineId, includeGuests: true };
  return { type: "machine", id: machineId };
}

function pageHeading(title, subtitle, actions) {
  return `<div class="heading"><div><h1 class="title">${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p></div><div class="actions">${actions}</div></div>`;
}
function headingRow(title, href) { return `<div class="heading"><h2>${escapeHtml(title)}</h2><a href="${href}">Tout voir</a></div>`; }
function stat(label, value) { return `<article class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`; }
function table(headers, body, options = {}) {
  const head = headers.map((header, index) => {
    const dir = options.sort?.index === index ? ` data-dir="${options.sort.dir}"` : "";
    return `<th${dir}>${escapeHtml(header)}</th>`;
  }).join("");
  const list = options.list ? ` data-list="${escapeHtml(options.list)}"` : "";
  const sort = options.sort ? ` data-sort-col="${options.sort.index}" data-sort-dir="${options.sort.dir}"` : "";
  return `<div class="panel table-wrap"><table${list}${sort}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function searchable(list, placeholder, tableHtml) {
  return `<input class="search" data-search="${escapeHtml(list)}" type="search" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" />${tableHtml}<p class="empty filter-empty" data-empty="${escapeHtml(list)}" hidden>Aucun résultat.</p>`;
}
function emptyRow(columns) { return `<tr><td colspan="${columns}"><div class="empty">Rien à montrer.</div></td></tr>`; }
function chip(value) {
  const entry = STATUS[value] ?? [value ?? "—", ""];
  return `<span class="chip ${entry[1]}">${escapeHtml(entry[0])}</span>`;
}
function pendingRows(machines) {
  const pending = machines
    .filter((machine) => !machine.hiddenAt && machine.updates && machine.updates.availableCount > 0)
    .sort((left, right) => right.updates.availableCount - left.updates.availableCount || left.displayName.localeCompare(right.displayName, "fr"));
  return pending.map((machine) => `<tr><td><a href="/ui/machines/${encodeURIComponent(machine.id)}"><strong>${escapeHtml(machine.displayName)}</strong></a><div class="muted">${escapeHtml(typeLabel(machine.type))}</div></td><td>${escapeHtml(updateText(machine))}</td></tr>`).join("") || emptyRow(2);
}
function agentRows(items) {
  return items.map((agent) => `<tr><td>${escapeHtml(agent.name)}</td><td>${chip(agent.presence)}</td><td class="muted">${escapeHtml(formatDate(agent.lastSeenAt))}</td></tr>`).join("") || emptyRow(3);
}
function jobRows(items, raw = false) {
  const rows = items.map((job) => {
    const progress = job.executionKind === "PARENT" ? groupFacts(job).text : "";
    return `<tr><td><a href="/ui/jobs/${encodeURIComponent(job.id)}">${escapeHtml(actionLabel(job.action))}</a></td><td>${chip(job.status)}</td><td>${escapeHtml(jobTarget(job))}${progress ? `<div class="muted">${escapeHtml(progress)}</div>` : ""}</td><td class="muted">${escapeHtml(formatDate(job.createdAt))}</td>${raw ? `<td>${escapeHtml(job.requestedBy ?? "")}</td>` : ""}</tr>`;
  }).join("");
  return raw ? rows : `<div class="table-wrap"><table><thead><tr><th>Action</th><th>État</th><th>Cible</th><th>Date</th></tr></thead><tbody>${rows || emptyRow(4)}</tbody></table></div>`;
}
function pager(pagination, base) {
  if (!pagination || pagination.pages <= 1) return "";
  const page = pagination.page ?? 1;
  return `<div class="pager"><button class="ghost" type="button" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Précédent</button><span>${page} / ${pagination.pages}</span><button class="ghost" type="button" data-page="${page + 1}" ${page >= pagination.pages ? "disabled" : ""}>Suivant</button></div>`;
}

function fold(value) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");
}

function sortTable(header) {
  const tableElement = header.closest("table");
  const index = header.cellIndex;
  const body = tableElement?.tBodies[0];
  if (!tableElement || !body || index < 0) return;
  const next = tableElement.dataset.sortCol === String(index) && tableElement.dataset.sortDir === "asc" ? "desc" : "asc";
  tableElement.dataset.sortCol = String(index);
  tableElement.dataset.sortDir = next;
  const rows = [...body.rows];
  const data = rows.filter((row) => !row.cells[0]?.hasAttribute("colspan"));
  const fillers = rows.filter((row) => row.cells[0]?.hasAttribute("colspan"));
  const direction = next === "asc" ? 1 : -1;
  data.sort((left, right) => fold(left.cells[index]?.innerText ?? "").localeCompare(fold(right.cells[index]?.innerText ?? ""), "fr", { numeric: true }) * direction);
  for (const row of [...data, ...fillers]) body.append(row);
  for (const cell of header.parentElement?.cells ?? []) cell.removeAttribute("data-dir");
  header.dataset.dir = next;
}

function filterTable(input) {
  const list = input.dataset.search ?? "";
  const tableElement = document.querySelector(`table[data-list="${CSS.escape(list)}"]`);
  const empty = document.querySelector(`[data-empty="${CSS.escape(list)}"]`);
  const body = tableElement?.tBodies[0];
  if (!body) return;
  const query = fold(input.value.trim());
  let visible = 0;
  for (const row of body.rows) {
    if (row.cells[0]?.hasAttribute("colspan")) {
      row.hidden = query.length > 0;
      continue;
    }
    const match = query.length === 0 || fold(row.innerText).includes(query);
    row.hidden = !match;
    if (match) visible += 1;
  }
  if (empty instanceof HTMLElement) empty.hidden = visible > 0 || query.length === 0;
}

async function saveSettings(form) {
  try {
    if (form.dataset.settings === "agent") {
      await saveAgentSettings(form);
      return;
    }
    const revealed = secretValues(form);
    const result = await api("/settings", { method: "PUT", body: readSettingsForm(form) });
    toast(result.restartRequired ? "Enregistré. Un redémarrage du service applique l'écoute, le journal, la documentation, la taille des requêtes, la base ou l'activation de l'interface." : "Réglage appliqué");
    if (form.dataset.settings === "secrets") form.reset();
    showSecrets(revealed);
  } catch (error) {
    toast(error instanceof Error ? error.message : "Réglage refusé");
  }
}

async function saveAgentSettings(form) {
  const agentId = new FormData(form).get("agentId");
  if (typeof agentId !== "string" || agentId.length === 0) throw new Error("Choisir un agent");
  const name = namedValue(form, "identity.name");
  const type = namedValue(form, "identity.type");
  const maxConcurrency = namedValue(form, "identity.maxConcurrency");
  const secret = namedValue(form, "identity.secret");
  const capabilities = [...form.querySelectorAll('input[name="capabilities"]:checked')].map((item) => item.value);
  if (!name || !type || !maxConcurrency || capabilities.length === 0) throw new Error("Les réglages de cet agent ne sont pas encore affichés");
  const runtime = readSettingsForm(form);
  if (Object.keys(runtime).length > 0) {
    await api(`/agents/${encodeURIComponent(agentId)}/runtime`, { method: "PUT", body: runtime });
  }
  await api(`/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: { name, type, maxConcurrency: Number(maxConcurrency), capabilities } });
  if (secret) await api(`/agents/${encodeURIComponent(agentId)}/secret`, { method: "POST", body: { secret } });
  const moves = runtime.server?.host || runtime.server?.protocol || runtime.server?.port;
  if (secret) toast("Agent mis à jour. Recopier le secret, puis redémarrer son service.");
  else if (moves) toast("Enregistré. L'agent joindra la nouvelle adresse à son prochain contact.");
  else toast("Agent mis à jour. L'exécution est prise au prochain contact.");
  const secretInput = form.elements.namedItem("identity.secret");
  if (secretInput instanceof HTMLInputElement) secretInput.value = "";
  if (secret) showAgentConfig(agentId);
}

function namedValue(form, name) {
  const element = form.elements.namedItem(name);
  return element instanceof HTMLInputElement || element instanceof HTMLSelectElement ? element.value.trim() : "";
}

let agentSettingsToken = 0;

async function showAgentSettings(agentId) {
  const host = document.querySelector("#agent-fields");
  if (!(host instanceof HTMLElement)) return;
  const token = ++agentSettingsToken;
  if (!agentId) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<p class="muted">Chargement…</p>`;
  try {
    const [agent, page] = await Promise.all([
      api(`/agents/${encodeURIComponent(agentId)}`),
      api(`/agents/${encodeURIComponent(agentId)}/runtime`),
    ]);
    if (token !== agentSettingsToken) return;
    const current = page.settings ?? {};
    const fields = [
      ["server.protocol", "Protocole", "select", "L'agent joindra cette adresse à son prochain contact", ["http", "https"]],
      ["server.host", "Adresse du serveur", "text", "L'agent joindra cette adresse à son prochain contact"],
      ["server.port", "Port du serveur", "number", "L'agent joindra cette adresse à son prochain contact"],
      ["server.requestTimeoutMs", "Délai d'une requête", "number", "millisecondes"],
      ["server.longPollTimeoutMs", "Délai d'attente des travaux", "number", "millisecondes"],
      ["intervals.heartbeatSeconds", "Présence", "number", "secondes"],
      ["intervals.inventorySeconds", "Inventaire", "number", "secondes"],
      ["intervals.resourcesSeconds", "Ressources", "number", "secondes"],
      ["concurrency.total", "Travaux simultanés sur l'agent", "number"],
      ["concurrency.apt", "Mises à jour simultanées", "number", "Annoncé au serveur. Ne peut pas dépasser le total"],
      ["metrics.source", "Source des métriques", "select", "Proxmox exige un cluster et un VMID", ["LOCAL_AGENT", "PROXMOX"]],
      ["machine.type", "Type de machine", "select", null, ["VM", "PHYSICAL"]],
      ["machine.displayName", "Nom affiché", "text"],
      ["proxmox.enabled", "Mode Proxmox", "boolean", "Réservé à un agent proxmox-node, avec un cluster"],
      ["proxmox.clusterId", "Cluster Proxmox", "text"],
      ["proxmox.vmid", "VMID", "number"],
      ["logLevel", "Journal de l'agent", "select", null, ["debug", "info", "warn", "error"]],
      ["version", "Version annoncée", "text"],
    ];
    const identity = `<p class="eyebrow">Identité</p><div class="settings-grid">
      <label class="field"><span>Nom</span><input name="identity.name" value="${escapeHtml(agent.name ?? "")}" /></label>
      <label class="field"><span>Type</span><select name="identity.type"><option value="linux-node" ${agent.type === "linux-node" ? "selected" : ""}>linux-node</option><option value="proxmox-node" ${agent.type === "proxmox-node" ? "selected" : ""}>proxmox-node</option></select></label>
      <label class="field"><span>File d'attente</span><input name="identity.maxConcurrency" type="number" value="${escapeHtml(String(agent.maxConcurrency ?? 4))}" /><span class="hint">Travaux acceptés par cet agent</span></label>
      <div class="field"><label>Nouveau secret</label><span class="secret-line"><input name="identity.secret" type="text" autocomplete="off" spellcheck="false" placeholder="Conserver" data-secret="16" data-secret-label="Secret de l'agent" /><button class="ghost" type="button" data-generate-secret>Générer</button></span><span class="hint">À recopier dans le fichier de l'agent, puis redémarrer son service</span></div>
    </div><div class="field"><span>Capacités</span><div class="checks">${CAPABILITIES.map((item) => `<label><input type="checkbox" name="capabilities" value="${item}" ${(agent.capabilities ?? []).includes(item) ? "checked" : ""}/> ${escapeHtml(item)}</label>`).join("")}</div></div>`;
    const runtime = `<p class="eyebrow">Exécution</p><p class="muted">Conserver laisse le fichier de l'agent tel quel. Un champ déjà enregistré ici est renvoyé tel qu'il est affiché.</p><div class="settings-grid">${fields.map(([path, label, type, extra, choices]) => settingField(path, label, type, valueAt(current, path), extra, choices)).join("")}</div>`;
    host.innerHTML = identity + runtime;
  } catch (error) {
    if (token !== agentSettingsToken) return;
    host.innerHTML = "";
    toast(error instanceof Error ? error.message : "Agent introuvable");
  }
}

async function packageCatalog() {
  try {
    const page = await api("/updates");
    return page.data ?? [];
  } catch (error) {
    if (!(error instanceof Error) || error.status !== 404) throw error;
    return packageCatalogFromMachines();
  }
}

async function packageCatalogFromMachines() {
  const machines = await allPages("/machines");
  const targets = machines.filter((machine) => !machine.updates || machine.updates.availableCount > 0);
  const groups = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const machine = targets[cursor];
      cursor += 1;
      const page = await api(`/machines/${encodeURIComponent(machine.id)}/updates`, { query: { limit: 1 } });
      for (const item of page.data?.[0]?.packages ?? []) {
        const group = groups.get(item.name) ?? { name: item.name, machines: new Map(), newVersions: new Set(), changeTypes: new Set(), security: false };
        if (!group.machines.has(machine.id)) {
          group.machines.set(machine.id, {
            id: machine.id,
            currentVersion: item.currentVersion ?? null,
            newVersion: item.newVersion ?? null,
            changeType: item.changeType ?? "",
            security: Boolean(item.security),
          });
        }
        if (item.newVersion) group.newVersions.add(item.newVersion);
        if (item.changeType) group.changeTypes.add(item.changeType);
        if (item.security) group.security = true;
        groups.set(item.name, group);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, () => worker()));
  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      machineCount: group.machines.size,
      newVersions: [...group.newVersions],
      changeTypes: [...group.changeTypes],
      security: group.security,
      machines: [...group.machines.values()],
    }))
    .sort((left, right) => right.machineCount - left.machineCount || left.name.localeCompare(right.name, "fr"));
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.settings) return;
  event.preventDefault();
  void saveSettings(form);
});

document.addEventListener("change", (event) => {
  const select = event.target;
  if (select instanceof HTMLSelectElement && select.id === "settings-agent") void showAgentSettings(select.value);
});

document.addEventListener("input", (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.dataset.search) filterTable(input);
});

document.addEventListener("click", (event) => {
  const header = event.target instanceof Element ? event.target.closest("th") : null;
  if (header?.textContent?.trim()) {
    sortTable(header);
    return;
  }
  const packageButton = event.target instanceof Element ? event.target.closest("[data-package]") : null;
  if (packageButton instanceof HTMLElement && packageButton.dataset.package !== undefined) {
    void openPackageDialog(Number(packageButton.dataset.package)).catch((error) => toast(error instanceof Error ? error.message : "Action refusée"));
    return;
  }
  const installedButton = event.target instanceof Element ? event.target.closest("[data-installed]") : null;
  if (installedButton instanceof HTMLElement && installedButton.dataset.installed !== undefined) {
    void openInstalledDialog(Number(installedButton.dataset.installed)).catch((error) => toast(error instanceof Error ? error.message : "Action refusée"));
    return;
  }
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return;
  if (target.dataset.createAgent !== undefined) openAgentDialog();
  if (target.dataset.agentConfig) {
    void showAgentConfig(target.dataset.agentConfig).catch((error) => toast(error instanceof Error ? error.message : "Configuration indisponible"));
  }
  if (target.dataset.copyConfig) {
    const text = target.closest(".dialog")?.querySelector(`[data-config-part="${target.dataset.copyConfig}"]`)?.value ?? "";
    const label = target.dataset.copyConfig === "command" ? "Commande copiée" : "Configuration copiée";
    if (text && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(() => toast(label)).catch(() => toast("Sélectionnez le texte pour le copier"));
    }
  }
  if (target.dataset.downloadConfig === "yaml" || target.dataset.downloadConfig === "command") {
    const kind = target.dataset.downloadConfig;
    const text = target.closest(".dialog")?.querySelector(`[data-config-part="${kind}"]`)?.value ?? "";
    const blob = new Blob([text.endsWith("\n") ? text : `${text}\n`], { type: kind === "command" ? "text/x-shellscript" : "application/yaml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = kind === "command" ? "install-agent.sh" : "config.yaml";
    link.click();
    URL.revokeObjectURL(url);
  }
  if (target.dataset.edit) void openEditDialog(target.dataset.edit);
  if (target.dataset.apt === "apt.upgrade") openUpgradeDialog(target.dataset.aptMachine ?? "");
  if (target.dataset.apt === "apt.check") {
    void launchNamed("apt.check", target.dataset.aptMachine ?? "").catch((error) => toast(error instanceof Error ? error.message : "Action refusée"));
  }
  if (target.dataset.viewUpdates) {
    void showUpdates(target.dataset.viewUpdates).catch((error) => toast(error instanceof Error ? error.message : "Action refusée"));
  }
  if (target.dataset.linkProxmox) {
    void openLinkDialog(target.dataset.linkProxmox).catch((error) => toast(error instanceof Error ? error.message : "Action refusée"));
  }
  if (target.dataset.unlinkProxmox) {
    const id = target.dataset.unlinkProxmox;
    void mutate("VM déliée", async () => {
      await api(`/machines/${encodeURIComponent(id)}/proxmox-link`, { method: "DELETE" });
      closeDialog();
    });
  }
  if (target.dataset.generateSecret !== undefined) {
    const field = target.closest(".field");
    const input = field?.querySelector("input");
    if (input instanceof HTMLInputElement) {
      input.value = generatedSecret();
      input.focus();
      input.select();
    }
  }
  if (target.dataset.copySecret !== undefined) {
    const inputs = [...(target.closest(".dialog")?.querySelectorAll("input") ?? [])].filter((item) => item instanceof HTMLInputElement);
    const text = inputs.map((item) => item.value).filter(Boolean).join("\n");
    if (text && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(() => toast("Copié")).catch(() => toast("Sélectionnez le secret pour le copier"));
    }
  }
  if (target.dataset.collectPackages !== undefined) {
    void launchAction("apt.packages", { type: "fleet" }).catch((error) => toast(error instanceof Error ? error.message : "Action refusée"));
  }
  if (target.dataset.action !== undefined) void openActionDialog(target.dataset.machine ?? "", target.dataset.type ?? "");
  if (target.dataset.cancel) void mutate("Annulé", () => api(`/jobs/${target.dataset.cancel}/cancel`, { method: "POST", body: {} }));
  if (target.dataset.ack) void mutate("Acquitté", () => api(`/jobs/${target.dataset.ack}/acknowledge`, { method: "POST", body: {} }));
  if (target.dataset.launchAck === "yes" || target.dataset.launchAck === "no") {
    const pending = pendingLaunch;
    pendingLaunch = null;
    if (pending) void pending(target.dataset.launchAck === "yes").catch((error) => toast(error instanceof Error ? error.message : "Action refusée"));
  }
  if (target.dataset.deleteAgent) {
    const id = target.dataset.deleteAgent;
    void mutate("Agent retiré", async () => {
      await api(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      closeDialog();
      go("/ui/agents");
    });
  }
  if (target.dataset.page) {
    const params = new URLSearchParams(location.search);
    params.set("page", target.dataset.page);
    go(`${location.pathname}?${params.toString()}`);
  }
  if (target.dataset.close !== undefined) closeDialog();
});

function openAgentDialog() {
  openDialog("Nouvel agent", `<form id="dialog-form" class="form-grid">
    ${field("Identifiant", "id", "text", "edge-01")}
    ${field("Nom", "name", "text", "edge-01")}
    <div class="field"><label>Type</label><select name="type"><option value="linux-node">linux-node</option><option value="proxmox-node">proxmox-node</option></select></div>
    <div class="field"><label>Secret</label><span class="secret-line"><input name="secret" type="text" autocomplete="off" spellcheck="false" required data-secret="16" data-secret-label="Secret de l'agent" /><button class="ghost" type="button" data-generate-secret>Générer</button></span><span class="hint">Générer en crée un. Il est affiché une seule fois après l'enregistrement.</span></div>
    ${field("Concurrence", "maxConcurrency", "number", "4")}
    <div class="field"><label>Capacités</label><div class="checks">${CAPABILITIES.map((item) => `<label><input type="checkbox" name="capabilities" value="${item}" ${["system", "apt", "local.metrics"].includes(item) ? "checked" : ""}/> ${item}</label>`).join("")}</div></div>
    <p class="muted">proxmox-node surveille l'hôte et ses LXC. linux-node surveille une VM ou une machine physique.</p>
    <div class="actions"><button class="ghost" type="button" data-close>Fermer</button><button class="primary" type="submit">Enregistrer</button></div>
  </form>`, async (form) => {
    const data = formData(form);
    await api("/agents", { method: "POST", body: { id: data.id, name: data.name || data.id, type: data.type, secret: data.secret, maxConcurrency: Number(data.maxConcurrency || 4), capabilities: data.capabilities } });
    toast("Agent enregistré");
    closeDialog();
    void showAgentConfig(data.id);
    void render();
  });
}

async function openEditDialog(id) {
  const agent = await api(`/agents/${encodeURIComponent(id)}`);
  openDialog(agent.name, `<form id="dialog-form" class="form-grid">
    ${field("Nom", "name", "text", agent.name)}
    <div class="field"><label>Type</label><select name="type"><option value="linux-node" ${agent.type === "linux-node" ? "selected" : ""}>linux-node</option><option value="proxmox-node" ${agent.type === "proxmox-node" ? "selected" : ""}>proxmox-node</option></select></div>
    ${field("Concurrence", "maxConcurrency", "number", String(agent.maxConcurrency))}
    <div class="field"><label>Capacités</label><div class="checks">${CAPABILITIES.map((item) => `<label><input type="checkbox" name="capabilities" value="${item}" ${(agent.capabilities ?? []).includes(item) ? "checked" : ""}/> ${item}</label>`).join("")}</div></div>
    <div class="field"><label>Nouveau secret</label><span class="secret-line"><input name="secret" type="text" autocomplete="off" spellcheck="false" placeholder="Laisser vide pour le conserver" data-secret="16" data-secret-label="Secret de l'agent" /><button class="ghost" type="button" data-generate-secret>Générer</button></span></div>
    <div class="actions"><button class="danger" type="button" data-delete-agent="${escapeHtml(agent.id)}">Retirer</button><button class="ghost" type="button" data-agent-config="${escapeHtml(agent.id)}">Configuration</button><button class="ghost" type="button" data-close>Fermer</button><button class="primary" type="submit">Enregistrer</button></div>
  </form>`, async (form) => {
    const data = formData(form);
    await api(`/agents/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: data.name, type: data.type, maxConcurrency: Number(data.maxConcurrency), capabilities: data.capabilities } });
    if (data.secret) await api(`/agents/${encodeURIComponent(id)}/secret`, { method: "POST", body: { secret: data.secret } });
    toast("Agent mis à jour");
    closeDialog();
    if (data.secret) void showAgentConfig(id);
    void render();
  });
}

async function openPackageDialog(index) {
  const item = packageIndex[index];
  if (!item) return;
  await loadDirectory();
  const entries = item.machines ?? [];
  const known = entries.map((entry) => ({
    entry,
    machine: directory.machines.find((candidate) => candidate.id === entry.id) ?? null,
  }));
  known.sort((left, right) => machineLabel(left.machine ?? { displayName: left.entry.id, type: "" }).localeCompare(machineLabel(right.machine ?? { displayName: right.entry.id, type: "" }), "fr"));
  const running = known.filter((row) => row.machine?.status === "RUNNING").map((row) => row.entry.id);
  const rows = known.map(({ entry, machine }) => {
    const label = machine ? machineLabel(machine) : entry.id;
    const name = machine ? `<a href="/ui/machines/${encodeURIComponent(machine.id)}">${escapeHtml(label)}</a>` : escapeHtml(label);
    return `<tr><td>${name}</td><td>${escapeHtml(machine ? typeLabel(machine.type) : "—")}</td><td>${escapeHtml(versionStep(entry))}</td><td>${machine ? chip(machine.status) : "—"}</td></tr>`;
  }).join("");
  const aside = running.length === known.length ? "" : `<p class="muted">L'installation porte sur les ${running.length} machine${running.length > 1 ? "s" : ""} en marche.</p>`;
  const button = running.length > 0 ? `<button class="primary" type="submit">${running.length === known.length ? "Mettre à jour ces machines" : "Mettre à jour les machines en marche"}</button>` : "";
  openDialog(item.name, `<p class="muted">${known.length} machine${known.length > 1 ? "s" : ""} concernée${known.length > 1 ? "s" : ""}.</p>${table(["Machine", "Type", "Version", "État"], rows || emptyRow(4))}<form id="dialog-form"><p>Installe les mises à jour APT des machines en marche de cette liste. Une simulation est refaite avant. Si un paquet doit être supprimé, cette machine est laissée de côté.</p>${aside}<div class="actions"><button class="ghost" type="button" data-close>Fermer</button>${button}</div></form>`, async () => {
    if (running.length === 0) throw new Error("Aucune machine en marche pour ce paquet");
    if (running.length > 500) throw new Error("Trop de machines pour une seule action");
    await launchAction("apt.upgrade", { type: "machines", ids: running });
  });
}

async function openInstalledDialog(index) {
  const item = installedIndex[index];
  if (!item) return;
  await loadDirectory();
  const known = (item.machines ?? []).map((entry) => ({
    entry,
    machine: directory.machines.find((candidate) => candidate.id === entry.id) ?? null,
  }));
  known.sort((left, right) => machineLabel(left.machine ?? { displayName: left.entry.id, type: "" }).localeCompare(machineLabel(right.machine ?? { displayName: right.entry.id, type: "" }), "fr"));
  const rows = known.map(({ entry, machine }) => {
    const label = machine ? machineLabel(machine) : entry.id;
    const name = machine ? `<a href="/ui/machines/${encodeURIComponent(machine.id)}">${escapeHtml(label)}</a>` : escapeHtml(label);
    return `<tr><td>${name}</td><td>${escapeHtml(machine ? typeLabel(machine.type) : "—")}</td><td>${escapeHtml(entry.version || "—")}</td><td>${machine ? chip(machine.status) : "—"}</td></tr>`;
  }).join("");
  openDialog(item.name, `<p class="muted">${known.length} machine${known.length > 1 ? "s" : ""}.</p>${table(["Machine", "Type", "Version", "État"], rows || emptyRow(4))}<div class="actions"><button class="ghost" type="button" data-close>Fermer</button></div>`);
}

function versionStep(entry) {
  const current = entry.currentVersion || "—";
  const next = entry.newVersion || "—";
  return `${current} → ${next}`;
}

async function openLinkDialog(machineId) {
  await loadDirectory();
  const machine = directory.machines.find((item) => item.id === machineId) ?? null;
  const nodes = directory.nodes;
  if (nodes.length === 0) {
    toast("Aucun nœud Proxmox n'est inventorié.");
    return;
  }
  const nodeOptions = nodes.map((node) => `<option value="${escapeHtml(node.id)}" ${machine?.proxmox?.nodeName === node.name ? "selected" : ""}>${escapeHtml(node.name)}</option>`).join("");
  openDialog("Lier au Proxmox", `<form id="dialog-form" class="form-grid">
    <p>Rattache cette VM à un VMID du nœud. Les actions du nœud la reconnaissent ensuite.</p>
    <div class="field"><label>Nœud</label><select name="nodeId">${nodeOptions}</select></div>
    <div class="field"><label>VMID connu</label><select name="knownVmid"></select></div>
    <div class="field"><label>VMID</label><input name="vmid" type="number" min="1" max="999999999" required /></div>
    <div class="actions"><button class="ghost" type="button" data-close>Fermer</button><button class="primary" type="submit">Lier</button></div>
  </form>`, async (form) => {
    const data = formData(form);
    const vmid = Number(data.vmid);
    if (!Number.isInteger(vmid) || vmid < 1) throw new Error("Indiquer un VMID");
    await api(`/machines/${encodeURIComponent(machineId)}/proxmox-link`, { method: "POST", body: { nodeId: data.nodeId, vmid } });
    toast(`VM liée au VMID ${vmid}`);
    closeDialog();
    void render();
  });
  const form = document.querySelector("#dialog-form");
  if (!(form instanceof HTMLFormElement)) return;
  const fill = () => {
    const node = nodes.find((item) => item.id === new FormData(form).get("nodeId"));
    const known = form.elements.namedItem("knownVmid");
    const input = form.elements.namedItem("vmid");
    if (!(known instanceof HTMLSelectElement) || !(input instanceof HTMLInputElement) || !node) return;
    const guests = directory.machines.filter((item) => item.type === "VM" && item.proxmox?.nodeName === node.name && item.proxmox?.vmid != null);
    known.innerHTML = `<option value="">Saisir un VMID</option>${guests.map((item) => `<option value="${item.proxmox.vmid}">${escapeHtml(String(item.proxmox.vmid))} · ${escapeHtml(item.displayName)}</option>`).join("")}`;
    const current = machine?.proxmox?.nodeName === node.name ? machine.proxmox?.vmid : null;
    if (current) {
      known.value = String(current);
      input.value = String(current);
    }
  };
  form.addEventListener("change", (event) => {
    const changed = event.target;
    if (changed instanceof HTMLSelectElement && changed.name === "nodeId") fill();
    if (changed instanceof HTMLSelectElement && changed.name === "knownVmid" && changed.value) {
      const input = form.elements.namedItem("vmid");
      if (input instanceof HTMLInputElement) input.value = changed.value;
    }
  });
  fill();
}

function openUpgradeDialog(machineId) {
  const guests = guestScopeOn();
  const text = guests
    ? "Installe les mises à jour du nœud et de chaque invité. Une simulation est refaite avant. Si un paquet doit être supprimé, cette machine est laissée de côté."
    : "Installe les mises à jour APT de cette machine. Une simulation est refaite avant. Si un paquet doit être supprimé, l'installation ne démarre pas.";
  openDialog("Mettre à jour", `<form id="dialog-form" class="form-grid">
    <p>${escapeHtml(text)}</p>
    <div class="actions"><button class="ghost" type="button" data-close>Annuler</button><button class="primary" type="submit">Mettre à jour</button></div>
  </form>`, async () => {
    await launchNamed("apt.upgrade", machineId);
  });
}

async function launchNamed(action, machineId) {
  await launchAction(action, selectorFor(machineId));
}

async function showUpdates(machineId) {
  if (!guestScopeOn()) {
    document.querySelector("#updates")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  await loadDirectory();
  const machine = directory.machines.find((item) => item.id === machineId);
  const targets = machine ? [machine, ...guestsOf(machine)] : [];
  const rows = await Promise.all(targets.map(async (item) => {
    const updates = await api(`/machines/${encodeURIComponent(item.id)}/updates`, { query: { limit: 1 } });
    return { item, snapshot: updates.data?.[0] ?? null };
  }));
  const body = rows.map(({ item, snapshot }) => `<tr><td><a href="/ui/machines/${encodeURIComponent(item.id)}">${escapeHtml(machineLabel(item))}</a></td><td>${snapshot ? escapeHtml(String(snapshot.availableCount)) : "—"}</td><td>${snapshot?.requiresReboot ? "Oui" : "—"}</td></tr>`).join("");
  const note = targets.length <= 1 ? `<p class="muted">Aucun invité n'est encore rattaché à ce nœud.</p>` : "";
  openDialog("Mises à jour", `${note}${table(["Machine", "Paquets", "Redémarrage"], body || emptyRow(3))}<div class="actions"><button class="ghost" type="button" data-close>Fermer</button></div>`);
}

async function openActionDialog(machineId, machineType) {
  await loadDirectory();
  const fixed = directory.machines.find((item) => item.id === machineId) ?? null;
  const options = ACTIONS.filter((action) => !machineType || action.targets.includes(machineType))
    .map((action) => `<option value="${action.name}">${escapeHtml(action.label)}</option>`)
    .join("");
  const online = directory.machines.filter((machine) => machine.status === "RUNNING");
  const machineOptions = online.map((machine) => `<option value="${escapeHtml(machine.id)}" ${machine.id === machineId ? "selected" : ""}>${escapeHtml(machineLabel(machine))}</option>`).join("");
  const nodeOptions = directory.nodes.filter((node) => online.some((machine) => machine.id === node.machineId)).map((node) => `<option value="${escapeHtml(node.machineId)}">${escapeHtml(node.name)}</option>`).join("");
  const clusterOptions = directory.clusters.map((cluster) => `<option value="${escapeHtml(cluster.id)}">${escapeHtml(cluster.name)}</option>`).join("");
  const picks = online.map((machine) => `<label><input type="checkbox" name="machinePick" value="${escapeHtml(machine.id)}" /> ${escapeHtml(machineLabel(machine))}</label>`).join("");
  const targetFields = fixed
    ? `<div class="field" data-field="machine"><label>Machine</label><select name="machineId">${machineOptions}</select></div>${guestScopeOn() ? `<p class="muted">Tous les invités de ce nœud sont inclus.</p>` : ""}`
    : `<div class="field"><label>Cible</label><select name="selector"><option value="machine">Une machine</option><option value="machines">Plusieurs machines</option><option value="fleet">Tout le parc</option><option value="cluster">Un cluster</option><option value="proxmox-node">Un nœud Proxmox</option></select></div>
    <div class="field" data-field="machine"><label>Machine</label><select name="machineId">${machineOptions}</select></div>
    <div class="field" data-field="machines" hidden><label>Machines</label><div class="checks">${picks}</div></div>
    <div class="field" data-field="cluster" hidden><label>Cluster</label><select name="clusterId">${clusterOptions}</select></div>
    <div class="field" data-field="node" hidden><label>Nœud</label><select name="nodeId">${nodeOptions}</select></div>
    <label class="scope" data-field="guests" hidden><input id="dialog-guests" name="includeGuests" type="checkbox" checked /><span class="switch" aria-hidden="true"></span><span><strong>Tous les invités</strong><small>Le travail couvre le nœud ou le cluster, et chaque LXC ou VM qu'il porte.</small></span></label>`;
  openDialog("Lancer une action", `<form id="dialog-form" class="form-grid">
    <div class="field"><label>Action</label><select name="action">${options}</select></div>
    ${targetFields}
    <div class="field" data-field="unit" hidden>${field("Unité systemd", "unit", "text", "").replace("<div class=\"field\">", "").replace("</div>", "")}</div>
    <div class="field" data-field="lines" hidden>${field("Lignes de journal", "lines", "number", "100").replace("<div class=\"field\">", "").replace("</div>", "")}</div>
    <div class="actions"><button class="ghost" type="button" data-close>Fermer</button><button class="primary" type="submit">Lancer</button></div>
  </form>`, async (form) => {
    const data = formData(form);
    const chosen = ACTIONS.find((action) => action.name === data.action);
    const selector = fixed && guestScopeOn() && data.machineId === fixed.id ? selectorFor(fixed.id) : fixed ? { type: "machine", id: data.machineId } : buildSelector(form, data);
    if (selector.type === "machine" && !selector.id) throw new Error("Choisir une machine");
    if (selector.type === "machines" && selector.ids.length === 0) throw new Error("Choisir au moins une machine");
    if ((selector.type === "cluster" || selector.type === "proxmox-node") && !selector.id) throw new Error("Choisir une cible");
    const parameters = {};
    if (chosen?.unit && data.unit) parameters.unit = data.unit;
    if (chosen?.lines && data.lines) parameters.lines = Number(data.lines);
    await launchAction(data.action, selector, parameters);
  });
  const form = document.querySelector("#dialog-form");
  if (form instanceof HTMLFormElement) {
    const sync = () => syncActionFields(form);
    form.addEventListener("change", sync);
    sync();
  }
}

function syncActionFields(form) {
  const data = formData(form);
  const chosen = ACTIONS.find((action) => action.name === data.action);
  setHidden(form, "unit", !chosen?.unit);
  setHidden(form, "lines", !chosen?.lines);
  if (!form.elements.namedItem("selector")) return;
  const mode = data.selector;
  setHidden(form, "machine", mode !== "machine");
  setHidden(form, "machines", mode !== "machines");
  setHidden(form, "cluster", mode !== "cluster");
  setHidden(form, "node", mode !== "proxmox-node");
  setHidden(form, "guests", mode !== "cluster" && mode !== "proxmox-node");
}

function setHidden(form, name, hidden) {
  const field = form.querySelector(`[data-field="${name}"]`);
  if (field instanceof HTMLElement) field.hidden = hidden;
}

function buildSelector(form, data) {
  if (data.selector === "fleet") return { type: "fleet" };
  if (data.selector === "machines") {
    const ids = [...form.querySelectorAll("input[name='machinePick']:checked")].map((item) => item.value);
    return { type: "machines", ids };
  }
  if (data.selector === "cluster") return { type: "cluster", id: data.clusterId, includeGuests: data.includeGuests === "on" };
  if (data.selector === "proxmox-node") return { type: "proxmox-node", id: data.nodeId, includeGuests: data.includeGuests === "on" };
  return { type: "machine", id: data.machineId };
}

let pendingLaunch = null;

async function launchAction(action, selector, parameters = {}) {
  const chosen = ACTIONS.find((item) => item.name === action);
  if (chosen?.mutating) {
    try {
      const preview = await api("/actions/preview", { method: "POST", body: { action, requestedBy: "interface", selector, ...(Object.keys(parameters).length ? { parameters } : {}) } });
      const machines = preview.machines ?? [];
      if (machines.length > 0) {
        openAckDialog(machines, (acknowledge) => postAction(action, selector, parameters, acknowledge));
        return;
      }
    } catch (error) {
      if (!(error instanceof Error) || error.status !== 404) throw error;
    }
  }
  await postAction(action, selector, parameters, false);
}

function openAckDialog(machines, start) {
  const rows = machines.flatMap((machine) => (machine.blockers ?? []).map((blocker) => `<tr><td>${escapeHtml(machine.displayName)}</td><td>${escapeHtml(actionLabel(blocker.action))}</td><td>${chip(blocker.status)}</td><td class="muted">${escapeHtml(blocker.errorMessage || "Résultat non confirmé")}</td></tr>`)).join("");
  openDialog("Acquitter avant le lancement", `<p>Ces machines ont une tâche interrompue ou non résolue. Une nouvelle action qui modifie la machine attend cet acquittement.</p>${table(["Machine", "Tâche", "État", "Détail"], rows)}<div class="actions"><button class="ghost" type="button" data-close>Annuler</button><button class="ghost" type="button" data-launch-ack="no">Lancer sans acquitter</button><button class="primary" type="button" data-launch-ack="yes">Acquitter et lancer</button></div>`);
  pendingLaunch = start;
}

async function postAction(action, selector, parameters, acknowledge) {
  const job = await api("/actions", {
    method: "POST",
    body: {
      action,
      requestedBy: "interface",
      selector,
      ...(acknowledge ? { acknowledgeBlockers: true } : {}),
      ...(Object.keys(parameters).length ? { parameters } : {}),
    },
  });
  closeDialog();
  go(`/ui/jobs/${encodeURIComponent(job.id)}`);
}

function openDialog(title, html, onSubmit) {
  closeDialog();
  const back = document.createElement("div");
  back.className = "dialog-back";
  back.innerHTML = `<div class="dialog" role="dialog"><h3>${escapeHtml(title)}</h3>${html}</div>`;
  back.addEventListener("click", (event) => { if (event.target === back) closeDialog(); });
  document.body.append(back);
  const form = document.querySelector("#dialog-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!(form instanceof HTMLFormElement)) return;
    void onSubmit(form).catch((error) => toast(error instanceof Error ? error.message : "Action refusée"));
  });
}
function closeDialog() {
  pendingLaunch = null;
  document.querySelector(".dialog-back")?.remove();
}
function field(label, name, type, value) { return `<div class="field"><label>${escapeHtml(label)}</label><input name="${name}" type="${type}" value="${escapeHtml(value)}" /></div>`; }
function formData(form) {
  const data = { capabilities: [] };
  for (const element of form.elements) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) continue;
    if (!element.name) continue;
    if (element instanceof HTMLInputElement && element.type === "checkbox" && element.name === "capabilities") {
      if (element.checked) data.capabilities.push(element.value);
      continue;
    }
    if (element instanceof HTMLInputElement && element.type === "checkbox") {
      data[element.name] = element.checked ? "on" : "";
      continue;
    }
    data[element.name] = element.value.trim();
  }
  return data;
}

async function mutate(message, action) {
  try {
    await action();
    toast(message);
    void render();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Action refusée");
  }
}

async function api(path, options = {}) {
  const url = new URL(`/api/v1${path}`, location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  const method = options.method ?? "GET";
  const headers = { accept: "application/json" };
  if (method !== "GET" && method !== "HEAD") headers["x-infra-request"] = "1";
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, { method, headers, credentials: "same-origin", cache: "no-store", body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
  if (response.status === 401) {
    location.href = "/ui/login";
    throw new Error("session expirée");
  }
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message ?? "requête refusée");
    error.status = response.status;
    throw error;
  }
  return body;
}

async function logout() {
  await fetch("/ui/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
  location.href = "/ui/login";
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), 3200);
}
function percent(used, total) { return total > 0 ? `${Math.round((used * 100) / total)} %` : "—"; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char); }
