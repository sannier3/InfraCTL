#!/bin/bash
# Installation, mise à jour et dépannage d'InfraCTL.
# La configuration vit hors du dépôt git : une mise à jour ne la remplace pas.
set -euo pipefail
umask 077

REPO_DEFAULT="https://git.jbsan.fr/JBSAN-INFORMATIQUE/InfraCTL.git"
BRANCH_DEFAULT="main"
PNPM_VERSION="9.15.9"
SERVER_ROOT="/opt/infra-manager"
AGENT_ROOT="/opt/infra-agent"
SERVER_ETC="/etc/infra-manager"
AGENT_ETC="/etc/infra-agent"
SERVER_STATE="/var/lib/infra-manager"
AGENT_STATE="/var/lib/infra-agent"
SERVER_UNIT="infra-manager"
AGENT_UNIT="infra-agent"

MODE=""
ACTION=""
REPO="$REPO_DEFAULT"
BRANCH="$BRANCH_DEFAULT"
DATABASE=""
DB_URL=""
DB_HOST=""
DB_PORT="3306"
DB_NAME="infra_manager"
DB_USER="infra"
DB_PASSWORD=""
UI_PASSWORD=""
UI_STATE=""
SERVICE_CMD=""
BIND="0.0.0.0"
PORT="8080"
PORT_SET=0
BIND_SET=0
SERVER_PROTOCOL="http"
SERVER_HOST=""
SERVER_PORT="8080"
SERVER_PORT_SET=0
AGENT_ID=""
AGENT_NAME=""
AGENT_TYPE=""
AGENT_SECRET=""
MACHINE_TYPE=""
CLUSTER_ID=""
YES=0
FRESH=0
CONFIG_CHANGED=0
CONFIG_SOURCE=""
DB_REVIEWED=0

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
InfraCTL — installation et entretien

Le script installe les paquets nécessaires, prépare Node.js et pnpm, clone le
dépôt, construit l'application et gère le service systemd.

  sudo bash run-infractl.sh --help
  sudo bash run-infractl.sh --mode server --install
  sudo bash run-infractl.sh --mode server --install --database docker
  sudo bash run-infractl.sh --mode server --install --database existing --db-url 'mysql://infra:mot@10.0.0.17:3306/infra_manager'
  sudo bash run-infractl.sh --mode server --configure
  sudo bash run-infractl.sh --mode agent --configure
  sudo bash run-infractl.sh --mode server --change-password
  sudo bash run-infractl.sh --mode server --ui enable
  sudo bash run-infractl.sh --mode server --ui disable
  sudo bash run-infractl.sh --mode server --service restart
  sudo bash run-infractl.sh --mode server --status
  sudo bash run-infractl.sh --mode server --uninstall
  sudo bash run-infractl.sh --mode server --uninstall --purge
  sudo bash run-infractl.sh --mode agent --install
  sudo bash run-infractl.sh --mode agent --update
  sudo bash run-infractl.sh --mode agent --service status
  sudo bash run-infractl.sh --mode agent --uninstall

Modes
  --mode server|agent

Actions
  --install             installe, ou complète une installation déjà présente
  --configure           reprend la configuration et passe chaque réglage en revue.
                        Entrée conserve la valeur affichée. Une configuration neuve reste possible.
  --update              git pull, reconstruction, migration. Ne touche pas à la configuration
  --uninstall           arrête le service et retire le code. Conserve la configuration
  --change-password     change le mot de passe de l'interface et redémarre le serveur
  --ui enable|disable   active ou coupe l'interface, puis redémarre
  --service start|stop|restart|status
  --status              service, adresse et état de l'interface, sans afficher de secret
  --help

Serveur
  --database docker|existing
  --db-url URL          base déjà en place. Les caractères spéciaux du mot de passe
                        doivent être encodés (%40 pour @, par exemple)
  --db-host --db-port --db-name --db-user --db-password
  --bind ADRESSE        écoute, seulement à la création de la configuration
  --port PORT
  --ui-password SECRET  au moins 12 caractères. Sinon un mot de passe est généré
  --repo URL            dépôt git. Défaut : le dépôt InfraCTL
  --branch NOM          défaut : main
  --yes                 ne redemande pas la confirmation de désinstallation
  --fresh               avec --install ou --configure, remplace la configuration
                        après en avoir fait une copie
  --purge               avec --uninstall, retire aussi la configuration locale.
                        Une base MariaDB distante n'est jamais supprimée.
                        L'instance Docker créée par ce script est alors arrêtée
                        et son volume est effacé.

Agent
  --server-protocol http|https
  --server-host ADRESSE
  --server-port PORT
  --agent-id ID
  --agent-name NOM
  --agent-type linux-node|proxmox-node
  --agent-secret SECRET au moins 16 caractères
  --machine-type VM|PHYSICAL
  --cluster-id ID       requis pour proxmox-node
  --config FICHIER      configuration complète de l'agent. - lit l'entrée
                        standard. Le questionnaire est alors ignoré. Une
                        configuration déjà présente est copiée, puis remplacée.

La configuration du serveur est /etc/infra-manager/config.yaml.
Celle de l'agent est /etc/infra-agent/config.yaml.
Un fichier déjà présent est conservé. La mise à jour ne le réécrit pas,
ne change pas la clé qui chiffre les secrets des agents, et ne remplace pas
agent-settings.json. Une unité systemd déjà installée est aussi conservée.
EOF
}

need_arg() {
  if [ "$#" -lt 2 ] || [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
    die "L'option $1 attend une valeur."
  fi
}

parse_args() {
  if [ "$#" -eq 0 ]; then
    usage
    exit 0
  fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h|help)
        ACTION="help"
        ;;
      --mode)
        need_arg "$@"
        MODE="$2"
        shift
        ;;
      --install|install)
        ACTION="install"
        ;;
      --configure|configure)
        ACTION="configure"
        ;;
      --uninstall|uninstall)
        ACTION="uninstall"
        ;;
      --update|update)
        ACTION="update"
        ;;
      --change-password)
        ACTION="change-password"
        ;;
      --ui)
        need_arg "$@"
        ACTION="ui"
        UI_STATE="$2"
        shift
        ;;
      --service)
        need_arg "$@"
        ACTION="service"
        SERVICE_CMD="$2"
        shift
        ;;
      --status|status)
        ACTION="status"
        ;;
      --database)
        need_arg "$@"
        DATABASE="$2"
        shift
        ;;
      --db-url)
        need_arg "$@"
        DB_URL="$2"
        shift
        ;;
      --db-host)
        need_arg "$@"
        DB_HOST="$2"
        shift
        ;;
      --db-port)
        need_arg "$@"
        DB_PORT="$2"
        shift
        ;;
      --db-name)
        need_arg "$@"
        DB_NAME="$2"
        shift
        ;;
      --db-user)
        need_arg "$@"
        DB_USER="$2"
        shift
        ;;
      --db-password)
        need_arg "$@"
        DB_PASSWORD="$2"
        shift
        ;;
      --ui-password)
        need_arg "$@"
        UI_PASSWORD="$2"
        shift
        ;;
      --repo)
        need_arg "$@"
        REPO="$2"
        shift
        ;;
      --branch)
        need_arg "$@"
        BRANCH="$2"
        shift
        ;;
      --bind)
        need_arg "$@"
        BIND="$2"
        BIND_SET=1
        shift
        ;;
      --port)
        need_arg "$@"
        PORT="$2"
        PORT_SET=1
        shift
        ;;
      --server-protocol)
        need_arg "$@"
        SERVER_PROTOCOL="$2"
        shift
        ;;
      --server-host)
        need_arg "$@"
        SERVER_HOST="$2"
        shift
        ;;
      --server-port)
        need_arg "$@"
        SERVER_PORT="$2"
        SERVER_PORT_SET=1
        shift
        ;;
      --agent-id)
        need_arg "$@"
        AGENT_ID="$2"
        shift
        ;;
      --agent-name)
        need_arg "$@"
        AGENT_NAME="$2"
        shift
        ;;
      --agent-type)
        need_arg "$@"
        AGENT_TYPE="$2"
        shift
        ;;
      --agent-secret)
        need_arg "$@"
        AGENT_SECRET="$2"
        shift
        ;;
      --machine-type)
        need_arg "$@"
        MACHINE_TYPE="$2"
        shift
        ;;
      --cluster-id)
        need_arg "$@"
        CLUSTER_ID="$2"
        shift
        ;;
      --config)
        need_arg "$@"
        CONFIG_SOURCE="$2"
        shift
        ;;
      --yes)
        YES=1
        ;;
      --fresh)
        FRESH=1
        ;;
      --purge)
        PURGE=1
        ;;
      *)
        die "Option inconnue : $1. Lancez --help."
        ;;
    esac
    shift
  done
  PURGE="${PURGE:-0}"
}

