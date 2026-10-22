# Contexte du projet

Infra Manager est un moteur de supervision légère et de maintenance contrôlée pour des nœuds Proxmox VE, des conteneurs LXC Debian, des VM Debian et des serveurs Debian physiques. Ce n'est pas un outil d'administration distante générique.

Le serveur demande une action par son nom. L'agent, sur la machine, décide comment l'exécuter. Le serveur ne transmet jamais une chaîne shell.

Ce fichier est le résumé stable du dépôt. Le détail d'usage est dans [docs/README.md](README.md). L'installation est dans le [README](../README.md) à la racine.

## État actuel

Version de socle, avec une interface interne en plus de l'API.

Présent et exécutable :

- monorepo pnpm (`apps/*`, `packages/*`) ;
- serveur Fastify, API `/api/v1`, MariaDB ou MySQL via Prisma ;
- agent `linux-node` sous systemd, connexions uniquement sortantes ;
- authentification HMAC des agents, jetons Bearer pour l'API de gestion ;
- heartbeat, inventaire, métriques locales, long polling, file de jobs persistée ;
- actions activées : `system.info` et `apt.check` ;
- journaux, audit `executable` + `arguments`, concurrence, jobs parents.

Présent dans le modèle, non exécuté :

- mode `proxmox-node` : l'agent refuse de démarrer dans ce mode ;
- `apt.upgrade`, systemd, journald, redémarrage, maintenance d'hôte Proxmox : noms du catalogue, réponse `422` / `ACTION_DISABLED` ;
- fusion d'inventaire Proxmox, identité `clusterId` + `vmid`, guests `UNKNOWN` si le nœud est offline : logique serveur testée, sans commandes `pct`.

L'interface humaine est sur `/ui`. Elle est protégée par `ui.password` dans la configuration du serveur, pas par un compte. Le jeton Bearer reste le moyen d'appel pour une page PHP. `GET /docs` est la documentation OpenAPI quand `exposeSwagger` vaut `true`. Le guide PHP est [php.md](php.md), l'interface est décrite dans [interface.md](interface.md).

## Invariants

Ces règles priment sur une fonctionnalité plus simple.

1. Pas de shell arbitraire. Interdit : champ `command`, `exec`, `execSync`, `spawn("bash", ["-c", ...])`, concaténation d'une commande, option `shell: true`. `node:child_process` n'est importé que par `apps/agent/src/process/spawn-runner.ts`, avec `shell: false`.
2. L'agent n'écoute aucun port. Le serveur ne se connecte jamais à un agent. Les jobs partent par `GET /api/v1/agent/jobs/next`.
3. Toute entrée est validée par Zod. Une action inconnue n'est pas exécutée. Les VMID sont des entiers. Les noms d'unités systemd passent par le schéma dédié.
4. Une action mutante est exclusive sur une machine. Un job `UNKNOWN` ou `INTERRUPTED` sur une action mutante n'est jamais relancé. L'acquittement ne le remet pas en file.
5. L'état vivant est revérifié juste avant l'exécution. Un état ancien en base ne suffit pas.
6. Aucun secret dans les logs : jeton d'API, secret HMAC, en-tête `Authorization`, mots de passe. Le secret agent est chiffré en base et absent des réponses.
7. Les agents ne s'inscrivent pas eux-mêmes. Un administrateur les enregistre avec `pnpm agent:register` ou `POST /api/v1/agents`. Le secret est fourni à la création et n'est jamais renvoyé.
8. Pas d'agent dans les LXC. Les actions LXC passeront par `pct exec` depuis l'hôte Proxmox, jamais par SSH ni `pct enter`.
9. L'identité stable d'un guest est `clusterId` + `vmid`. Le nœud courant est dynamique. Un job `QUEUED` suit la migration ; un job déjà `RUNNING` reste sur l'agent qui l'a commencé.
10. Un nœud Proxmox offline ne marque pas ses guests `STOPPED`. Ils passent à `UNKNOWN`, avec une alerte groupée. Aucun job n'est envoyé vers ces guests.

Priorités : sécurité, prévisibilité des actions, robustesse, faible consommation, simplicité d'exploitation, observabilité, performances, ergonomie.

## Dépôt

```text
apps/server          Fastify, Prisma, scheduler, API
apps/agent           agent linux-node, actions, adapters, process runner
packages/types       catalogue d'actions, états, codes d'erreur
packages/schemas     Zod partagé serveur / agent
packages/protocol    HMAC
packages/utils       logs JSON, rédaction, pagination, backoff
apps/server/prisma   schéma et migration initiale
docs                 usage de l'API, dont PHP
```

