# Logique du serveur

Infra Manager est un moteur de maintenance contrôlée. Le serveur central est le seul composant qui écoute sur le réseau. Chaque machine surveillée porte un agent qui appelle le serveur. Le serveur n'ouvre jamais de connexion vers un agent.

```text
site ou page PHP  --Bearer-->  serveur Fastify  <--HTTP long polling--  agent
                                        |
                                     MariaDB
```

Le site et la page PHP parlent au serveur. Ils ne parlent pas aux agents et ne signent pas de requêtes HMAC.

## Deux programmes

Le serveur (`apps/server`) reçoit l'inventaire, range les métriques et les jobs, et décide quel agent a le droit d'exécuter une action. Il ne lance aucune commande système.

L'agent (`apps/agent`) tourne en `linux-node` sur une VM ou une machine physique, et en `proxmox-node` sur un nœud Proxmox. Un LXC n'a pas d'agent : le nœud exécute l'action avec `pct exec`. Il envoie :

- un heartbeat toutes les 10 secondes ;
- un inventaire toutes les 30 secondes ;
- des ressources locales toutes les 30 secondes si `metrics.source` vaut `LOCAL_AGENT` ;
- une requête `GET /api/v1/agent/jobs/next` tenue environ 30 secondes.

S'il n'y a pas de job, le serveur répond `204` et l'agent redemande tout de suite. S'il y en a un, l'agent l'exécute localement puis renvoie le résultat et les journaux.

## Ce que le serveur accepte de demander

Le corps d'une action contient un nom, jamais une commande :

```json
{
  "action": "apt.check",
  "selector": { "type": "machine", "id": "uuid-de-la-machine" }
}
```

Un champ `command` est refusé. L'agent possède l'implémentation. Pour `apt.check`, il lance un `apt-get` de simulation avec un tableau d'arguments fixe. `system.info` lit le système sans processus shell.

Les actions du catalogue sont actives. Les familles :

| Famille | Effet |
| --- | --- |
| `system.info`, `system.rebootRequired` | Lecture de l'état, sans modification |
| `apt.check`, `apt.packages`, `apt.refresh` | Simulation ou lecture APT. `apt.refresh` modifie les index |
| `apt.upgrade` | Nouvelle simulation, puis `apt-get upgrade` si aucun paquet n'est retiré |
| systemd, journal | État, redémarrage d'une unité nommée, extrait de journal |
| `proxmox.*`, `lxc.*` | Inventaire, ressources et fiche. Réservées au nœud ou au LXC |
| `runtime.survey` | Ports en écoute, Docker, fichiers Compose dans `/opt`. Ne démarre rien |
| `agent.update` | Met à jour le programme de l'agent, par le script ou par le serveur |
| `system.reboot`, `system.shutdown`, `proxmox.host.update` | Actions critiques |

Un LXC est exécuté par `pct exec` depuis l'agent `proxmox-node` de son hôte. Une VM passe par son agent `linux-node`.

## Cycle d'une action

1. La page PHP envoie `POST /api/v1/actions`.
2. Le serveur vérifie le jeton, le nom d'action, le type de machine et l'existence de la cible.
3. Il crée un job `QUEUED`. Une cible unique de type `machine` produit un job feuille. `machines`, `fleet`, `cluster` ou `proxmox-node` produisent un job parent et un enfant par machine.
4. Le scheduler, environ une fois par seconde, assigne le job si l'agent est `ONLINE` et si les verrous de concurrence sont libres.
5. L'agent récupère le job par long polling, rappelle son état réel, exécute, envoie les journaux, puis termine.
6. La page PHP relit `GET /api/v1/jobs/{id}` jusqu'à un état terminal.

États terminaux : `SUCCESS`, `FAILED`, `SKIPPED`, `INTERRUPTED`, `UNKNOWN`, `CANCELLED`. `REQUIRES_CONFIRMATION` est aussi un arrêt : le job ne repart pas seul.

Un agent hors ligne au moment de l'assignation donne `SKIPPED`, pas un échec de tout le lot. Un agent qui disparaît pendant l'exécution donne `UNKNOWN`. Ce job n'est pas relancé.

## D'où viennent les machines

Une machine n'est pas créée par l'API de gestion. L'agent l'annonce dans son inventaire, après son premier heartbeat réussi. Tant que l'agent n'a pas envoyé d'inventaire, `GET /api/v1/machines` peut être vide alors que `GET /api/v1/agents` montre déjà l'agent `ONLINE`.

L'enregistrement de l'agent se fait avant le premier contact, par un administrateur. Deux chemins équivalents :

```bash
pnpm agent:register -- --id edge-01 --name edge-01 --type linux-node --secret "un-secret-d-au-moins-16"
```

```http
POST /api/v1/agents
Authorization: Bearer <apiToken>
```

```json
{ "id": "edge-01", "name": "edge-01", "type": "linux-node", "secret": "un-secret-d-au-moins-16" }
```

Le même identifiant et le même secret sont écrits dans le YAML de la machine. La réponse de l'API ne contient pas le secret. Il n'existe pas d'auto-inscription. Le détail des routes de gestion est dans [api.md](api.md).

## Ce que la page peut montrer

| Besoin | Source |
| --- | --- |
| Santé du service | `GET /api/v1/health` |
| Agents et présence | `GET /api/v1/agents` |
| Parc | `GET /api/v1/machines` |
| CPU, mémoire, disque, réseau | `GET /api/v1/machines/{id}/resources` |
| Dernières mises à jour APT | `GET /api/v1/machines/{id}/updates` après un `apt.check` réussi |
| Demande en cours et historique | `GET /api/v1/jobs` et `GET /api/v1/jobs/{id}` |
| Sortie de la commande | `GET /api/v1/jobs/{id}/logs` |
| Alertes ouvertes | `GET /api/v1/alerts` |

Les ressources ne sont présentes que si l'agent a `metrics.source: LOCAL_AGENT`. Avec `PROXMOX`, l'agent n'envoie pas CPU, RAM ni réseau ; ces séries viendront plus tard de Proxmox.

Une machine `STOPPED` depuis plus de cinq minutes reçoit `hiddenAt` et sort de la liste active. `includeHidden=true` la réaffiche. Elle n'est pas supprimée.
