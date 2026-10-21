# API de gestion

Base : `http://127.0.0.1:8080`. Toutes les routes ci-dessous, sauf la santé, exigent `Authorization: Bearer`.

Les listes acceptent `page` (défaut 1) et `limit` (défaut 50, maximum 100).

```json
{
  "data": [],
  "pagination": { "page": 1, "limit": 50, "total": 0, "pages": 1 }
}
```

Les dates sont des chaînes ISO 8601 en UTC. Une erreur a toujours la forme `{ "error": { "code": "...", "message": "..." } }`. Le code HTTP suit le code métier : `400` validation, `401` jeton, `403` droits, `404` inconnu, `409` conflit, `422` action refusée.

## Santé

`GET /api/v1/health` est public.

```json
{
  "status": "ok",
  "database": "ok",
  "agents": { "online": 1, "unreachable": 0, "offline": 0 },
  "jobs": { "queued": 0, "running": 0 }
}
```

`status` vaut `degraded` et `database` vaut `error` si MariaDB ne répond pas. Les compteurs de jobs ne comptent que les jobs feuilles.

## Agents

`GET /api/v1/agents`

`GET /api/v1/agents/{id}`

Champs utiles à l'affichage : `id`, `name`, `type`, `version`, `presence` (`ONLINE`, `UNREACHABLE`, `OFFLINE`), `lastSeenAt`, `capabilities`, `reportedRunning`, `reportedQueued`, `reportedCapacity`. Le secret n'est pas dans la réponse.

`ONLINE` signifie un heartbeat récent. `UNREACHABLE` puis `OFFLINE` suivent `agents.unreachableAfterSeconds` (30) et `agents.offlineAfterSeconds` (60). Seul un agent `ONLINE` reçoit un nouveau job.

## Machines

`GET /api/v1/machines`

Filtres optionnels : `type` (`PROXMOX_NODE`, `LXC`, `VM`, `PHYSICAL`), `status` (`RUNNING`, `STOPPED`, `UNKNOWN`, `OFFLINE`), `clusterId`, `includeHidden` (`true` ou `false`).

`GET /api/v1/machines/{id}`

Champs utiles : `hostname`, `displayName`, `type`, `status`, `metricsSource`, `agentId`, `lastSeenAt`, `hiddenAt`.

`GET /api/v1/machines/{id}/resources?page=1&limit=50`

```json
{
  "current": {
    "timestamp": "2026-10-21T18:00:00.000Z",
    "cpuUsage": 12.5,
    "memoryUsed": 524288000,
    "memoryTotal": 2147483648,
    "diskUsed": null,
    "diskTotal": null,
    "networkRx": 1000,
    "networkTx": 2000,
    "uptime": 3600
  },
  "history": { "data": [], "pagination": { "page": 1, "limit": 50, "total": 0, "pages": 1 } }
}
```

`cpuUsage` est un pourcentage de 0 à 100 sur l'ensemble des cœurs. Mémoire et disque sont en octets. `networkRx` et `networkTx` sont des compteurs d'octets cumulés, interface `lo` exclue. `current` vaut `null` tant qu'aucun point n'a été reçu. L'historique est le plus récent d'abord. La rétention par défaut est de 7 jours.

`GET /api/v1/machines/{id}/updates`

Derniers snapshots APT, du plus récent au plus ancien. Un snapshot n'existe qu'après un `apt.check` terminé avec succès.

```json
{
  "availableCount": 2,
  "securityCount": 1,
  "requiresReboot": false,
  "requiresConfirmation": false,
  "packages": [
    {
      "name": "bash",
      "currentVersion": "5.2.15-2",
      "newVersion": "5.2.15-2+deb12u1",
      "architecture": "amd64",
      "changeType": "upgrade",
      "security": true
    }
  ]
}
```

`changeType` vaut `upgrade`, `install` ou `remove`. `requiresConfirmation` vaut `true` si la simulation annonce une suppression de paquet.

`GET /api/v1/machines/{id}/jobs` accepte les mêmes filtres que la liste des jobs.

## Clusters et nœuds

`GET /api/v1/clusters`, `GET /api/v1/clusters/{id}`, `GET /api/v1/nodes`, `GET /api/v1/nodes/{id}`.