Les identifiants d'agents sont des slugs choisis par l'opérateur (`edge-01`, `pve01`). Machines, jobs et clusters sont des UUID. Les VMID Proxmox restent des entiers et ne servent pas de clé primaire.

Le scheduler est mono-instance : verrou en mémoire du processus. Un second processus serveur ne coordonne pas la file.

Configuration YAML validée au démarrage. `DATABASE_URL` peut surcharger l'URL du YAML. `CONFIG_PATH` choisit le fichier. Une configuration invalide arrête le processus.

Commandes : `pnpm install`, `docker compose up -d`, `pnpm prisma:migrate`, `pnpm dev`, `pnpm dev:agent`, `pnpm test`. MariaDB 11 est dans `docker-compose.yml`. Le serveur Node tourne sur l'hôte. Les tests ne lancent ni `apt-get` ni `pct` : ils passent par `FakeProcessRunner` et `MemoryStore`.

## Authentification

Deux secrets distincts.

L'API de gestion utilise `Authorization: Bearer`. `auth.apiToken` est l'administrateur. `auth.readToken`, optionnel, lit et ne lance que les actions `READ`. `GET /api/v1/health` est public. Il n'y a pas de compte ni de mot de passe.

L'agent signe `POST` et `GET` sous `/api/v1/agent/` en HMAC-SHA256. En-têtes : `X-Agent-ID`, `X-Timestamp` (13 chiffres, millisecondes), `X-Nonce`, `X-Signature`. Chaîne canonique `INFRACTL-HMAC-V1`, méthode, chemin, query, timestamp, nonce, SHA-256 du corps, saut de ligne final. Fenêtre par défaut 60 secondes. Nonce à usage unique. Le passage ultérieur à HTTPS ne change pas cette signature : seul `server.protocol` de l'agent change.

## Jobs

États : `QUEUED`, `ASSIGNED`, `RUNNING`, `SUCCESS`, `FAILED`, `SKIPPED`, `INTERRUPTED`, `UNKNOWN`, `CANCELLED`, `REQUIRES_CONFIRMATION`.

`QUEUED` peut devenir `ASSIGNED`, `CANCELLED`, `SKIPPED` ou `FAILED`. `ASSIGNED` peut revenir à `QUEUED` si l'agent ne prend pas le job. `RUNNING` se termine. `REQUIRES_CONFIRMATION` ne revient qu'en `CANCELLED`. Les autres états finaux ne bougent plus.

Un sélecteur `machine` crée un job feuille. `machines`, `fleet`, `cluster` et `proxmox-node` créent un parent et un enfant par cible résolue à la création du lot. L'agent d'un LXC est choisi à l'assignation, via le nœud courant.

Un agent `OFFLINE` produit `SKIPPED` / `SKIPPED_OFFLINE`. Un agent `UNREACHABLE` laisse le job en attente. `RUNNING` plus agent perdu, ou délai dépassé, devient `UNKNOWN`. Rien n'est réexécuté.

`apt.check` est une lecture. Elle compte dans le plafond APT, elle ne modifie pas la machine. Une simulation qui retire des paquets met `requiresConfirmation` sur le snapshot. L'upgrade réel n'est pas implémenté.

## Agent linux-node

Configuration locale, par exemple `apps/agent/config.example.yaml` ou `/etc/infra-agent/config.yaml`. Le secret du fichier est celui choisi à l'enregistrement, en ligne de commande ou par l'API.

`apt.check` exige root dans cette version. Le unit `apps/agent/deploy/infra-agent.service` le dit. La séparation futur daemon non privilégié / helper privilégié n'existe pas encore.

`metrics.source: LOCAL_AGENT` envoie CPU, mémoire, disque et réseau. `PROXMOX` coupe cette collecte : les chiffres devront venir de l'hôte Proxmox.

Boucles indépendantes : heartbeat, inventaire, ressources, long polling, workers. Reconnexion avec backoff 1 s, 2 s, 5 s, 10 s, 30 s et un peu de jitter. Pas de polling toutes les secondes.

## Hors périmètre tant que le socle n'est pas étendu

Ne pas implémenter `pct` tant que le mode `proxmox-node` n'est pas le sujet. Ne pas activer `apt.upgrade` sans simulation, confirmation des suppressions, et interdiction de relance après `UNKNOWN`.
