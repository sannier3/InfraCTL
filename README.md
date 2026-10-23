# Infra Manager

Infra Manager surveille un parc Proxmox et Debian, et lance des opérations de maintenance déjà prévues. Une personne ouvre un site, voit les machines, et choisit une action par son nom : voir les mises à jour, les installer, redémarrer un service, relever les ports. Le serveur n'envoie jamais une commande tapée librement. C'est l'agent, sur la machine, qui sait comment faire.

Deux programmes :

- **Le serveur**, une seule fois. Il garde la liste des machines, la file des travaux et le site.
- **L'agent**, sur chaque nœud Proxmox, chaque VM Debian et chaque machine Debian physique à entretenir. Il appelle le serveur. Le serveur ne se connecte jamais à lui.

Un conteneur LXC n'a pas d'agent. Son nœud Proxmox agit pour lui. Une VM n'est pas commandée depuis l'hyperviseur : son propre agent s'occupe d'APT et de systemd.

Le site se trouve à `http://ADRESSE-DU-SERVEUR:8080/ui`. Le port `8080` est celui proposé à l'installation. S'il a été changé, utilisez le port choisi. Il n'y a pas de nom d'utilisateur : un mot de passe suffit.

## Avant de commencer

Sur la machine qui reçoit le serveur ou un agent :

