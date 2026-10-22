# Infra Manager

Moteur de supervision légère et de maintenance contrôlée pour des nœuds Proxmox VE, des conteneurs LXC, des VM Debian et des serveurs Debian physiques.

Le serveur demande une **action nommée**. L'agent décide comment l'exécuter. Le serveur ne transmet jamais une commande shell.

## Ce que cette version fait

- monorepo pnpm, serveur Fastify, agent `linux-node`
- MariaDB ou MySQL via Prisma
- authentification HMAC des agents, protection contre le rejeu
- heartbeat, long polling, file de jobs persistée
- actions activées : `system.info` et `apt.check`
- journaux stdout / stderr / system, audit `executable` + `arguments`
- concurrence, mutex d'écriture, jobs parents
- service systemd pour l'agent

Le mode `proxmox-node` est refusé au démarrage de l'agent : les commandes `pct` ne sont pas encore branchées. Le serveur sait déjà fusionner un inventaire Proxmox, suivre `clusterId + vmid` à travers une migration, et marquer les guests `UNKNOWN` quand le nœud est offline.

## Sécurité

Interdit dans tout le code :

- `exec`, `execSync`, `bash -c`, `sh -c`
- une option `shell: true`
- un champ `command` dans l'API ou dans le job envoyé à l'agent

`SpawnProcessRunner` appelle `spawn(executable, args, { shell: false })`. Seul ce fichier importe `node:child_process`. Les arguments viennent de tableaux fixes ou d'entiers validés, jamais d'une chaîne concaténée.

Les agents n'écoutent aucun port. Le serveur ne se connecte jamais à un agent. Le long polling est un `GET /api/v1/agent/jobs/next` tenu environ 30 secondes.

Un job `UNKNOWN` ou `INTERRUPTED` sur une action mutante n'est jamais relancé. Il bloque les écritures suivantes sur la machine tant qu'un administrateur ne l'a pas acquitté. L'acquittement ne relance pas le job.

### HMAC

Chaque requête agent porte :

```text
X-Agent-ID
X-Timestamp      millisecondes Unix, 13 chiffres
X-Nonce          16 à 128 caractères [A-Za-z0-9_-]
X-Signature      HMAC-SHA256 hexadécimal minuscule
```

Chaîne canonique, avec un saut de ligne final :

```text
INFRACTL-HMAC-V1
METHOD
PATHNAME
QUERY
TIMESTAMP
NONCE
SHA256(body)
```

`QUERY` est vide si l'URL n'a pas de query string. Un corps vide est hashé tel quel. La fenêtre par défaut est de 60 secondes, dans les deux sens. Un nonce déjà vu est refusé. Le secret est chiffré dans `AgentCredential` et n'est jamais renvoyé par l'API ni écrit dans les logs.

Le protocole applicatif ne dépend pas de TLS. Passer à `https` se fait dans la configuration de l'agent (`server.protocol`) sans changer les signatures.

### États d'un job

```text
QUEUED -> ASSIGNED -> RUNNING -> SUCCESS
                              -> FAILED
                              -> SKIPPED
                              -> INTERRUPTED
                              -> UNKNOWN
                              -> REQUIRES_CONFIRMATION
QUEUED -> CANCELLED | SKIPPED | FAILED
ASSIGNED -> QUEUED | CANCELLED | SKIPPED | FAILED
```

`UNKNOWN`, `INTERRUPTED`, `SUCCESS`, `FAILED`, `SKIPPED` et `CANCELLED` sont terminaux. `REQUIRES_CONFIRMATION` ne revient pas en file.

Le scheduler assigne un job seulement si l'agent est `ONLINE`, si les verrous sont libres et si les plafonds de concurrence le permettent. Un agent `UNREACHABLE` fait attendre le job. Un agent `OFFLINE` produit `SKIPPED` / `SKIPPED_OFFLINE`, ce qui ne fait pas échouer un lot.

Si l'agent disparaît pendant `RUNNING`, le job passe en `UNKNOWN` avec `AGENT_LOST`. Un dépassement de délai sans résultat passe aussi en `UNKNOWN`. Rien n'est réexécuté.

### Concurrence

Les jobs `ASSIGNED` et `RUNNING` consomment un slot.

- une action mutante est exclusive sur la machine, y compris vis-à-vis des lectures
- une lecture attend qu'aucune action mutante ne soit active sur la machine
- `aptPerProxmoxNode` limite les actions APT exécutées sur un même nœud
- `proxmoxHostMaintenancePerCluster` limite la maintenance lourde d'hôte à un nœud du cluster
- un job en tête de file qui attend un verrou ne bloque pas les autres machines

L'attribution d'un LXC se fait au moment de l'assignation : `clusterId + vmid` donne le nœud courant, puis l'agent de ce nœud. Un job déjà `RUNNING` n'est pas déplacé si le guest migre.

## Prérequis

- Node.js 20 ou plus récent
- pnpm 9 (fourni par le dépôt via `packageManager`)
- Docker, pour MariaDB de développement