materialize_config() {
  [ -n "$CONFIG_SOURCE" ] || return 0
  [ "$MODE" = "agent" ] || die "--config s'utilise avec --mode agent."
  case "$ACTION" in
    install|configure) ;;
    *) die "--config s'utilise avec --install ou --configure." ;;
  esac
  if [ "$CONFIG_SOURCE" = "-" ]; then
    CONFIG_SOURCE="$(mktemp /tmp/infra-agent-config.XXXXXXXXXX)"
    cat > "$CONFIG_SOURCE"
    chmod 600 "$CONFIG_SOURCE"
  fi
  [ -f "$CONFIG_SOURCE" ] || die "Configuration introuvable : $CONFIG_SOURCE"
  [ -s "$CONFIG_SOURCE" ] || die "La configuration injectée est vide."
}

need_root() {
  if [ "$(id -u)" -eq 0 ]; then
    if [[ "$CONFIG_SOURCE" == /tmp/infra-agent-config.* ]]; then
      trap 'rm -f "$CONFIG_SOURCE"' EXIT
    fi
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    if [ -z "$CONFIG_SOURCE" ]; then
      exec sudo bash "$0" "$@"
    fi
    local args=()
    local take=0
    for arg in "$@"; do
      if [ "$take" -eq 1 ]; then
        args+=("$CONFIG_SOURCE")
        take=0
        continue
      fi
      if [ "$arg" = "--config" ]; then
        args+=("--config")
        take=1
        continue
      fi
      args+=("$arg")
    done
    exec sudo bash "$0" "${args[@]}"
  fi
  die "Lancez cette commande avec root ou sudo."
}

need_mode() {
  case "$MODE" in
    server|agent) ;;
    *) die "Indiquez --mode server ou --mode agent." ;;
  esac
}

unit_name() {
  if [ "$MODE" = "server" ]; then
    printf '%s' "$SERVER_UNIT"
  else
    printf '%s' "$AGENT_UNIT"
  fi
}

root_dir() {
  if [ "$MODE" = "server" ]; then
    printf '%s' "$SERVER_ROOT"
  else
    printf '%s' "$AGENT_ROOT"
  fi
}

prompt() {
  local label="$1"
  local default="${2:-}"
  local value=""
  if [ ! -t 0 ]; then
    [ -n "$default" ] || die "$label est requis. Passez l'option correspondante."
    printf '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then
    read -r -p "$label [$default] : " value
    printf '%s' "${value:-$default}"
  else
    read -r -p "$label : " value
    [ -n "$value" ] || die "$label est requis."
    printf '%s' "$value"
  fi
}

prompt_secret() {
  local label="$1"
  local min="$2"
  local value=""
  local again=""
  if [ ! -t 0 ]; then
    die "$label est requis. Passez l'option correspondante."
  fi
  read -r -s -p "$label : " value
  printf '\n' >&2
  read -r -s -p "Confirmer : " again
  printf '\n' >&2
  [ "$value" = "$again" ] || die "Les deux saisies diffèrent."
  [ "${#value}" -ge "$min" ] || die "$label doit contenir au moins $min caractères."
  printf '%s' "$value"
}

confirm() {
  local question="$1"
  local answer=""
  if [ "$YES" -eq 1 ]; then
    return
  fi
  if [ ! -t 0 ]; then
    die "$question Relancez avec --yes pour confirmer."
  fi
  read -r -p "$question [o/N] " answer
  case "$answer" in
    o|O|oui|OUI) ;;
    *) die "Opération annulée." ;;
  esac
}

install_apt() {
  command -v apt-get >/dev/null 2>&1 || die "Ce script cible Debian ou Ubuntu, avec apt-get."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl wget git gnupg openssl sudo
}

install_node() {
  local major=0
  if [ -x /usr/bin/node ]; then
    major="$(/usr/bin/node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')"
  fi
  if [ "$major" -ge 20 ]; then
    say "Node.js $(/usr/bin/node -v) est déjà en place."
    return
  fi
  say "Installation de Node.js 22."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  [ -x /usr/bin/node ] || die "Node.js est introuvable dans /usr/bin/node. Le service systemd l'utilise."
  major="$(/usr/bin/node -p "Number(process.versions.node.split('.')[0])")"
  [ "$major" -ge 20 ] || die "Node.js 20 ou plus récent est requis."
}

install_pnpm() {
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  if [ -x /usr/bin/corepack ]; then
    /usr/bin/corepack enable
    /usr/bin/corepack prepare "pnpm@${PNPM_VERSION}" --activate
  else
    npm install -g "pnpm@${PNPM_VERSION}"
  fi
  hash -r || true
  command -v pnpm >/dev/null 2>&1 || die "pnpm n'a pas pu être installé."
}

pnpm_run() {
  local dir="$1"
  shift
  env -u NODE_ENV -u DATABASE_URL pnpm --dir "$dir" "$@"
}

clone_repo() {
  local dest="$1"
  install -d -m 0755 "$(dirname "$dest")"
  if [ -d "$dest/.git" ]; then
    say "Dépôt déjà présent : $dest"
    return
  fi
  if [ -e "$dest" ]; then
    die "$dest existe déjà et n'est pas un dépôt git. Rien n'a été effacé."
  fi
  say "Clonage de $REPO."
  git -c "safe.directory=${dest}" clone --branch "$BRANCH" "$REPO" "$dest"
}

update_repo() {
  local dest="$1"
  [ -d "$dest/.git" ] || die "Aucun dépôt dans $dest. Lancez d'abord --install."
  say "Mise à jour du code. La configuration, les secrets et agent-settings.json ne sont pas modifiés."
  git -c "safe.directory=${dest}" -C "$dest" fetch origin "$BRANCH"
  git -c "safe.directory=${dest}" -C "$dest" pull --ff-only origin "$BRANCH"
}

build_tree() {
  local dest="$1"
  say "Installation des dépendances et construction."
  pnpm_run "$dest" install --frozen-lockfile
  pnpm_run "$dest" build
}

server_config_file() {
  local from_unit=""
  if [ -f "/etc/systemd/system/${SERVER_UNIT}.service" ]; then
    from_unit="$(sed -n 's/^Environment=CONFIG_PATH=//p' "/etc/systemd/system/${SERVER_UNIT}.service" | head -n 1 | tr -d '\r')"
  fi
  if [ -n "$from_unit" ]; then
    printf '%s\n' "$from_unit"
    return
  fi
  if [ -f "$SERVER_ETC/config.yaml" ]; then
    printf '%s\n' "$SERVER_ETC/config.yaml"
    return
  fi
  if [ -f "$SERVER_ROOT/config.yaml" ]; then
    printf '%s\n' "$SERVER_ROOT/config.yaml"
    return
  fi
  printf '%s\n' "$SERVER_ETC/config.yaml"
}

agent_config_file() {
  printf '%s\n' "$AGENT_ETC/config.yaml"
}

random_hex() {
  openssl rand -hex 24
}

random_key() {
  /usr/bin/node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
}

validate_port() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$label invalide."
  [ "$value" -ge 1 ] && [ "$value" -le 65535 ] || die "$label invalide."
}

refuse_broad_delete() {
  case "$1" in
    /opt/infra-manager|/opt/infra-agent|/etc/infra-manager|/etc/infra-agent|/var/lib/infra-manager|/var/lib/infra-agent)
      ;;
    *)
      die "Refus de supprimer $1."
      ;;
  esac
}

write_server_config() {
  local file="$1"
  local dburl="$2"
  local api reader key password
  api="$(random_hex)"
  reader="$(random_hex)"
  key="$(random_key)"
  if [ -n "$UI_PASSWORD" ]; then
    [ "${#UI_PASSWORD}" -ge 12 ] || die "Le mot de passe de l'interface doit contenir au moins 12 caractères."
    password="$UI_PASSWORD"
  else
    password="$(random_hex)"
    SAY_UI_PASSWORD="$password"
  fi
  SAY_API_TOKEN="$api"
  install -d -m 0750 "$(dirname "$file")"
  node - "$file" "$dburl" "$api" "$reader" "$key" "$password" "$PORT" "$BIND" <<'JS'
const fs = require("node:fs");
const [file, dburl, api, reader, key, password, port, bind] = process.argv.slice(2);
const portNumber = Number(port);
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
  process.stderr.write("Port invalide.\n");
  process.exit(1);
}
const q = (value) => JSON.stringify(String(value));
const text = [
  "# Configuration InfraCTL. Ce fichier est hors du dépôt : une mise à jour ne le remplace pas.",
  "server:",
  `  bind: ${q(bind)}`,
  `  port: ${portNumber}`,
  "  logLevel: info",
  "  exposeSwagger: false",
  "",
  "database:",
  `  url: ${q(dburl)}`,
  "",
  "auth:",
  `  apiToken: ${q(api)}`,
  `  readToken: ${q(reader)}`,
  "",
  "security:",
  `  credentialsKey: ${q(key)}`,
  "  hmacWindowSeconds: 60",
  "  longPollSeconds: 30",
  "  dispatchLeaseSeconds: 120",
  "",
  "agents:",
  "  unreachableAfterSeconds: 30",
  "  offlineAfterSeconds: 60",
  "",
  "inventory:",
  "  hideStoppedAfterSeconds: 300",
  "",
  "metrics:",
  "  retentionDays: 7",
  "",
  "concurrency:",
  "  global: 20",
  "  perAgent: 4",
  "  perProxmoxNode: 4",
  "  aptPerProxmoxNode: 2",
  "  perMachineWrite: 1",
  "  proxmoxHostMaintenancePerCluster: 1",
  "",
  "ui:",
  "  enabled: true",
  `  password: ${q(password)}`,
  "  sessionHours: 12",
  "  noCache: true",
  "",
  "scheduler:",
  "  tickMs: 1000",
  "  noncePurgeEveryTicks: 60",
  "  metricPurgeEveryTicks: 3600",
  "",
].join("\n");
fs.writeFileSync(file, text, { mode: 0o600 });
JS
  chmod 0600 "$file"
}