- Debian avec systemd, et le droit `sudo` ;
- un accès au dépôt git privé `https://git.jbsan.fr/JBSAN-INFORMATIQUE/InfraCTL.git` (l'installation clone ce dépôt) ;
- l'heure juste, à moins d'une minute de celle du serveur. Sans cela, l'agent est refusé.

Pour le serveur, il faut aussi une base MariaDB ou MySQL. Deux cas : une base déjà en place, ou une base créée dans Docker sur la machine du serveur.

Les agents installés dans le réseau local doivent joindre le serveur par son adresse locale, par exemple `192.168.100.30`. Le nom public du site peut sortir du réseau et revenir par un chemin que l'agent n'atteint pas.

Notez les secrets au moment où ils s'affichent. Le script ne les réaffiche pas.

## Obtenir le script

Le même fichier, `run-infractl.sh`, sert au serveur et à l'agent. `--mode` choisit lequel.

Depuis une copie du dépôt déjà présente :

```bash
sudo bash run-infractl.sh --help
```

Depuis une machine qui peut lire le dépôt :

```bash
curl -fsSL "https://git.jbsan.fr/JBSAN-INFORMATIQUE/InfraCTL/raw/branch/main/run-infractl.sh" -o /tmp/run-infractl.sh
sudo bash /tmp/run-infractl.sh --help
```

Le dépôt est privé. Sans droit de lecture, ce téléchargement est refusé.

Une fois le serveur démarré, les autres machines peuvent prendre le script ici. Ce fichier ne contient aucun secret :

```bash
curl -fsSL "http://ADRESSE-DU-SERVEUR:8080/install/run-infractl.sh" -o /tmp/run-infractl.sh
```

L'installation clone ensuite le dépôt : la machine a quand même besoin d'un accès git.

## Installer le serveur

À lancer une seule fois, sur la machine qui hébergera le site.

Base MariaDB déjà en place. Si le mot de passe contient `@`, `:`, `/` ou `#`, encodez-le dans l'adresse (`%40` pour `@`) :

```bash
sudo bash /tmp/run-infractl.sh --mode server --install --database existing \
  --db-url 'mysql://infra:MOT_DE_PASSE@10.0.0.17:3306/infra_manager'
```

Base neuve, dans Docker, joignable seulement depuis cette machine :

```bash
sudo bash /tmp/run-infractl.sh --mode server --install --database docker
```

Le script installe git, Node.js et pnpm, place le code dans `/opt/infra-manager`, écrit la configuration dans `/etc/infra-manager/config.yaml` et démarre le service `infra-manager`.

À la fin, il affiche une seule fois :

- l'adresse du site ;
- le mot de passe de l'interface ;
- le jeton d'administration, pour les appels d'API.

Ouvrez le site, entrez le mot de passe, et gardez ces deux secrets.

Pour choisir l'écoute dès l'installation : `--bind 0.0.0.0 --port 8080`. Pour imposer le mot de passe : `--ui-password 'au-moins-12-caracteres'`.

## Installer un agent

L'ordre le plus simple :

1. Sur le site, ouvrez **Agents**, puis **Nouvel agent**.
2. Choisissez `proxmox-node` pour un nœud Proxmox, ou `linux-node` pour une VM ou une machine physique.
3. Copiez le secret affiché, ou laissez-en générer un.
4. Cliquez **Configuration**. La fenêtre donne le fichier YAML et une commande prête à coller.
5. Collez cette commande sur la machine, en root.

Cette commande télécharge le script et lui passe la configuration. Elle ressemble à ceci :

```bash
curl -fsSL "http://ADRESSE-DU-SERVEUR:8080/install/run-infractl.sh" -o /tmp/run-infractl.sh
sudo bash /tmp/run-infractl.sh --mode agent --install --config - <<'EOF'
# le YAML affiché par le site
EOF
```

Le code de l'agent va dans `/opt/infra-agent`. Sa configuration va dans `/etc/infra-agent/config.yaml`, lisible seulement par root. Le service s'appelle `infra-agent`.

Sans passer par le site, les mêmes installations se font à la main.

Nœud Proxmox. `--cluster-id` est le nom stable du cluster, le même pour tous les nœuds de ce cluster :

```bash
sudo bash /tmp/run-infractl.sh --mode agent --install \
  --server-protocol http --server-host 192.168.100.30 --server-port 8080 \
  --agent-id pve-01 --agent-type proxmox-node \
  --agent-secret 'SECRET_COPIE_DEPUIS_LE_SITE' \
  --cluster-id pve
```

VM Debian :

```bash
sudo bash /tmp/run-infractl.sh --mode agent --install \
  --server-protocol http --server-host 192.168.100.30 --server-port 8080 \
  --agent-id vm-01 --agent-type linux-node --machine-type VM \
  --agent-secret 'SECRET_COPIE_DEPUIS_LE_SITE'
```

Machine physique : le même commande, avec `--machine-type PHYSICAL`.

Si le script invente le secret lui-même, il l'affiche une fois. Il faut alors créer l'agent sur le site avec exactement cet identifiant et ce secret, puis redémarrer l'agent :

```bash
sudo bash /tmp/run-infractl.sh --mode agent --service restart
```

Après une minute, l'agent passe **En ligne**, puis sa machine apparaît dans **Machines**. L'inventaire Proxmox ajoute ensuite les LXC et les VM vus par le nœud. Une VM n'aura des mises à jour APT que si elle a son propre agent.

Vérifier :

```bash
sudo bash /tmp/run-infractl.sh --mode agent --status
systemctl status infra-agent
```

Si le journal répète « serveur injoignable », comparez l'heure des deux machines et l'adresse écrite dans `/etc/infra-agent/config.yaml`. Les deux horloges doivent rester à moins d'une minute l'une de l'autre.

## Configurer

Reprendre les questions, une par une. La touche Entrée garde la valeur déjà en place.

```bash
sudo bash /tmp/run-infractl.sh --mode server --configure
sudo bash /tmp/run-infractl.sh --mode agent --configure
```

Remplacer la configuration par une neuve, après avoir copié l'ancienne :

```bash
sudo bash /tmp/run-infractl.sh --mode server --configure --fresh
sudo bash /tmp/run-infractl.sh --mode agent --configure --fresh
```

`--fresh` sur le serveur crée une nouvelle clé de chiffrement. Les secrets d'agents déjà enregistrés dans la base ne seront plus lisibles.

Changer seulement le mot de passe du site. Douze caractères au minimum. Le service redémarre.

```bash
sudo bash /tmp/run-infractl.sh --mode server --change-password
```

Activer ou couper le site, puis redémarrer :

```bash
sudo bash /tmp/run-infractl.sh --mode server --ui enable
sudo bash /tmp/run-infractl.sh --mode server --ui disable
```

La page **Paramètres** du site change les délais, la concurrence et les secrets. Un champ secret vide conserve la valeur actuelle. La clé de chiffrement reste dans le fichier du serveur : le site ne la réécrit pas.

Le bouton **Configuration** d'un agent réaffiche le YAML à déposer dans `/etc/infra-agent/config.yaml`. Changer le secret sur le site oblige à recopier ce fichier sur la machine, puis à redémarrer `infra-agent`.

## Mettre à jour

La mise à jour prend le code du dépôt, le reconstruit et redémarre le service. Elle ne réécrit pas la configuration, les secrets, ni le fichier systemd déjà installé.

Téléchargez d'abord le script du serveur, pour utiliser la version qui sait mettre à jour :

```bash
curl -fsSL "http://ADRESSE-DU-SERVEUR:8080/install/run-infractl.sh" -o /tmp/run-infractl.sh
```

Serveur :

```bash
sudo bash /tmp/run-infractl.sh --mode server --update
```

Agent, sur la machine de l'agent :

```bash
sudo bash /tmp/run-infractl.sh --mode agent --update
```

Le script cherche le dépôt dans `/opt/infra-agent`, puis dans le dossier du service `infra-agent`, puis dans `/opt/infra-manager` si l'agent est installé à côté du serveur.

Depuis le site, page **Agents**, le bouton **Mettre à jour** propose deux façons :

- **Par le script** : la machine refait le `git pull` et la construction. Elle doit pouvoir lire le dépôt.
- **Par le serveur** : le serveur envoie le code déjà compilé. La machine n'a pas besoin de git. La configuration n'est pas touchée.

La première mise à jour d'un agent ancien se fait avec la commande sur la machine. Le bouton du site ne fonctionne qu'une fois l'agent capable de recevoir cette action. Sur la machine qui héberge le serveur, préférez **Par le serveur** : cela remplace le programme de l'agent sans refaire toute l'installation du serveur.

Pour construire sans redémarrer tout de suite :

```bash
sudo bash /tmp/run-infractl.sh --mode server --update --no-restart
sudo bash /tmp/run-infractl.sh --mode agent --update --no-restart
```

## Supprimer

Retirer le programme et le service. La configuration reste sur la machine, avec une copie dans `/var/lib/infra-manager/backup` ou `/var/lib/infra-agent/backup`.

```bash
sudo bash /tmp/run-infractl.sh --mode server --uninstall
sudo bash /tmp/run-infractl.sh --mode agent --uninstall
```

Retirer aussi la configuration locale. Le script demande confirmation.

```bash
sudo bash /tmp/run-infractl.sh --mode server --uninstall --purge
sudo bash /tmp/run-infractl.sh --mode agent --uninstall --purge
```

`--yes` évite la question :

```bash
sudo bash /tmp/run-infractl.sh --mode server --uninstall --purge --yes
```

Une base MariaDB installée sur une autre machine n'est jamais effacée. Seule l'instance Docker créée par ce script est arrêtée, et seulement avec `--purge`. Sur la machine du serveur, `--mode agent --uninstall` retire le service de l'agent. Le dossier `/opt/infra-manager` ne part qu'avec `--mode server --uninstall`.

Retirer un agent de la liste, sans désinstaller la machine, se fait sur le site : page **Agents**, bouton **Régler**, puis **Retirer**. La machine distante garde son service tant que la commande `--uninstall` n'y a pas été lancée.

## Autres commandes

État, sans afficher les secrets :

```bash
sudo bash /tmp/run-infractl.sh --mode server --status
sudo bash /tmp/run-infractl.sh --mode agent --status
```

Arrêter, démarrer, redémarrer :

```bash
sudo bash /tmp/run-infractl.sh --mode server --service stop
sudo bash /tmp/run-infractl.sh --mode server --service start
sudo bash /tmp/run-infractl.sh --mode server --service restart
sudo bash /tmp/run-infractl.sh --mode agent --service restart
```

Journaux du service :

```bash
sudo journalctl -u infra-manager -n 80 --no-pager
sudo journalctl -u infra-agent -n 80 --no-pager
```

Si le serveur a échoué plusieurs fois de suite, systemd refuse de le relancer. On efface ce compteur, puis on démarre :

```bash
sudo systemctl reset-failed infra-manager
sudo systemctl start infra-manager
```

Fichiers utiles :

| Rôle | Code | Configuration | Service |
| --- | --- | --- | --- |
| Serveur | `/opt/infra-manager` | `/etc/infra-manager/config.yaml` | `infra-manager` |
| Agent | `/opt/infra-agent` | `/etc/infra-agent/config.yaml` | `infra-agent` |

Si le service du serveur existait déjà, sa configuration est le fichier indiqué dans l'unité systemd, qui peut différer du chemin du tableau.

## Utiliser le site

| Écran | Ce qu'on y fait |
| --- | --- |
| Vue d'ensemble | Voir si le service, la base et les agents répondent |
| Agents | Créer un agent, copier sa configuration, le mettre à jour |
| Machines | Voir l'adresse, l'agent responsable, les mises à jour et l'état |
| Mises à jour | Dernière recherche APT, par paquet |
| Paquets | Paquets déjà installés. **Relever les paquets** interroge les machines |
| Services | Ports en écoute, Docker et fichiers Compose dans `/opt`. **Relever** interroge les machines. Rien n'est démarré. « À démarrer » veut dire qu'un projet Compose est présent et qu'aucun de ses conteneurs ne tourne |
| Travaux | Lancer une action, lire le journal, annuler ce qui est encore en file, acquitter un travail interrompu |
| Clusters | Nœuds vus par l'inventaire Proxmox |
| Alertes | Alertes encore ouvertes |
| Paramètres | Délais, concurrence, jetons et mot de passe |

Pour mettre à jour une machine : ouvrir sa fiche, **Rechercher les mises à jour**, lire la liste, puis **Mettre à jour**. S'il faut supprimer un paquet, le travail s'arrête et n'installe rien. Un travail interrompu ou au résultat inconnu bloque les écritures suivantes sur cette machine tant qu'il n'est pas acquitté. L'acquittement ne le relance pas.

Les actions proposées dépendent du type de machine. Un nœud Proxmox peut interroger le cluster et lancer un inventaire. Un LXC est traité par l'agent de son nœud. Une VM ou une machine physique est traitée par son agent.

Le détail des écrans est dans [docs/interface.md](docs/interface.md).

## Dépannage court

- L'agent reste hors ligne : vérifier l'adresse du serveur, le secret, puis `date -u` sur les deux machines.
- La liste des machines est vide alors que l'agent est en ligne : attendre le prochain inventaire, environ 30 secondes, ou lancer **Inventaire Proxmox** sur le nœud.
- Une VM n'a pas de mises à jour : elle a besoin de son agent `linux-node`. L'agent du nœud ne fait pas APT à l'intérieur d'une VM.
- Le site ne change pas après une modification du fichier `app.js` : recharger la page. Un changement du serveur lui-même demande `sudo bash /tmp/run-infractl.sh --mode server --service restart`.

## Développement

Ces commandes servent à lancer le projet sur un poste de travail. Elles ne remplacent pas l'installation ci-dessus.

```bash
pnpm install
docker compose up -d
pnpm prisma:migrate
pnpm dev
```

Node.js 20 ou plus récent, pnpm 9.15.9. La base de développement est MariaDB 11, utilisateur `infra`, mot de passe `infra_dev_password`. Le fichier `config.example.yaml` contient des secrets publics : ils restent sur le poste de développement.

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Les tests ne lancent ni `apt-get` ni `pct`.

Le protocole, les jetons et la forme de l'API sont décrits dans [docs/README.md](docs/README.md).
