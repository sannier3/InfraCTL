# Authentification

Il n'y a ni compte, ni identifiant, ni mot de passe, ni formulaire de connexion. Deux mécanismes distincts coexistent.

## API de gestion, utilisée par PHP

Chaque requête vers `/api/v1/...`, sauf la santé, porte :

```http
Authorization: Bearer <jeton>
```

Les jetons sont dans le YAML du serveur :

```yaml
auth:
  apiToken: dev-admin-token-change
  readToken: dev-reader-token-change
```

| Jeton | Rôle |
| --- | --- |
| `apiToken` | Lecture, lancement de toutes les actions activées, annulation, acquittement |
| `readToken` | Lecture, et lancement des seules actions de catégorie READ (`system.info`, `apt.check`) |

`readToken` est optionnel. S'il est absent, seul `apiToken` est accepté.

`GET /api/v1/health` ne demande aucun jeton.

Un jeton absent ou inconnu répond `401` :

```json
{ "error": { "code": "UNAUTHORIZED", "message": "jeton API requis" } }
```

Un lecteur qui annule un job, acquitte un job, ou demande une action WRITE ou CRITICAL répond `403` avec le code `FORBIDDEN`.

Le jeton ne doit pas être écrit dans le HTML, dans JavaScript, ni dans l'URL. Le processus PHP le lit depuis l'environnement et appelle le serveur Infra Manager. Le navigateur ne parle qu'à PHP.

Comparer les jetons se fait sur leur empreinte SHA-256. Le serveur ne journalise pas la valeur du jeton : l'en-tête `authorization` est masqué dans les logs Fastify.

Remplacer les deux valeurs avant un usage autre que le développement local.

## Agents

L'agent ne présente pas le jeton Bearer. Chaque requête vers `/api/v1/agent/...` est signée en HMAC-SHA256 avec son secret. Les en-têtes sont `X-Agent-ID`, `X-Timestamp`, `X-Nonce` et `X-Signature`. Le secret est enregistré chiffré en base au moment de `pnpm agent:register` et n'est jamais renvoyé par l'API.

Une page PHP n'a pas à produire cette signature. Les routes `/api/v1/agent/*` sont réservées aux agents. Un appel Bearer sur ces routes est refusé, et un appel HMAC sur `/api/v1/machines` l'est aussi.

Le secret d'agent et le jeton d'API sont deux secrets différents. Connaître l'un ne donne pas l'autre.
