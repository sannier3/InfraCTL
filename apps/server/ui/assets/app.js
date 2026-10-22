const app = document.querySelector("#app");
let generation = 0;
let toastTimer = 0;
let currentPath = "";

const NAV = [
  ["/", "Vue d'ensemble"],
  ["/agents", "Agents"],
  ["/machines", "Machines"],
  ["/jobs", "Travaux"],
  ["/clusters", "Clusters"],
  ["/alerts", "Alertes"],
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
  { name: "apt.check", label: "Voir les mises à jour", targets: SHARED_TARGETS },
  { name: "apt.upgrade", label: "Mettre à jour", targets: SHARED_TARGETS },
];
const TERMINAL = new Set(["SUCCESS", "FAILED", "SKIPPED", "INTERRUPTED", "UNKNOWN", "CANCELLED", "REQUIRES_CONFIRMATION"]);

window.addEventListener("popstate", () => { void render(); });
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href^='/ui']") : null;
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go(link.getAttribute("href") ?? "/ui");
});

void render();

function go(href) {
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
  const machine = path.match(/^\/machines\/([^/]+)$/);
  if (machine) return machineDetail(decodeURIComponent(machine[1] ?? ""));
  if (path === "/jobs") return jobs();
  const job = path.match(/^\/jobs\/([^/]+)$/);
  if (job) return jobDetail(decodeURIComponent(job[1] ?? ""));
  if (path === "/clusters") return clusters();
  if (path === "/alerts") return alerts();
  return `<div class="heading"><div><h1 class="title">Introuvable</h1></div></div>`;
}

async function overview() {
  const [health, agentsPage, jobsPage] = await Promise.all([
    api("/health"),
    api("/agents", { query: { limit: 8 } }),
    api("/jobs", { query: { limit: 8 } }),
  ]);
  return `<div class="heading"><div><p class="eyebrow">Salle de contrôle</p><h1 class="title">Vue d'ensemble</h1><p class="subtitle">Le serveur attend les agents. Rien n'est poussé vers eux.</p></div>
    <div class="actions"><button class="primary" type="button" data-action="launch">Lancer une action</button></div></div>
    <section class="grid stagger">
      ${stat("Service", health.status)}${stat("Base", health.database)}
      ${stat("Agents en ligne", String(health.agents?.online ?? 0))}
      ${stat("Travaux en cours", String(health.jobs?.running ?? 0))}
    </section>
    <section class="section split">
      <div class="panel">${headingRow("Agents", "/ui/agents")}<div class="table-wrap"><table><tbody>${agentRows(agentsPage.data ?? [])}</tbody></table></div></div>
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
    <td><button class="ghost" type="button" data-edit="${escapeHtml(agent.id)}">Régler</button></td>
  </tr>`).join("");
  return pageHeading("Agents", "Enregistrés à la main ou depuis cette page. Le secret n'est jamais relu.", `<button class="primary" type="button" data-create-agent>Nouvel agent</button>`)
    + table(["Nom", "Type", "Présence", "Concurrence", "Capacités", ""], rows || emptyRow(6));
}

async function machines() {
  const params = new URLSearchParams(location.search);
  const page = await api("/machines", { query: { limit: 50, page: params.get("page") ?? "1", includeHidden: params.get("includeHidden") ?? "false", type: params.get("type") ?? "", status: params.get("status") ?? "" } });
  const rows = (page.data ?? []).map((machine) => `<tr>
    <td><a href="/ui/machines/${encodeURIComponent(machine.id)}"><strong>${escapeHtml(machine.displayName)}</strong></a><div class="muted">${escapeHtml(machine.hostname)}</div></td>
    <td>${escapeHtml(machine.type)}</td>
    <td>${chip(machine.status)}</td>
    <td>${escapeHtml(machine.agentId ?? "—")}</td>
    <td class="muted">${escapeHtml(formatDate(machine.lastSeenAt))}</td>
  </tr>`).join("");
  return pageHeading("Machines", "Une machine apparaît après le premier inventaire de son agent.", `<a class="ghost" href="/ui/machines?includeHidden=true">Inclure les masquées</a>`)
    + table(["Machine", "Type", "État", "Agent", "Vu"], rows || emptyRow(5));
}

