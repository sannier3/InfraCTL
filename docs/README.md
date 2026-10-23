# Documentation

L'installation, la configuration, la mise à jour et la suppression sont dans le [README](../README.md), avec une commande distincte pour le serveur et pour l'agent.

Le serveur expose une API REST `/api/v1` et le site sur `/ui`.

| Document | Contenu |
| --- | --- |
| [README](../README.md) | À quoi sert Infra Manager, et les commandes pour l'installer et l'entretenir |
| [Interface](interface.md) | Page `/ui`, session, écrans |
| [Contexte](context.md) | Résumé stable du projet et règles qui ne se négocient pas |
| [Logique du serveur](logique-serveur.md) | Rôles du serveur et de l'agent, inventaire, travaux |
| [Authentification](authentification.md) | Jeton Bearer de l'API, mot de passe de l'interface, secret HMAC des agents |
| [API](api.md) | Routes, corps des requêtes, formes des réponses |
| [Appels PHP](php.md) | Client PHP, listes, détail, lancement d'une action, attente du résultat |

La page `http://127.0.0.1:8080/docs` décrit les mêmes routes en OpenAPI lorsque `server.exposeSwagger` vaut `true`. Ce n'est pas un écran de gestion. Le port réel est celui du serveur installé.