yaml_pkg() {
  local root="$1"
  local pkg="$root/apps/server/package.json"
  [ -f "$pkg" ] || die "Le serveur n'est pas installé dans $root."
  [ -d "$root/node_modules" ] || die "Les dépendances ne sont pas installées. Lancez --install ou --update."
  printf '%s\n' "$pkg"
}

yaml_edit() {
  local file="$1"
  local key="$2"
  local value="$3"
  local root="$4"
  local pkg
  pkg="$(yaml_pkg "$root")"
  node --input-type=module - "$file" "$key" "$value" "$pkg" <<'JS'
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const [file, key, raw, pkg, type = "auto"] = process.argv.slice(2);
const { parseDocument } = createRequire(pkg)("yaml");
const doc = parseDocument(readFileSync(file, "utf8"));
if (type === "delete") {
  doc.deleteIn(key.split("."));
} else {
  let value = raw;
  if (type === "int") {
    value = Number(raw);
    if (!Number.isInteger(value)) process.exit(1);
  } else if (type === "bool" || (type === "auto" && (raw === "true" || raw === "false"))) {
    value = raw === "true";
  }
  doc.setIn(key.split("."), value);
}
writeFileSync(file, String(doc), { mode: 0o600 });
JS
  chmod 0600 "$file"
}

yaml_get() {
  local file="$1"
  local key="$2"
  local root="$3"
  local pkg
  pkg="$(yaml_pkg "$root")"
  node --input-type=module - "$file" "$key" "$pkg" <<'JS'
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const [file, key, pkg] = process.argv.slice(2);
const { parse } = createRequire(pkg)("yaml");
let cursor = parse(readFileSync(file, "utf8"));
for (const part of key.split(".")) {
  cursor = cursor?.[part];
}
if (cursor === undefined || cursor === null) process.exit(2);
process.stdout.write(String(cursor));
JS
}

mysql_client() {
  if command -v mariadb >/dev/null 2>&1; then
    printf '%s' mariadb
    return
  fi
  if command -v mysql >/dev/null 2>&1; then
    printf '%s' mysql
    return
  fi
  apt-get install -y mariadb-client
  if command -v mariadb >/dev/null 2>&1; then
    printf '%s' mariadb
  else
    printf '%s' mysql
  fi
}

mysql_exec() {
  local host="$1" port="$2" user="$3" password="$4" database="$5"
  local client cnf rc
  client="$(mysql_client)"
  cnf="$(mktemp)"
  node - "$cnf" "$host" "$port" "$user" "$password" <<'JS'
const fs = require("node:fs");
const [file, host, port, user, password] = process.argv.slice(2);
const esc = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
fs.writeFileSync(file, ["[client]", `host=${esc(host)}`, `port=${esc(port)}`, `user=${esc(user)}`, `password=${esc(password)}`, "protocol=tcp", ""].join("\n"), { mode: 0o600 });
JS
  set +e
  "$client" --defaults-extra-file="$cnf" -e "SELECT 1" "$database"
  rc=$?
  set -e
  rm -f "$cnf"
  return "$rc"
}

encode_db_url() {
  node - "$1" "$2" "$3" "$4" "$5" <<'JS'
const [user, password, host, port, database] = process.argv.slice(2);
const url = `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
process.stdout.write(url);
JS
}

split_db_url() {
  node - "$1" <<'JS'
const url = new URL(process.argv[2]);
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
process.stdout.write([
  url.hostname,
  url.port || "3306",
  decodeURIComponent(url.username),
  Buffer.from(decodeURIComponent(url.password), "utf8").toString("base64"),
  database,
].join("\n"));
JS
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && { docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; }; then
    return
  fi
  say "Installation de Docker."
  apt-get install -y docker.io
  apt-get install -y docker-compose-v2 || apt-get install -y docker-compose || true
  systemctl enable --now docker
  docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1 || die "Docker Compose est introuvable."
}

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

start_local_database() {
  install_docker
  install -d -m 0700 "$SERVER_STATE"
  local compose="$SERVER_STATE/compose.yml"
  local password root_password
  if [ ! -f "$compose" ]; then
    password="$(random_hex)"
    root_password="$(random_hex)"
    cat > "$compose" <<EOF
name: infra-manager
services:
  mariadb:
    image: mariadb:11
    container_name: infra-manager-mariadb
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: infra_manager
      MARIADB_USER: infra
      MARIADB_PASSWORD: ${password}
      MARIADB_ROOT_PASSWORD: ${root_password}
    ports:
      - "127.0.0.1:3306:3306"
    volumes:
      - mariadb_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      timeout: 5s
      retries: 30
      start_period: 20s
volumes:
  mariadb_data:
EOF
    chmod 0600 "$compose"
    DB_URL="$(encode_db_url infra "$password" "127.0.0.1" "3306" "infra_manager")"
  else
    say "Le fichier Docker de MariaDB est déjà présent et il est conservé."
    DB_URL="$(node - "$compose" <<'JS'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const password = text.match(/MARIADB_PASSWORD:\s*(\S+)/)?.[1] ?? "";
const url = `mysql://${encodeURIComponent("infra")}:${encodeURIComponent(password)}@127.0.0.1:3306/infra_manager`;
process.stdout.write(url);
JS
)"
  fi
  docker_compose -f "$compose" up -d
  local attempt=0 status=""
  while [ "$attempt" -lt 60 ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' infra-manager-mariadb 2>/dev/null || true)"
    if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
      if mysql_exec "127.0.0.1" "3306" "infra" "$(node -e "const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password))" "$DB_URL")" "infra_manager"; then
        say "MariaDB local est prêt sur 127.0.0.1:3306."
        return
      fi
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  die "MariaDB local ne répond pas encore. Consultez : docker logs infra-manager-mariadb"
}

prepare_existing_database() {
  if [ -z "$DB_URL" ]; then
    if [ -z "$DB_HOST" ]; then
      DB_HOST="$(prompt "Hôte MariaDB" "127.0.0.1")"
    fi
    DB_PORT="$(prompt "Port" "$DB_PORT")"
    DB_NAME="$(prompt "Base" "$DB_NAME")"
    DB_USER="$(prompt "Utilisateur" "$DB_USER")"
    if [ -z "$DB_PASSWORD" ]; then
      DB_PASSWORD="$(prompt_secret "Mot de passe MariaDB" 1)"
    fi
    validate_port "$DB_PORT" "Port MariaDB"
    DB_URL="$(encode_db_url "$DB_USER" "$DB_PASSWORD" "$DB_HOST" "$DB_PORT" "$DB_NAME")"
  fi
  local parts host port user password database
  parts="$(split_db_url "$DB_URL")"
  host="$(printf '%s\n' "$parts" | sed -n '1p')"
  port="$(printf '%s\n' "$parts" | sed -n '2p')"
  user="$(printf '%s\n' "$parts" | sed -n '3p')"
  password="$(printf '%s\n' "$(printf '%s\n' "$parts" | sed -n '4p')" | base64 -d)"
  database="$(printf '%s\n' "$parts" | sed -n '5p')"
  mysql_exec "$host" "$port" "$user" "$password" "$database"
  say "La base existante répond."
}

choose_database() {
  if [ -z "$DATABASE" ] && { [ -n "$DB_URL" ] || [ -n "$DB_HOST" ] || [ -n "$DB_PASSWORD" ]; }; then
    DATABASE="existing"
  fi
  if [ -z "$DATABASE" ]; then
    if [ -t 0 ]; then
      say "Base de données :"
      say "  1) MariaDB déjà en place"
      say "  2) Nouvelle instance Docker sur cette machine"
      local choice=""
      read -r -p "Choix [1] : " choice
      case "${choice:-1}" in
        2) DATABASE="docker" ;;
        *) DATABASE="existing" ;;
      esac
    else
      die "Indiquez --database docker ou --database existing."
    fi
  fi
  if [ "$DATABASE" = "docker" ] && { [ -n "$DB_URL" ] || [ -n "$DB_HOST" ]; }; then
    die "--database docker crée une base locale. Retirez --db-url et --db-host."
  fi
  case "$DATABASE" in
    docker) start_local_database ;;
    existing) prepare_existing_database ;;
    *) die "--database attend docker ou existing." ;;
  esac
}