Ces listes se remplissent quand un agent Proxmox remonte un inventaire. Avec uniquement des agents `linux-node`, elles restent vides. Ce n'est pas une erreur.

## Jobs

`GET /api/v1/jobs`

Filtres : `status`, `machineId`, `parentId`.

`GET /api/v1/jobs/{id}`

`GET /api/v1/jobs/{id}/logs?page=1&limit=50`

Chaque ligne a `sequence`, `timestamp`, `stream` (`STDOUT`, `STDERR`, `SYSTEM`) et `data`. Afficher les lignes dans l'ordre de `sequence`.

Champs d'un job à montrer :

| Champ | Lecture |
| --- | --- |
| `action`, `category`, `status` | Ce qui a été demandé et où cela en est |
| `executionKind` | `LEAF` pour une machine, `PARENT` pour un lot |
| `machineId`, `agentId` | Cible et agent choisi au moment de l'assignation |
| `requestedBy` | Texte libre envoyé par l'appelant |
| `createdAt`, `startedAt`, `finishedAt`, `durationMs`, `exitCode` | Chronologie |
| `resolvedExecutable`, `resolvedArguments` | Programme réellement lancé, arguments séparés |
| `result` | Objet propre à l'action, ou `null` |
| `errorCode`, `errorMessage` | Raison d'un échec, d'un saut ou d'un état inconnu |
| `parentId` | Job de lot, s'il y en a un |

Pour un lot, le parent porte dans `result.counts` le nombre d'enfants par état, par exemple `{ "SUCCESS": 3, "SKIPPED": 1 }`. Les enfants se lisent avec `GET /api/v1/jobs?parentId={id}`.

`result` de `system.info` :

```json
{
  "hostname": "edge-01",
  "kernel": "6.1.0",
  "arch": "x64",
  "platform": "linux",
  "uptimeSeconds": 3600,
  "os": { "id": "debian", "prettyName": "Debian GNU/Linux 12 (bookworm)" },
  "cpu": { "model": "QEMU Virtual CPU", "cores": 2 },
  "memory": { "totalBytes": 2147483648, "freeBytes": 1073741824 },
  "rebootRequired": false,
  "agentVersion": "1.0.0"
}
```

`result` de `apt.check` reprend `availableCount`, `securityCount`, `requiresReboot`, `requiresConfirmation` et `packages`. Le snapshot de `GET /machines/{id}/updates` est la copie durable de ce résultat.

## Lancer une action

`POST /api/v1/actions`

```json
{
  "action": "system.info",
  "requestedBy": "php-admin",
  "selector": { "type": "machine", "id": "8d0b6a2e-1c3a-4f0e-9b1a-6e5d4c3b2a10" }
}
```

Sélecteurs acceptés :

```json
{ "type": "machine", "id": "uuid" }
{ "type": "machines", "ids": ["uuid-1", "uuid-2"] }
{ "type": "fleet" }
{ "type": "cluster", "id": "uuid-ou-slug", "includeGuests": true }
{ "type": "proxmox-node", "id": "pve01", "includeGuests": true }
```

`parameters` est optionnel et réservé aux futures actions systemd et journal : `unit` et `lines`. Il n'est pas utilisé par `system.info` ni `apt.check`.

La réponse est le job créé, encore `QUEUED`. Elle ne contient pas le résultat. Il faut relire le job.

`POST /api/v1/jobs/{id}/cancel` annule un job qui n'est pas encore `RUNNING`. Un job déjà en cours répond `409` : il n'existe pas de canal pour l'arrêter à distance.

`POST /api/v1/jobs/{id}/acknowledge` est réservé à l'administrateur. Il marque un job `UNKNOWN`, `INTERRUPTED` ou `REQUIRES_CONFIRMATION` comme vu. Le statut ne change pas et le job n'est pas relancé. Tant qu'un job mutant n'est pas acquitté, une nouvelle écriture sur la même machine attend.

## Alertes

`GET /api/v1/alerts`

Par défaut, seules les alertes ouvertes sont renvoyées. `openOnly=false` inclut les alertes résolues. Champs : `severity` (`INFO`, `WARNING`, `CRITICAL`), `title`, `message`, `machineId`, `agentId`, `resolvedAt`.