async function machineDetail(id) {
  const [machine, resources, updates, jobsPage] = await Promise.all([
    api(`/machines/${encodeURIComponent(id)}`),
    api(`/machines/${encodeURIComponent(id)}/resources`, { query: { limit: 12 } }),
    api(`/machines/${encodeURIComponent(id)}/updates`, { query: { limit: 1 } }),
    api(`/machines/${encodeURIComponent(id)}/jobs`, { query: { limit: 8 } }),
  ]);
  const current = resources.current;
  const memory = current ? percent(current.memoryUsed, current.memoryTotal) : "—";
  const snapshot = updates.data?.[0];
  const packages = (snapshot?.packages ?? []).map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.currentVersion ?? "—")}</td><td>${escapeHtml(item.newVersion ?? "—")}</td><td>${escapeHtml(item.changeType)}</td></tr>`).join("");
  const canUpgrade = ACTIONS.some((action) => action.name === "apt.upgrade" && action.targets.includes(machine.type));
  const upgrade = canUpgrade ? `<button class="primary" type="button" data-upgrade="${escapeHtml(machine.id)}">Mettre à jour</button>` : "";
  return pageHeading(machine.displayName, `${machine.type} · ${machine.hostname}`, `${upgrade}<button class="ghost" type="button" data-action data-machine="${escapeHtml(machine.id)}" data-type="${escapeHtml(machine.type)}">Lancer une action</button>`)
    + `<section class="grid stagger">${stat("État", machine.status)}${stat("CPU", current ? `${current.cpuUsage} %` : "—")}${stat("Mémoire", memory)}${stat("Mises à jour", snapshot ? String(snapshot.availableCount) : "—")}</section>`
    + `<section class="section panel"><h2>Mises à jour APT</h2>${snapshot ? table(["Paquet", "Version", "Nouvelle", "Changement"], packages || emptyRow(4)) : `<p class="empty">Aucun apt.check terminé.</p>`}</section>`
    + `<section class="section panel"><h2>Travaux</h2>${jobRows(jobsPage.data ?? [])}</section>`;
}

async function jobs() {
  const params = new URLSearchParams(location.search);
  const page = await api("/jobs", { query: { limit: 50, page: params.get("page") ?? "1", status: params.get("status") ?? "" } });
  return pageHeading("Travaux", "Une action nommée, jamais une commande.", `<button class="primary" type="button" data-action>Lancer une action</button>`)
    + table(["Action", "État", "Cible", "Demandé", ""], jobRows(page.data ?? [], true) || emptyRow(5))
    + pager(page.pagination, "/ui/jobs");
}

async function jobDetail(id) {
  const [job, logs] = await Promise.all([
    api(`/jobs/${encodeURIComponent(id)}`),
    api(`/jobs/${encodeURIComponent(id)}/logs`, { query: { limit: 100 } }),
  ]);
  if (!TERMINAL.has(job.status)) {
    window.setTimeout(() => { if (location.pathname.endsWith(`/jobs/${id}`)) void render(); }, 2000);
  }
  const children = job.executionKind === "PARENT" ? await api("/jobs", { query: { parentId: id, limit: 100 } }) : null;
  const args = Array.isArray(job.resolvedArguments) ? job.resolvedArguments.join(" ") : "";
  const buttons = [];
  if (job.status === "QUEUED" || job.status === "ASSIGNED") buttons.push(`<button class="danger" type="button" data-cancel="${escapeHtml(job.id)}">Annuler</button>`);
  if (["UNKNOWN", "INTERRUPTED", "REQUIRES_CONFIRMATION"].includes(job.status) && !job.acknowledgedAt) buttons.push(`<button class="ghost" type="button" data-ack="${escapeHtml(job.id)}">Acquitter</button>`);
  const logBlocks = (logs.data ?? []).map((line) => `<pre class="log">[${escapeHtml(line.stream)}] ${escapeHtml(line.data)}</pre>`).join("");
  return pageHeading(job.action, job.id, buttons.join(""))
    + `<section class="grid stagger">${stat("État", job.status)}${stat("Code", job.exitCode ?? "—")}${stat("Durée", job.durationMs != null ? `${job.durationMs} ms` : "—")}${stat("Agent", job.agentId ?? "—")}</section>`
    + `<section class="section panel"><h2>Exécution</h2><p>${escapeHtml(job.resolvedExecutable ?? "Pas encore résolu")} ${escapeHtml(args)}</p>${job.errorMessage ? `<p>${escapeHtml(job.errorCode ?? "")} — ${escapeHtml(job.errorMessage)}</p>` : ""}<pre class="log">${escapeHtml(JSON.stringify(job.result, null, 2) || "Aucun résultat")}</pre></section>`
    + (children ? `<section class="section panel"><h2>Enfants</h2>${jobRows(children.data ?? [])}</section>` : "")
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

function pageHeading(title, subtitle, actions) {
  return `<div class="heading"><div><h1 class="title">${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p></div><div class="actions">${actions}</div></div>`;
}
function headingRow(title, href) { return `<div class="heading"><h2>${escapeHtml(title)}</h2><a href="${href}">Tout voir</a></div>`; }
function stat(label, value) { return `<article class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`; }
function table(headers, body) {
  if (body.includes("<tr>")) return `<div class="panel table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
  return `<div class="panel table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function emptyRow(columns) { return `<tr><td colspan="${columns}"><div class="empty">Rien à montrer.</div></td></tr>`; }
function chip(value) {
  const entry = STATUS[value] ?? [value ?? "—", ""];
  return `<span class="chip ${entry[1]}">${escapeHtml(entry[0])}</span>`;
}
function agentRows(items) {
  return items.map((agent) => `<tr><td>${escapeHtml(agent.name)}</td><td>${chip(agent.presence)}</td><td class="muted">${escapeHtml(formatDate(agent.lastSeenAt))}</td></tr>`).join("") || emptyRow(3);
}
function jobRows(items, raw = false) {
  const rows = items.map((job) => `<tr><td><a href="/ui/jobs/${encodeURIComponent(job.id)}">${escapeHtml(job.action)}</a></td><td>${chip(job.status)}</td><td class="muted">${escapeHtml(job.machineId ?? job.executionKind)}</td><td class="muted">${escapeHtml(formatDate(job.createdAt))}</td>${raw ? `<td>${escapeHtml(job.requestedBy ?? "")}</td>` : ""}</tr>`).join("");
  return raw ? rows : `<div class="table-wrap"><table><tbody>${rows || emptyRow(4)}</tbody></table></div>`;
}
function pager(pagination, base) {
  if (!pagination || pagination.pages <= 1) return "";
  const page = pagination.page ?? 1;
  return `<div class="pager"><button class="ghost" type="button" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Précédent</button><span>${page} / ${pagination.pages}</span><button class="ghost" type="button" data-page="${page + 1}" ${page >= pagination.pages ? "disabled" : ""}>Suivant</button></div>`;
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return;
  if (target.dataset.createAgent !== undefined) openAgentDialog();
  if (target.dataset.edit) void openEditDialog(target.dataset.edit);
  if (target.dataset.upgrade) openUpgradeDialog(target.dataset.upgrade);
  if (target.dataset.action !== undefined) openActionDialog(target.dataset.machine ?? "", target.dataset.type ?? "");
  if (target.dataset.cancel) void mutate("Annulé", () => api(`/jobs/${target.dataset.cancel}/cancel`, { method: "POST", body: {} }));
  if (target.dataset.ack) void mutate("Acquitté", () => api(`/jobs/${target.dataset.ack}/acknowledge`, { method: "POST", body: {} }));
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
    ${field("Secret", "secret", "password", "")}
    ${field("Concurrence", "maxConcurrency", "number", "4")}
    <div class="field"><label>Capacités</label><div class="checks">${CAPABILITIES.map((item) => `<label><input type="checkbox" name="capabilities" value="${item}" ${["system", "apt", "local.metrics"].includes(item) ? "checked" : ""}/> ${item}</label>`).join("")}</div></div>
    <p class="muted">Le mode proxmox-node peut être enregistré. L'agent de cette version refuse encore de démarrer dans ce mode.</p>
    <div class="actions"><button class="ghost" type="button" data-close>Fermer</button><button class="primary" type="submit">Enregistrer</button></div>
  </form>`, async (form) => {
    const data = formData(form);
    await api("/agents", { method: "POST", body: { id: data.id, name: data.name || data.id, type: data.type, secret: data.secret, maxConcurrency: Number(data.maxConcurrency || 4), capabilities: data.capabilities } });
    toast("Agent enregistré. Recopier le secret dans son fichier de configuration.");
    closeDialog();
    void render();
  });
}