ensure_local_database() {
  local compose="$SERVER_STATE/compose.yml"
  if [ ! -f "$compose" ]; then
    return
  fi
  install_docker
  say "Démarrage de l'instance MariaDB créée par ce script."
  docker_compose -f "$compose" up -d
}

migrate_database() {
  local root="$1"
  local file="$2"
  local url
  url="$(yaml_get "$file" "database.url" "$root")"
  [ -n "$url" ] || die "database.url est absent de $file."
  say "Application des migrations. L'adresse de la base n'est pas écrite dans le service."
  (
    cd "$root"
    export DATABASE_URL="$url"
    env -u NODE_ENV pnpm prisma:migrate
  )
}

copy_unit() {
  local src="$1"
  local dest="$2"
  local cfg="${3:-}"
  node - "$src" "$dest" "$cfg" <<'JS'
const fs = require("node:fs");
const [src, dest, cfg] = process.argv.slice(2);
let text = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
if (cfg) {
  if (!/^Environment=CONFIG_PATH=.*$/m.test(text)) process.exit(1);
  text = text.replace(/^Environment=CONFIG_PATH=.*$/m, `Environment=CONFIG_PATH=${cfg}`);
}
if (!text.endsWith("\n")) text += "\n";
fs.writeFileSync(dest, text, { mode: 0o644 });
JS
}

install_server_unit() {
  local cfg="$1"
  local unit="/etc/systemd/system/${SERVER_UNIT}.service"
  if [ -f "$unit" ]; then
    say "L'unité systemd du serveur est déjà là. Elle est conservée."
    systemctl daemon-reload
    return
  fi
  copy_unit "$SERVER_ROOT/apps/server/deploy/infra-manager.service" "$unit" "$cfg"
  systemctl daemon-reload
}

install_agent_unit() {
  local unit="/etc/systemd/system/${AGENT_UNIT}.service"
  if [ -f "$unit" ]; then
    say "L'unité systemd de l'agent est déjà là. Elle est conservée."
    systemctl daemon-reload
    return
  fi
  copy_unit "$AGENT_ROOT/apps/agent/deploy/infra-agent.service" "$unit"
  systemctl daemon-reload
}

enable_service() {
  local name="$1"
  systemctl enable --now "$name"
  systemctl --no-pager --full status "$name" || true
}

backup_file() {
  local dir="$1"
  local source="$2"
  local name="$3"
  if [ -f "$source" ]; then
    install -d -m 0700 "$dir"
    cp -a "$source" "$dir/$name"
  fi
}

restore_server_config() {
  local dest="$1"
  if [ -f "$dest" ]; then
    return 1
  fi
  if [ -f "$SERVER_STATE/backup/config.yaml" ]; then
    install -d -m 0750 "$(dirname "$dest")"
    cp -a "$SERVER_STATE/backup/config.yaml" "$dest"
    chmod 0600 "$dest"
    if [ -f "$SERVER_STATE/backup/agent-settings.json" ]; then
      cp -a "$SERVER_STATE/backup/agent-settings.json" "$(dirname "$dest")/agent-settings.json"
      chmod 0600 "$(dirname "$dest")/agent-settings.json"
    fi
    say "Configuration restaurée depuis $SERVER_STATE/backup."
    return 0
  fi
  return 1
}

keep_existing_config() {
  local file="$1"
  local review="${2:-}"
  local choice=""
  if [ ! -f "$file" ] || [ "$FRESH" -eq 1 ]; then
    return 1
  fi
  if [ ! -t 0 ]; then
    say "Configuration conservée : $file"
    return 0
  fi
  say "Configuration actuelle : $file"
  if [ "$review" = "review" ]; then
    say "  1) La conserver et passer les réglages un par un"
  else
    say "  1) La conserver"
  fi
  say "  2) En créer une nouvelle. L'actuelle est copiée avant d'être remplacée."
  read -r -p "Choix [1] : " choice
  case "${choice:-1}" in
    2) return 1 ;;
    *)
      if [ "$review" = "review" ]; then
        say "La configuration actuelle sert de base."
      else
        say "Configuration conservée : $file"
      fi
      return 0
      ;;
  esac
}

ask_server_listen() {
  if [ "$BIND_SET" -eq 0 ] && [ -t 0 ]; then
    BIND="$(prompt "Adresse d'écoute" "$BIND")"
  fi
  if [ "$PORT_SET" -eq 0 ] && [ -t 0 ]; then
    PORT="$(prompt "Port d'écoute" "$PORT")"
  fi
  validate_port "$PORT" "Port"
}

create_server_config() {
  local cfg="$1"
  if [ -f "$cfg" ]; then
    backup_file "$SERVER_STATE/backup" "$cfg" "config.yaml"
    if [ -f "$(dirname "$cfg")/agent-settings.json" ]; then
      backup_file "$SERVER_STATE/backup" "$(dirname "$cfg")/agent-settings.json" "agent-settings.json"
    fi
    say "L'ancienne configuration est copiée dans $SERVER_STATE/backup."
    say "La nouvelle clé de chiffrement ne pourra plus lire les secrets des agents déjà enregistrés."
  else
    say "Création d'une configuration neuve."
  fi
  ask_server_listen
  choose_database
  write_server_config "$cfg" "$DB_URL"
  CONFIG_CHANGED=1
}

restore_agent_backup() {
  local cfg="$1"
  install -d -m 0750 "$AGENT_ETC"
  cp -a "$AGENT_STATE/backup/agent-config.yaml" "$cfg"
  chmod 0600 "$cfg"
  say "Configuration agent restaurée."
}

decide_server_config() {
  local cfg="$1"
  local review="${2:-}"
  local choice=""
  if keep_existing_config "$cfg" "$review"; then
    ensure_local_database
    return 0
  fi
  if [ ! -f "$cfg" ] && [ -f "$SERVER_STATE/backup/config.yaml" ] && [ "$FRESH" -eq 0 ]; then
    if [ -t 0 ]; then
      say "Aucune configuration active. Une copie existe dans $SERVER_STATE/backup."
      say "  1) Reprendre cette copie"
      say "  2) Créer une configuration neuve"
      read -r -p "Choix [1] : " choice
      if [ "${choice:-1}" != "2" ]; then
        restore_server_config "$cfg"
        ensure_local_database
        return 0
      fi
    else
      restore_server_config "$cfg"
      ensure_local_database
      return 0
    fi
  fi
  create_server_config "$cfg"
}

decide_agent_config() {
  local cfg="$1"
  local review="${2:-}"
  local choice=""
  if keep_existing_config "$cfg" "$review"; then
    return 0
  fi
  if [ ! -f "$cfg" ] && [ -f "$AGENT_STATE/backup/agent-config.yaml" ] && [ "$FRESH" -eq 0 ]; then
    if [ -t 0 ]; then
      say "Aucune configuration active. Une copie existe dans $AGENT_STATE/backup."
      say "  1) Reprendre cette copie"
      say "  2) Créer une configuration neuve"
      read -r -p "Choix [1] : " choice
      if [ "${choice:-1}" != "2" ]; then
        restore_agent_backup "$cfg"
        return 0
      fi
    else
      restore_agent_backup "$cfg"
      return 0
    fi
  fi
  if [ -f "$cfg" ]; then
    backup_file "$AGENT_STATE/backup" "$cfg" "agent-config.yaml"
    say "L'ancienne configuration est copiée dans $AGENT_STATE/backup."
  fi
  write_agent_config "$cfg"
  CONFIG_CHANGED=1
}

ask_field() {
  local label="$1"
  local current="$2"
  local value=""
  if [ ! -t 0 ]; then
    printf '%s' "$current"
    return
  fi
  read -r -p "$label [$current] : " value
  if [ -z "$value" ]; then
    printf '%s' "$current"
  else
    printf '%s' "$value"
  fi
}

apply_text() {
  local file="$1"
  local key="$2"
  local label="$3"
  local root="$4"
  local required="${5:-1}"
  local proposed="${6:-}"
  local current="" next=""
  current="$(yaml_get "$file" "$key" "$root" || true)"
  [ -n "$proposed" ] || proposed="${current:-aucun}"
  while true; do
    next="$(ask_field "$label" "$proposed")"
    if [ "$next" = "aucun" ] && [ -z "$current" ]; then
      if [ "$required" = "0" ]; then
        return
      fi
      say "$label est requis."
      continue
    fi
    if [ "$next" = "retirer" ] && [ "$required" = "0" ]; then
      if [ -n "$current" ]; then
        yaml_edit "$file" "$key" "" "$root" "delete"
        CONFIG_CHANGED=1
      fi
      return
    fi
    if [ -n "$next" ] && [ "$next" != "aucun" ]; then
      break
    fi
    say "$label est requis."
  done
  if [ "$next" != "$current" ]; then
    yaml_edit "$file" "$key" "$next" "$root" "string"
    CONFIG_CHANGED=1
  fi
}

