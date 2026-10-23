# Interface

L'adresse est `http://ADRESSE-DU-SERVEUR:8080/ui` une fois le serveur démarré et `ui.enabled` à `true`. Le port est celui choisi à l'installation.

Le formulaire demande un seul mot de passe, celui de `ui.password`. Il n'y a pas de nom d'utilisateur. La session reste dans un cookie que le navigateur ne peut pas lire. **Fermer la session** efface ce cookie.

| Écran | Contenu |
| --- | --- |
| Vue d'ensemble | Santé du service et de la base, agents, machines à mettre à jour, travaux récents |
| Agents | Créer, copier la configuration, mettre à jour le programme, régler la concurrence et les capacités, changer le secret, retirer |
| Machines | Nom, nœud Proxmox, identifiant, adresse, agent, mises à jour, type, état. Le filtre Nœuds, aussi présent sur les mises à jour, les paquets, les services, les travaux, les alertes et les clusters, limite l'affichage à un ou plusieurs nœuds. Tous est le choix de départ |
| Mises à jour | Paquets proposés par la dernière recherche, et les machines concernées |
| Paquets | Paquets installés. **Relever les paquets** lance la lecture sur le parc |
| Services | Ports en écoute, état de Docker, projets Compose trouvés dans `/opt`. **Relever** rafraîchit ces listes. Aucun projet n'est démarré |
| Travaux | Lancer une action, suivre un lot, lire les journaux, annuler un travail encore en file, acquitter un résultat inconnu ou interrompu |
| Clusters | Clusters et nœuds remontés par un inventaire Proxmox |
| Alertes | Alertes ouvertes. Un nœud hors ligne regroupe ses invités |
| Paramètres | Écoute, sécurité, délais, concurrence, planificateur, interface, secrets |

Créer un agent ici enregistre son identifiant et son secret. Le bouton **Configuration** donne le YAML à placer dans `/etc/infra-agent/config.yaml`, et une commande qui installe l'agent avec ce fichier. Le secret n'est réaffiché que depuis cette configuration, juste après la création ou un renouvellement.

**Mettre à jour** sur la page Agents propose le script d'installation, ou l'envoi du code compilé par le serveur. La configuration de l'agent est conservée. Un agent qui ne connaît pas encore cette action se met à jour avec la commande du [README](../README.md#mettre-à-jour), sur la machine.

L'hôte, le LXC, la VM et la machine physique partagent les actions système, APT, systemd et journal. Le nœud Proxmox a en plus son inventaire et sa mise à jour d'hôte. Le LXC est exécuté par l'agent de son nœud, avec `pct exec`. Une VM passe par l'agent installé dans cette VM. Une unité systemd ou un extrait de journal se saisissent dans le formulaire de l'action.

Un travail `UNKNOWN`, `INTERRUPTED` ou `REQUIRES_CONFIRMATION` sur une action qui modifie la machine bloque les écritures suivantes jusqu'à l'acquittement. L'acquittement constate que quelqu'un a vu le résultat. Il ne relance pas le travail.