Si la commande `pnpm` est absente, l'activer avec Corepack, livré avec Node.js :

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
```

`corepack pnpm` fonctionne aussi sans activation globale.

## Démarrage

```bash
pnpm install
docker compose up -d
copy .env.example apps\server\.env
copy config.example.yaml config.yaml
pnpm prisma:migrate
pnpm agent:register -- --id edge-01 --name edge-01 --type linux-node --secret "un-secret-d-au-moins-16"
pnpm dev
```

Sous un shell Unix, remplacer `copy` par `cp`.

`pnpm prisma:migrate` applique les migrations déjà versionnées (`prisma migrate deploy`). La base de développement est MariaDB 11, base `infra_manager`, utilisateur `infra`, mot de passe `infra_dev_password`.

Le serveur écoute sur `0.0.0.0:8080`. L'interface de gestion est sur `http://127.0.0.1:8080/ui`, avec le mot de passe `ui.password`. La documentation OpenAPI est sur `http://127.0.0.1:8080/docs` tant que `exposeSwagger` vaut `true`.

Générer une clé de chiffrement des secrets :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

La placer dans `security.credentialsKey`. La valeur du fichier d'exemple est publique et ne doit pas sortir d'un poste de développement.

`DATABASE_URL`, si elle est définie, remplace l'URL du fichier YAML.

## Agent linux-node

Cette version doit tourner en **root**. `apt-get` et la lecture de certains états système l'exigent. Le fichier systemd le dit explicitement. Une séparation future entre un daemon non privilégié et un helper privilégié est prévue ; elle n'est pas en place.

```bash
cp apps/agent/config.example.yaml apps/agent/config.yaml
pnpm dev:agent
```

Installation cible :

```text
/opt/infra-agent/
/etc/infra-agent/config.yaml
/etc/systemd/system/infra-agent.service
```

Sur la machine Debian, après un build :

```bash
sudo sh apps/agent/deploy/install.sh
sudo systemctl enable --now infra-agent
```

L'agent ouvre une connexion sortante vers `protocol://host:port`. Il ne publie aucun port. En cas de coupure il reprend avec un délai de 1 s, 2 s, 5 s, 10 s puis 30 s, plus un jitter de 20 %.

`metrics.source: PROXMOX` désactive l'envoi périodique CPU / RAM / réseau par l'agent. L'association stable d'une VM est `proxmox.clusterId` + `proxmox.vmid`, pas le nom du nœud.

## API de gestion

Toutes les routes sauf `GET /api/v1/health` exigent `Authorization: Bearer <apiToken>`. Le jeton lecteur peut consulter et demander des actions `READ`. Les actions `WRITE` et `CRITICAL`, l'annulation et l'acquittement exigent le jeton administrateur.

```bash
curl -s -H "Authorization: Bearer dev-admin-token-change" ^
  -H "Content-Type: application/json" ^
  -d "{\"action\":\"apt.check\",\"selector\":{\"type\":\"fleet\"}}" ^
  http://127.0.0.1:8080/api/v1/actions
```

Les listes acceptent `page` et `limit` (50 par défaut, 100 au maximum).

Un job `RUNNING` ne peut pas être annulé à distance : l'agent n'écoute pas. `POST /api/v1/jobs/:id/acknowledge` enregistre qu'un opérateur a vu un état `UNKNOWN`, `INTERRUPTED` ou `REQUIRES_CONFIRMATION`. Le statut ne change pas et le job n'est pas relancé.

## Actions

| Action | Catégorie | État |
| --- | --- | --- |
| `system.info` | READ | active |
| `apt.check` | READ | active, simulation `apt-get -s` |
| `apt.upgrade` | WRITE | active sur hôte, LXC, VM et machine physique ; simulation, puis installation seulement s'il n'y a pas de suppression |
| `apt.refresh` | WRITE | enregistrée, désactivée |
| systemd, journal, Proxmox, LXC | READ ou WRITE | enregistrées, désactivées |
| `system.reboot`, `system.shutdown`, `proxmox.host.update` | CRITICAL | enregistrées, désactivées |

`apt.check` ne modifie pas le système. `apt.upgrade` refait cette simulation, puis lance `apt-get upgrade` avec des arguments fixes. S'il faut supprimer un paquet, il s'arrête en `REQUIRES_CONFIRMATION` sans rien installer. Deux actions mutantes ne peuvent pas viser la même machine en même temps. Un `apt.upgrade` dont le résultat est `UNKNOWN` ne sera pas relancé automatiquement. L'interface propose le bouton sur un hôte, un LXC, une VM et une machine physique. L'agent linux applique l'installation sur la machine où il tourne. Un LXC sera exécuté par l'agent de son nœud Proxmox lorsque ce mode existera.

## Vérifications

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Les tests ne lancent ni `apt-get` ni `pct`. Ils passent par `FakeProcessRunner`.

## Suite prévue

1. Mode `proxmox-node`, `pct list`, `pct exec`, métriques Proxmox, guests `UNKNOWN`.
2. systemd, journald, lots sur tout le parc, alertes d'exploitation, maintenance d'hôte sérialisée dans le cluster.

L'interface de gestion est sur `/ui` et se déverrouille avec le mot de passe de `config.yaml`. Le résumé du projet est dans [docs/context.md](docs/context.md). L'usage depuis une page PHP, l'authentification par jeton et la forme des réponses sont décrits dans [docs/README.md](docs/README.md).