apply_int() {
  local file="$1"
  local key="$2"
  local label="$3"
  local min="$4"
  local max="$5"
  local root="$6"
  local proposed="${7:-}"
  local current="" next=""
  current="$(yaml_get "$file" "$key" "$root" || true)"
  [ -n "$current" ] || current="$min"
  [ -n "$proposed" ] || proposed="$current"
  while true; do
    next="$(ask_field "$label" "$proposed")"
    if [[ "$next" =~ ^[0-9]+$ ]] && [ "$next" -ge "$min" ] && [ "$next" -le "$max" ]; then
      break
    fi
    say "$label attend un entier entre $min et $max."
  done
  if [ "$next" != "$current" ]; then
    yaml_edit "$file" "$key" "$next" "$root" "int"
    CONFIG_CHANGED=1
  fi
}

apply_bool() {
  local file="$1"
  local key="$2"
  local label="$3"
  local root="$4"
  local current="" shown="non" next=""
  current="$(yaml_get "$file" "$key" "$root" || true)"
  [ "$current" = "true" ] && shown="oui"
  while true; do
    next="$(ask_field "$label (oui ou non)" "$shown")"
    case "$next" in
      oui|o|O|true) next="true"; break ;;
      non|n|N|false) next="false"; break ;;
      *) say "Répondez oui ou non." ;;
    esac
  done
  if [ "$next" != "$current" ]; then
    yaml_edit "$file" "$key" "$next" "$root" "bool"
    CONFIG_CHANGED=1
  fi
}

apply_enum() {
  local file="$1"
  local key="$2"
  local label="$3"
  local root="$4"
  shift 4
  local allowed=("$@")
  local current="" next="" item="" shown=""
  current="$(yaml_get "$file" "$key" "$root" || true)"
  shown="$(printf '%s, ' "${allowed[@]}")"
  shown="${shown%, }"
  while true; do
    next="$(ask_field "$label ($shown)" "${current:-${allowed[0]}}")"
    for item in "${allowed[@]}"; do
      if [ "$item" = "$next" ]; then
        break 2
      fi
    done
    say "Valeurs possibles : $shown"
  done
  if [ "$next" != "$current" ]; then
    yaml_edit "$file" "$key" "$next" "$root" "string"
    CONFIG_CHANGED=1
  fi
}

apply_secret() {
  local file="$1"
  local key="$2"
  local label="$3"
  local min="$4"
  local root="$5"
  local confirm_key="${6:-}"
  local choice="" confirm=""
  while true; do
    say "$label. Entrée conserve la valeur. generer en crée une nouvelle. Ou saisissez au moins $min caractères."
    read -r -p "> " choice
    if [ -z "$choice" ]; then
      return
    fi
    if [ "$choice" = "generer" ]; then
      if [ -n "$confirm_key" ]; then
        say "Remplacer cette clé rend les secrets des agents déjà enregistrés illisibles."
        read -r -p "Tapez generer pour confirmer : " confirm
        if [ "$confirm" != "generer" ]; then
          say "Valeur conservée."
          return
        fi
        choice="$(random_key)"
      else
        choice="$(random_hex)"
      fi
      say "Nouvelle valeur, affichée une seule fois : $choice"
    elif [ "${#choice}" -lt "$min" ]; then
      say "Au moins $min caractères."
      continue
    fi
    if [ -n "$confirm_key" ] && ! node -e "const key=Buffer.from(process.argv[1],'base64'); process.exit(key.length===32?0:1)" "$choice"; then
      say "La clé doit être 32 octets en base64."
      continue
    fi
    yaml_edit "$file" "$key" "$choice" "$root" "string"
    CONFIG_CHANGED=1
    return
  done
}

redact_db_url() {
  node - "$1" <<'JS'
try {
  const url = new URL(process.argv[2]);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(url.username);
  process.stdout.write(`${url.protocol}//${user}@${url.hostname}:${url.port || "3306"}/${database}`);
} catch {
  process.stdout.write("en place");
}
JS
}

test_database_url() {
  local parts host port user password database
  parts="$(split_db_url "$1")"
  host="$(printf '%s\n' "$parts" | sed -n '1p')"
  port="$(printf '%s\n' "$parts" | sed -n '2p')"
  user="$(printf '%s\n' "$parts" | sed -n '3p')"
  password="$(printf '%s\n' "$(printf '%s\n' "$parts" | sed -n '4p')" | base64 -d)"
  database="$(printf '%s\n' "$parts" | sed -n '5p')"
  mysql_exec "$host" "$port" "$user" "$password" "$database"
}

