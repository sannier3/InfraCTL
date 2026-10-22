# Interface

L'adresse est `http://127.0.0.1:8080/ui` une fois le serveur démarré et `ui.enabled` à `true`.

Le formulaire demande un seul mot de passe, celui de `ui.password`. Il n'y a pas de nom d'utilisateur. La session reste dans un cookie que le navigateur ne peut pas lire. Fermer la session efface ce cookie.

Les écrans couvrent ce que l'API de gestion sait faire :

| Écran | Actions |
| --- | --- |
| Vue d'ensemble | Santé, agents, travaux récents |
| Agents | Créer, renommer, concurrence, capacités, nouveau secret, retirer |
| Machines | Liste, détail, ressources, dernier `apt.check`, bouton Mettre à jour, travaux |
| Travaux | Lancer `system.info`, `apt.check` ou `apt.upgrade`, suivre l'état, lire les journaux, annuler, acquitter |
| Clusters | Clusters et nœuds remontés par un inventaire Proxmox |
| Alertes | Alertes ouvertes |

Créer un agent ici équivaut à `pnpm agent:register`. Le secret saisi doit ensuite être recopié dans le YAML de la machine. L'écran ne le réaffiche pas.

Les actions proposées sont les mêmes sur un hôte, un LXC, une VM et une machine physique : état du système, consultation APT, mise à jour APT. Le mode d'exécution `proxmox-node` reste hors service même si un agent de ce type peut déjà être enregistré. La mise à jour d'un LXC attend cet agent de nœud.
