# Documentation

Le serveur Infra Manager n'a pas d'interface d'administration. Une page PHP, ou n'importe quel autre programme, parle à l'API REST `/api/v1`.

| Document | Contenu |
| --- | --- |
| [Contexte](context.md) | Résumé stable du projet, invariants et périmètre de cette version |
| [Logique du serveur](logique-serveur.md) | Rôles du serveur et de l'agent, inventaire, jobs, ce qui est actif |
| [Authentification](authentification.md) | Jeton Bearer de l'API, jeton lecteur, secret HMAC des agents |
| [API](api.md) | Routes, corps des requêtes, formes des réponses, ce qu'il faut afficher |
| [Appels PHP](php.md) | Client PHP, listes, détail, lancement d'une action, attente du résultat |

La page `http://127.0.0.1:8080/docs` décrit les mêmes routes en OpenAPI lorsque `server.exposeSwagger` vaut `true`. Ce n'est pas un écran de gestion.

L'installation du serveur et de l'agent est dans le [README](../README.md) à la racine du dépôt.