apply_database() {
  local file="$1"
  local root="$2"
  local current="" redacted="" choice=""
  current="$(yaml_get "$file" "database.url" "$root")"
  redacted="$(redact_db_url "$current")"
  while true; do
    say "Adresse de la base [$redacted]. Le mot de passe n'est pas affiché."
    say "Entrée la conserve. Une nouvelle valeur est l'URL complète, avec le mot de passe encodé."
    read -r -p "> " choice
    if [ -z "$choice" ]; then
      return
    fi
    if node - "$choice" <<'JS'
const url = new URL(process.argv[2]);
if (!url.hostname || url.pathname.replace(/^\//, "").length === 0) process.exit(1);
JS
    then
      break
    fi
    say "URL invalide."
  done
  if [ "$choice" != "$current" ]; then
    yaml_edit "$file" "database.url" "$choice" "$root" "string"
    CONFIG_CHANGED=1
    DB_REVIEWED=1
  fi
}

apply_read_token() {
  local file="$1"
  local root="$2"
  local state="absent" choice=""
  if yaml_get "$file" "auth.readToken" "$root" >/dev/null; then
    state="en place"
  fi
  while true; do
    say "Jeton de lecture ($state). Entrée conserve. generer en crée un. retirer le supprime. Ou saisissez au moins 16 caractères."
    read -r -p "> " choice
    if [ -z "$choice" ]; then
      return
    fi
    if [ "$choice" = "retirer" ]; then
      yaml_edit "$file" "auth.readToken" "" "$root" "delete"
      CONFIG_CHANGED=1
      say "Jeton de lecture retiré."
      return
    fi
    if [ "$choice" = "generer" ]; then
      choice="$(random_hex)"
      say "Jeton de lecture, affiché une seule fois : $choice"
    elif [ "${#choice}" -lt 16 ]; then
      say "Au moins 16 caractères."
      continue
    fi
    yaml_edit "$file" "auth.readToken" "$choice" "$root" "string"
    CONFIG_CHANGED=1
    return
  done
}

apply_vmid() {
  local file="$1"
  local root="$2"
  local current="" next=""
  current="$(yaml_get "$file" "proxmox.vmid" "$root" || true)"
  while true; do
    next="$(ask_field "VMID" "${current:-aucun}")"
    if [ "$next" = "aucun" ] || [ "$next" = "retirer" ]; then
      if [ -n "$current" ]; then
        yaml_edit "$file" "proxmox.vmid" "" "$root" "delete"
        CONFIG_CHANGED=1
      fi
      return
    fi
    if [[ "$next" =~ ^[0-9]+$ ]] && [ "$next" -ge 1 ] && [ "$next" -le 999999999 ]; then
      break
    fi
    say "VMID entre 1 et 999999999, ou retirer."
  done
  if [ "$next" != "$current" ]; then
    yaml_edit "$file" "proxmox.vmid" "$next" "$root" "int"
    CONFIG_CHANGED=1
  fi
}

review_server_config() {
  local file="$1"
  local root="$SERVER_ROOT"
  local floor=""
  if [ "$BIND_SET" -eq 1 ]; then
    apply_text "$file" "server.bind" "Adresse d'écoute" "$root" 1 "$BIND"
  else
    apply_text "$file" "server.bind" "Adresse d'écoute" "$root"
  fi
  if [ "$PORT_SET" -eq 1 ]; then
    apply_int "$file" "server.port" "Port d'écoute" 1 65535 "$root" "$PORT"
  else
    apply_int "$file" "server.port" "Port d'écoute" 1 65535 "$root"
  fi
  apply_enum "$file" "server.logLevel" "Journal" "$root" debug info warn error
  apply_bool "$file" "server.exposeSwagger" "Documentation OpenAPI" "$root"
  apply_int "$file" "server.bodyLimitBytes" "Taille maximale d'une requête" 1024 5000000 "$root"
  apply_database "$file" "$root"
  say "Les secrets ne sont pas affichés."
  apply_secret "$file" "auth.apiToken" "Jeton d'administration" 16 "$root"
  apply_read_token "$file" "$root"
  apply_secret "$file" "security.credentialsKey" "Clé de chiffrement des agents" 16 "$root" confirm
  apply_int "$file" "security.hmacWindowSeconds" "Fenêtre HMAC, en secondes" 1 86400 "$root"
  apply_int "$file" "security.longPollSeconds" "Attente longue, en secondes" 1 120 "$root"
  apply_int "$file" "security.dispatchLeaseSeconds" "Bail d'exécution, en secondes" 1 86400 "$root"
  apply_int "$file" "agents.unreachableAfterSeconds" "Délai injoignable, en secondes" 1 86399 "$root"
  floor="$(yaml_get "$file" "agents.unreachableAfterSeconds" "$root")"
  apply_int "$file" "agents.offlineAfterSeconds" "Délai hors ligne, en secondes" "$((floor + 1))" 86400 "$root"
  apply_int "$file" "inventory.hideStoppedAfterSeconds" "Masquer les machines arrêtées, en secondes" 1 86400 "$root"
  apply_int "$file" "metrics.retentionDays" "Rétention des métriques, en jours" 1 3650 "$root"
  apply_int "$file" "concurrency.global" "Travaux simultanés" 1 10000 "$root"
  apply_int "$file" "concurrency.perAgent" "Travaux par agent" 1 10000 "$root"
  apply_int "$file" "concurrency.perProxmoxNode" "Travaux par nœud Proxmox" 1 10000 "$root"
  apply_int "$file" "concurrency.aptPerProxmoxNode" "Mises à jour simultanées par nœud" 1 10000 "$root"
  apply_int "$file" "concurrency.perMachineWrite" "Écritures par machine" 1 10000 "$root"
  apply_int "$file" "concurrency.proxmoxHostMaintenancePerCluster" "Maintenance d'hôte par cluster" 1 10000 "$root"
  apply_bool "$file" "ui.enabled" "Interface" "$root"
  if [ -n "$UI_PASSWORD" ]; then
    yaml_edit "$file" "ui.password" "$UI_PASSWORD" "$root" "string"
    CONFIG_CHANGED=1
    say "Mot de passe de l'interface remplacé par la valeur fournie."
  else
    local password=""
    while true; do
      apply_secret "$file" "ui.password" "Mot de passe de l'interface" 12 "$root"
      if [ "$(yaml_get "$file" "ui.enabled" "$root" || true)" != "true" ]; then
        break
      fi
      password="$(yaml_get "$file" "ui.password" "$root" || true)"
      if [ "${#password}" -ge 12 ]; then
        break
      fi
      say "L'interface activée exige un mot de passe d'au moins 12 caractères."
    done
  fi
  apply_int "$file" "ui.sessionHours" "Durée de session, en heures" 1 720 "$root"
  apply_bool "$file" "ui.noCache" "Rechargement de l'interface" "$root"
  apply_int "$file" "scheduler.tickMs" "Intervalle du scheduler, en millisecondes" 200 60000 "$root"
  apply_int "$file" "scheduler.noncePurgeEveryTicks" "Purge des nonces, en tours" 1 1000000 "$root"
  apply_int "$file" "scheduler.metricPurgeEveryTicks" "Purge des métriques, en tours" 1 1000000 "$root"
}

review_agent_config() {
  local file="$1"
  local root="$AGENT_ROOT"
  local current="" next="" agent_type="" total=""
  local host_default=""
  [ -n "$SERVER_HOST" ] && host_default="$SERVER_HOST"
  apply_enum "$file" "server.protocol" "Protocole" "$root" http https
  if [ -n "$host_default" ]; then
    apply_text "$file" "server.host" "Adresse du serveur" "$root" 1 "$host_default"
  else
    apply_text "$file" "server.host" "Adresse du serveur" "$root"
  fi
  if [ "$SERVER_PORT_SET" -eq 1 ]; then
    apply_int "$file" "server.port" "Port du serveur" 1 65535 "$root" "$SERVER_PORT"
  else
    apply_int "$file" "server.port" "Port du serveur" 1 65535 "$root"
  fi
  apply_int "$file" "server.requestTimeoutMs" "Délai d'une requête, en millisecondes" 1000 120000 "$root"
  apply_int "$file" "server.longPollTimeoutMs" "Délai d'attente des travaux, en millisecondes" 5000 180000 "$root"
  say "L'identifiant relie l'agent à sa fiche sur le serveur."
  current="$(yaml_get "$file" "agent.id" "$root")"
  while true; do
    next="$(ask_field "Identifiant" "$current")"
    if [[ "$next" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ ]]; then
      break
    fi
    say "Identifiant invalide."
  done
  if [ "$next" != "$current" ]; then
    yaml_edit "$file" "agent.id" "$next" "$root" "string"
    CONFIG_CHANGED=1
    say "La fiche du serveur doit utiliser le même identifiant."
  fi
  apply_text "$file" "agent.name" "Nom affiché" "$root"
  apply_enum "$file" "agent.type" "Type" "$root" linux-node proxmox-node
  if [ -n "$AGENT_SECRET" ]; then
    yaml_edit "$file" "agent.secret" "$AGENT_SECRET" "$root" "string"
    CONFIG_CHANGED=1
    say "Secret de l'agent remplacé par la valeur fournie."
  else
    apply_secret "$file" "agent.secret" "Secret de l'agent" 16 "$root"
  fi
  apply_text "$file" "agent.version" "Version annoncée" "$root"
  agent_type="$(yaml_get "$file" "agent.type" "$root")"
  if [ "$agent_type" = "proxmox-node" ]; then
    if [ "$(yaml_get "$file" "machine.type" "$root" || true)" != "PHYSICAL" ]; then
      yaml_edit "$file" "machine.type" "PHYSICAL" "$root" "string"
      CONFIG_CHANGED=1
      say "Type de machine fixé à PHYSICAL."
    fi
    if [ "$(yaml_get "$file" "proxmox.enabled" "$root" || true)" != "true" ]; then
      yaml_edit "$file" "proxmox.enabled" "true" "$root" "bool"
      CONFIG_CHANGED=1
      say "Mode Proxmox activé."
    fi
    while true; do
      apply_text "$file" "proxmox.clusterId" "Cluster Proxmox" "$root" 1
      [ -n "$(yaml_get "$file" "proxmox.clusterId" "$root" || true)" ] && break
    done
    apply_vmid "$file" "$root"
  else
    if [ "$(yaml_get "$file" "proxmox.enabled" "$root" || true)" = "true" ]; then
      yaml_edit "$file" "proxmox.enabled" "false" "$root" "bool"
      CONFIG_CHANGED=1
      say "Mode Proxmox coupé pour un agent linux-node."
    fi
    apply_enum "$file" "machine.type" "Type de machine" "$root" VM PHYSICAL
  fi
  apply_text "$file" "machine.displayName" "Nom de la machine" "$root" 0
  apply_int "$file" "intervals.heartbeatSeconds" "Présence, en secondes" 1 86400 "$root"
  apply_int "$file" "intervals.inventorySeconds" "Inventaire, en secondes" 1 86400 "$root"
  apply_int "$file" "intervals.resourcesSeconds" "Ressources, en secondes" 1 86400 "$root"
  apply_int "$file" "concurrency.total" "Travaux simultanés" 1 10000 "$root"
  total="$(yaml_get "$file" "concurrency.total" "$root")"
  apply_int "$file" "concurrency.apt" "Mises à jour simultanées" 1 "$total" "$root"
  apply_enum "$file" "metrics.source" "Source des métriques" "$root" LOCAL_AGENT PROXMOX
  if [ "$(yaml_get "$file" "metrics.source" "$root")" = "PROXMOX" ] && [ "$agent_type" != "proxmox-node" ]; then
    while true; do
      apply_text "$file" "proxmox.clusterId" "Cluster Proxmox" "$root" 1
      [ -n "$(yaml_get "$file" "proxmox.clusterId" "$root" || true)" ] && break
    done
    while true; do
      apply_vmid "$file" "$root"
      [ -n "$(yaml_get "$file" "proxmox.vmid" "$root" || true)" ] && break
      say "Cette source de métriques exige un VMID."
    done
  fi
  apply_enum "$file" "logLevel" "Journal" "$root" debug info warn error
}

configure_server() {
  [ -d "$SERVER_ROOT/node_modules" ] || die "Le serveur n'est pas installé. Lancez --install."
  install_apt
  install_node
  local cfg reviewed=0
  cfg="$(server_config_file)"
  decide_server_config "$cfg" review
  if [ -t 0 ] && [ "$CONFIG_CHANGED" -eq 0 ] && [ -f "$cfg" ]; then
    reviewed=1
    say "Passage en revue. Entrée conserve le réglage affiché."
    review_server_config "$cfg"
  fi
  if [ "$CONFIG_CHANGED" -ne 1 ]; then
    say "Aucun réglage modifié."
    return
  fi
  if [ "$DB_REVIEWED" -eq 1 ]; then
    local url
    url="$(yaml_get "$cfg" "database.url" "$SERVER_ROOT")"
    if ! test_database_url "$url"; then
      say "La base ne répond pas. Le service n'a pas été redémarré."
      return
    fi
    say "La base répond."
  fi
  migrate_database "$SERVER_ROOT" "$cfg"
  if systemctl is-active --quiet "$SERVER_UNIT"; then
    systemctl restart "$SERVER_UNIT"
    say "Service $SERVER_UNIT redémarré."
  else
    say "Service $SERVER_UNIT arrêté. Les réglages seront pris au prochain démarrage."
  fi
  if [ "$reviewed" -eq 0 ]; then
    print_server_secrets "$cfg"
  else
    say "Configuration mise à jour : $cfg"
  fi
}

configure_agent() {
  [ -d "$AGENT_ROOT/node_modules" ] || die "L'agent n'est pas installé. Lancez --install."
  install_apt
  install_node
  local cfg reviewed=0
  cfg="$(agent_config_file)"
  if [ -n "$CONFIG_SOURCE" ]; then
    apply_injected_agent_config "$cfg" "$AGENT_ROOT"
  else
    decide_agent_config "$cfg" review
  fi
  if [ -z "$CONFIG_SOURCE" ] && [ -t 0 ] && [ "$CONFIG_CHANGED" -eq 0 ] && [ -f "$cfg" ]; then
    reviewed=1
    say "Passage en revue. Entrée conserve le réglage affiché."
    review_agent_config "$cfg"
  fi
  if [ "$CONFIG_CHANGED" -ne 1 ]; then
    say "Aucun réglage modifié."
    return
  fi
  say "Configuration : $cfg"
  if [ "$reviewed" -eq 0 ] && [ -n "${SAY_AGENT_SECRET:-}" ]; then
    say "Secret de l'agent, affiché une seule fois : $SAY_AGENT_SECRET"
    say "Enregistrez ce secret dans la fiche de l'agent sur le serveur, puis redémarrez ce service."
  fi
  if systemctl is-active --quiet "$AGENT_UNIT"; then
    systemctl restart "$AGENT_UNIT"
    say "Service $AGENT_UNIT redémarré."
  else
    say "Service $AGENT_UNIT arrêté. Les réglages seront pris au prochain démarrage."
  fi
}

print_server_secrets() {
  local cfg="$1"
  say "Configuration : $cfg"
  if [ -n "${SAY_API_TOKEN:-}" ]; then
    say "Interface : http://${BIND}:${PORT}/ui"
    if [ -n "${SAY_UI_PASSWORD:-}" ]; then
      say "Mot de passe de l'interface, affiché une seule fois : $SAY_UI_PASSWORD"
    fi
    say "Jeton d'administration, affiché une seule fois : $SAY_API_TOKEN"
    say "La clé de chiffrement et l'adresse de la base restent dans le fichier de configuration."
  else
    say "La configuration déjà en place est conservée. Aucun secret n'est réaffiché."
  fi
}

install_server() {
  validate_port "$PORT" "Port"
  install_apt
  install_node
  install_pnpm
  clone_repo "$SERVER_ROOT"
  build_tree "$SERVER_ROOT"
  local cfg
  cfg="$(server_config_file)"
  decide_server_config "$cfg"
  migrate_database "$SERVER_ROOT" "$cfg"
  install_server_unit "$cfg"
  if [ "$CONFIG_CHANGED" -eq 1 ] && systemctl is-active --quiet "$SERVER_UNIT"; then
    systemctl restart "$SERVER_UNIT"
  else
    enable_service "$SERVER_UNIT"
  fi
  print_server_secrets "$cfg"
  say "Mise à jour ultérieure : sudo bash run-infractl.sh --mode server --update"
}

write_agent_config() {
  local file="$1"
  [ -n "$SERVER_HOST" ] || SERVER_HOST="$(prompt "Adresse du serveur InfraCTL")"
  if [ "$SERVER_PORT_SET" -eq 0 ]; then
    SERVER_PORT="$(prompt "Port du serveur" "$SERVER_PORT")"
  fi
  validate_port "$SERVER_PORT" "Port du serveur"
  case "$SERVER_PROTOCOL" in
    http|https) ;;
    *) die "--server-protocol attend http ou https." ;;
  esac
  [ -n "$AGENT_ID" ] || AGENT_ID="$(prompt "Identifiant de l'agent")"
  [[ "$AGENT_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ ]] || die "Identifiant d'agent invalide."
  [ -n "$AGENT_NAME" ] || AGENT_NAME="$(prompt "Nom affiché" "$AGENT_ID")"
  [ -n "$AGENT_TYPE" ] || AGENT_TYPE="$(prompt "Type linux-node ou proxmox-node" "linux-node")"
  case "$AGENT_TYPE" in
    linux-node|proxmox-node) ;;
    *) die "--agent-type attend linux-node ou proxmox-node." ;;
  esac
  if [ -z "$AGENT_SECRET" ]; then
    AGENT_SECRET="$(random_hex)"
    SAY_AGENT_SECRET="$AGENT_SECRET"
  fi
  [ "${#AGENT_SECRET}" -ge 16 ] || die "Le secret de l'agent doit contenir au moins 16 caractères."
  if [ "$AGENT_TYPE" = "proxmox-node" ]; then
    MACHINE_TYPE="PHYSICAL"
    [ -n "$CLUSTER_ID" ] || CLUSTER_ID="$(prompt "Identifiant du cluster Proxmox")"
  else
    [ -n "$MACHINE_TYPE" ] || MACHINE_TYPE="$(prompt "Type de machine VM ou PHYSICAL" "VM")"
    case "$MACHINE_TYPE" in
      VM|PHYSICAL) ;;
      *) die "--machine-type attend VM ou PHYSICAL." ;;
    esac
  fi
  install -d -m 0750 "$AGENT_ETC"
  local proxmox_enabled="false"
  if [ "$AGENT_TYPE" = "proxmox-node" ]; then
    proxmox_enabled="true"
  fi
  node - "$file" "$SERVER_PROTOCOL" "$SERVER_HOST" "$SERVER_PORT" "$AGENT_ID" "$AGENT_NAME" "$AGENT_TYPE" "$AGENT_SECRET" "$MACHINE_TYPE" "$proxmox_enabled" "$CLUSTER_ID" <<'JS'