async function openEditDialog(id) {
  const agent = await api(`/agents/${encodeURIComponent(id)}`);
  openDialog(agent.name, `<form id="dialog-form" class="form-grid">
    ${field("Nom", "name", "text", agent.name)}
    ${field("Concurrence", "maxConcurrency", "number", String(agent.maxConcurrency))}
    <div class="field"><label>Capacités</label><div class="checks">${CAPABILITIES.map((item) => `<label><input type="checkbox" name="capabilities" value="${item}" ${(agent.capabilities ?? []).includes(item) ? "checked" : ""}/> ${item}</label>`).join("")}</div></div>
    <div class="field"><label>Nouveau secret</label><input name="secret" type="password" placeholder="Laisser vide pour le conserver" autocomplete="new-password" /></div>
    <div class="actions"><button class="danger" type="button" data-delete-agent="${escapeHtml(agent.id)}">Retirer</button><button class="ghost" type="button" data-close>Fermer</button><button class="primary" type="submit">Enregistrer</button></div>
  </form>`, async (form) => {
    const data = formData(form);
    await api(`/agents/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: data.name, maxConcurrency: Number(data.maxConcurrency), capabilities: data.capabilities } });
    if (data.secret) await api(`/agents/${encodeURIComponent(id)}/secret`, { method: "POST", body: { secret: data.secret } });
    toast("Agent mis à jour");
    closeDialog();
    void render();
  });
}

function openUpgradeDialog(machineId) {
  openDialog("Mettre à jour", `<form id="dialog-form" class="form-grid">
    <p>Installe les mises à jour APT de cette machine, qu'elle soit un hôte, un LXC ou une VM. Une simulation est refaite avant. Si un paquet doit être supprimé, l'installation ne démarre pas.</p>
    <div class="actions"><button class="ghost" type="button" data-close>Annuler</button><button class="primary" type="submit">Mettre à jour</button></div>
  </form>`, async () => {
    const job = await api("/actions", { method: "POST", body: { action: "apt.upgrade", requestedBy: "interface", selector: { type: "machine", id: machineId } } });
    closeDialog();
    go(`/ui/jobs/${encodeURIComponent(job.id)}`);
  });
}

function openActionDialog(machineId, machineType) {
  const options = ACTIONS.filter((action) => !machineType || action.targets.includes(machineType))
    .map((action) => `<option value="${action.name}">${escapeHtml(action.label)}</option>`)
    .join("");
  openDialog("Lancer une action", `<form id="dialog-form" class="form-grid">
    <div class="field"><label>Action</label><select name="action">${options}</select></div>
    <div class="field"><label>Cible</label><select name="selector">${machineId ? "" : ""}<option value="machine">Une machine</option><option value="machines">Plusieurs machines</option><option value="fleet">Tout le parc</option><option value="cluster">Un cluster</option><option value="proxmox-node">Un nœud Proxmox</option></select></div>
    ${field("Identifiant machine ou nœud", "id", "text", machineId)}
    <div class="field"><label>Identifiants, un par ligne</label><textarea name="ids" rows="4"></textarea></div>
    <label class="checks"><input type="checkbox" name="includeGuests" checked /> Inclure les guests</label>
    <div class="actions"><button class="ghost" type="button" data-close>Fermer</button><button class="primary" type="submit">Lancer</button></div>
  </form>`, async (form) => {
    const data = formData(form);
    const selector = buildSelector(data);
    const job = await api("/actions", { method: "POST", body: { action: data.action, requestedBy: "interface", selector } });
    closeDialog();
    go(`/ui/jobs/${encodeURIComponent(job.id)}`);
  });
}

function buildSelector(data) {
  if (data.selector === "fleet") return { type: "fleet" };
  if (data.selector === "machines") return { type: "machines", ids: data.ids.split(/\s+/).filter(Boolean) };
  if (data.selector === "cluster") return { type: "cluster", id: data.id, includeGuests: data.includeGuests === "on" };
  if (data.selector === "proxmox-node") return { type: "proxmox-node", id: data.id, includeGuests: data.includeGuests === "on" };
  return { type: "machine", id: data.id };
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
function closeDialog() { document.querySelector(".dialog-back")?.remove(); }
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
  const response = await fetch(url, { method, headers, credentials: "same-origin", body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
  if (response.status === 401) {
    location.href = "/ui/login";
    throw new Error("session expirée");
  }
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? "requête refusée");
  return body;
}

async function logout() {
  await fetch("/ui/logout", { method: "POST", credentials: "same-origin" });
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