const fs = require("node:fs");
const [file, protocol, host, port, id, name, type, secret, machineType, proxmoxEnabled, clusterId] = process.argv.slice(2);
const q = (value) => JSON.stringify(String(value));
const lines = [
  "server:",
  `  protocol: ${protocol}`,
  `  host: ${q(host)}`,
  `  port: ${Number(port)}`,
  "  requestTimeoutMs: 30000",
  "  longPollTimeoutMs: 45000",
  "",
  "agent:",
  `  id: ${q(id)}`,
  `  name: ${q(name)}`,
  `  type: ${type}`,
  `  secret: ${q(secret)}`,
  "  version: \"1.0.0\"",
  "",
  "machine:",
  `  type: ${machineType}`,
  `  displayName: ${q(name)}`,
  "",
  "intervals:",
  "  heartbeatSeconds: 10",
  "  inventorySeconds: 30",
  "  resourcesSeconds: 30",
  "",
  "concurrency:",
  "  total: 4",
  "  apt: 2",
  "",
  "metrics:",
  "  source: LOCAL_AGENT",
  "",
  "proxmox:",
  `  enabled: ${proxmoxEnabled}`,
];
if (clusterId) lines.push(`  clusterId: ${q(clusterId)}`);
lines.push("", "logLevel: info", "");
fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 });
JS
  chmod 0600 "$file"
}

validate_agent_config() {
  local file="$1"
  local root="$2"
  local schema="$root/packages/schemas/dist/index.js"
  local pkg="$root/apps/server/package.json"
  [ -f "$schema" ] || die "Schéma agent introuvable. La construction a échoué."
  [ -f "$pkg" ] || die "Le paquet serveur est introuvable dans $root."
  node --input-type=module - "$file" "$pkg" "$schema" <<'JS'
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [file, pkg, schema] = process.argv.slice(2);
const { parse } = createRequire(pkg)("yaml");
const { agentConfigSchema } = await import(pathToFileURL(schema).href);
let doc;
try {
  doc = parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(error instanceof Error ? error.message : "YAML illisible");
  process.exit(1);
}
const result = agentConfigSchema.safeParse(doc);
if (!result.success) {
  for (const issue of result.error.issues) {
    console.error(`${issue.path.join(".") || "fichier"} : ${issue.message}`);
  }
  process.exit(1);
}
JS
}

apply_injected_agent_config() {
  local cfg="$1"
  local root="$2"
  validate_agent_config "$CONFIG_SOURCE" "$root"
  if [ -f "$cfg" ]; then
    backup_file "$AGENT_STATE/backup" "$cfg" "agent-config.yaml"
    say "L'ancienne configuration est copiée dans $AGENT_STATE/backup."
  fi
  install -d -m 0750 "$AGENT_ETC"
  cp "$CONFIG_SOURCE" "$cfg"
  chmod 0600 "$cfg"
  CONFIG_CHANGED=1
  say "Configuration injectée : $cfg"
}

install_agent() {
  install_apt
  install_node
  install_pnpm
  clone_repo "$AGENT_ROOT"
  build_tree "$AGENT_ROOT"
  local cfg
  cfg="$(agent_config_file)"
  if [ -n "$CONFIG_SOURCE" ]; then
    apply_injected_agent_config "$cfg" "$AGENT_ROOT"
  else
    decide_agent_config "$cfg"
  fi
  install_agent_unit
  say "Configuration : $cfg"
  say "L'agent n'ouvre aucun port. Il joint le serveur indiqué dans sa configuration."
  if [ -n "${SAY_AGENT_SECRET:-}" ]; then
    say "Secret de l'agent, affiché une seule fois : $SAY_AGENT_SECRET"
    say "Enregistrez ce secret dans la fiche de l'agent sur le serveur, puis redémarrez ce service."
  fi
  if [ "$CONFIG_CHANGED" -eq 1 ] && systemctl is-active --quiet "$AGENT_UNIT"; then
    systemctl restart "$AGENT_UNIT"
  else
    enable_service "$AGENT_UNIT"
  fi
  say "Mise à jour ultérieure : sudo bash run-infractl.sh --mode agent --update"
}

update_mode() {
  install_apt
  install_node
  install_pnpm
  local dest
  dest="$(root_dir)"
  update_repo "$dest"
  build_tree "$dest"
  if [ "$MODE" = "server" ]; then
    local cfg
    cfg="$(server_config_file)"
    [ -f "$cfg" ] || die "Configuration introuvable : $cfg"
    ensure_local_database
    migrate_database "$dest" "$cfg"
  fi
  local name
  name="$(unit_name)"
  systemctl daemon-reload
  if systemctl is-active --quiet "$name"; then
    systemctl restart "$name"
    say "Service $name redémarré."
  else
    say "Service $name arrêté. Le code est à jour, la configuration est inchangée."
  fi
}

change_password() {
  [ "$MODE" = "server" ] || die "--change-password concerne le serveur."
  local cfg password
  cfg="$(server_config_file)"
  [ -f "$cfg" ] || die "Configuration introuvable : $cfg"
  if [ -n "$UI_PASSWORD" ]; then
    password="$UI_PASSWORD"
    [ "${#password}" -ge 12 ] || die "Le mot de passe de l'interface doit contenir au moins 12 caractères."
  else
    password="$(prompt_secret "Nouveau mot de passe de l'interface" 12)"
  fi
  yaml_edit "$cfg" "ui.password" "$password" "$SERVER_ROOT" "string"
  if systemctl is-active --quiet "$SERVER_UNIT"; then
    systemctl restart "$SERVER_UNIT"
  fi
  say "Mot de passe de l'interface enregistré. La clé de chiffrement n'a pas changé."
}

set_ui() {
  [ "$MODE" = "server" ] || die "--ui concerne le serveur."
  local cfg
  cfg="$(server_config_file)"
  [ -f "$cfg" ] || die "Configuration introuvable : $cfg"
  case "$UI_STATE" in
    enable)
      local current=""
      current="$(yaml_get "$cfg" "ui.password" "$SERVER_ROOT" || true)"
      [ "${#current}" -ge 12 ] || die "Définissez d'abord un mot de passe : --change-password"
      yaml_edit "$cfg" "ui.enabled" "true" "$SERVER_ROOT"
      say "Interface activée."
      ;;
    disable)
      yaml_edit "$cfg" "ui.enabled" "false" "$SERVER_ROOT"
      say "Interface coupée. L'API et les agents continuent."
      ;;
    *)
      die "--ui attend enable ou disable."
      ;;
  esac
  if systemctl is-active --quiet "$SERVER_UNIT"; then
    systemctl restart "$SERVER_UNIT"
  fi
}

service_mode() {
  local name
  name="$(unit_name)"
  case "$SERVICE_CMD" in
    start|stop|restart)
      systemctl "$SERVICE_CMD" "$name"
      ;;
    status)
      systemctl --no-pager --full status "$name" || true
      ;;
    *)
      die "--service attend start, stop, restart ou status."
      ;;
  esac
}

status_mode() {
  local name
  name="$(unit_name)"
  say "Service : $name"
  systemctl is-active "$name" || true
  if [ "$MODE" = "server" ]; then
    local cfg
    cfg="$(server_config_file)"
    if [ -f "$cfg" ] && [ -f "$SERVER_ROOT/apps/server/package.json" ] && [ -d "$SERVER_ROOT/node_modules" ]; then
      local info bind port enabled
      info="$(
        node --input-type=module - "$cfg" "$SERVER_ROOT/apps/server/package.json" <<'JS'
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const [file, pkg] = process.argv.slice(2);
const { parse } = createRequire(pkg)("yaml");
const doc = parse(readFileSync(file, "utf8"));
process.stdout.write([doc.server?.bind ?? "", doc.server?.port ?? "", doc.ui?.enabled ? "oui" : "non"].join("\n"));
JS
      )"
      bind="$(printf '%s\n' "$info" | sed -n '1p')"
      port="$(printf '%s\n' "$info" | sed -n '2p')"
      enabled="$(printf '%s\n' "$info" | sed -n '3p')"
      say "Écoute : ${bind}:${port}"
      say "Interface : $enabled"
      say "Adresse : http://${bind}:${port}/ui"
      say "Configuration : $cfg"
    else
      say "Configuration : $cfg"
    fi
  else
    say "Configuration : $(agent_config_file)"
  fi
}

uninstall_mode() {
  local name dest
  name="$(unit_name)"
  dest="$(root_dir)"
  confirm "Retirer $name et le code dans $dest ?"
  if [ "$MODE" = "server" ]; then
    local cfg
    cfg="$(server_config_file)"
    backup_file "$SERVER_STATE/backup" "$cfg" "config.yaml"
    if [ -f "$(dirname "$cfg")/agent-settings.json" ]; then
      backup_file "$SERVER_STATE/backup" "$(dirname "$cfg")/agent-settings.json" "agent-settings.json"
    fi
  else
    backup_file "$AGENT_STATE/backup" "$(agent_config_file)" "agent-config.yaml"
  fi
  systemctl disable --now "$name" || true
  rm -f "/etc/systemd/system/${name}.service"
  systemctl daemon-reload
  if [ -d "$dest" ]; then
    refuse_broad_delete "$dest"
    rm -rf "$dest"
  fi
  if [ "$PURGE" -eq 1 ]; then
    confirm "Effacer aussi la configuration locale ?"
    if [ "$MODE" = "server" ]; then
      if [ -f "$SERVER_STATE/compose.yml" ]; then
        install_docker || true
        docker_compose -f "$SERVER_STATE/compose.yml" down -v || true
      fi
      refuse_broad_delete "$SERVER_ETC"
      refuse_broad_delete "$SERVER_STATE"
      rm -rf "$SERVER_ETC" "$SERVER_STATE"
      say "Configuration locale et instance Docker de ce script retirées."
      say "Une base MariaDB située sur une autre machine n'a pas été modifiée."
    else
      refuse_broad_delete "$AGENT_ETC"
      refuse_broad_delete "$AGENT_STATE"
      rm -rf "$AGENT_ETC" "$AGENT_STATE"
      say "Configuration de l'agent retirée."
    fi
  else
    say "Code retiré. La configuration est conservée."
    if [ "$MODE" = "server" ]; then
      say "Copie de sûreté : $SERVER_STATE/backup"
    else
      say "Configuration : $AGENT_ETC/config.yaml"
    fi
  fi
}

main() {
  parse_args "$@"
  if [ "$ACTION" = "help" ] || [ -z "$ACTION" ]; then
    usage
    exit 0
  fi
  materialize_config
  need_root "$@"
  export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  hash -r || true
  command -v systemctl >/dev/null 2>&1 || die "systemd est requis."
  need_mode
  case "$ACTION" in
    install)
      if [ "$MODE" = "server" ]; then install_server; else install_agent; fi
      ;;
    configure)
      if [ "$MODE" = "server" ]; then configure_server; else configure_agent; fi
      ;;
    update) update_mode ;;
    uninstall) uninstall_mode ;;
    change-password) change_password ;;
    ui) set_ui ;;
    service) service_mode ;;
    status) status_mode ;;
    *) die "Action inconnue." ;;
  esac
}

main "$@"
