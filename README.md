# RdvOptimiser

Réorganise une tournée de rendez-vous à partir des adresses saisies, des temps de trajet réels
et d'une durée de rendez-vous paramétrable — en respectant les rendez-vous qui ne peuvent pas
être décalés.

100 % front : aucun serveur, aucune clé API, aucune donnée ne quitte le navigateur (hors requêtes
de géocodage et de routage vers OpenStreetMap).

## Utilisation

1. Saisir le **point de départ** (autocomplétion d'adresse).
2. Ajouter les **adresses de rendez-vous**.
3. Régler la **durée par défaut** (30 min), surchargeable rendez-vous par rendez-vous.
4. Cocher **« heure imposée »** sur les rendez-vous non décalables et renseigner l'heure.
5. **Optimiser la tournée**.

Le résultat affiche l'ordre proposé, l'heure de chaque rendez-vous, les trajets intermédiaires,
la carte, et le gain par rapport à l'ordre de saisie. Il s'exporte en `.ics`, se copie en texte,
ou s'ouvre dans Google Maps.

## Le modèle d'optimisation

Un ordre de passage est simulé dans le temps : départ à l'heure choisie, trajet, rendez-vous,
trajet suivant. Un rendez-vous à **heure imposée** ne démarre jamais avant son heure — arriver
en avance produit de l'**attente**, arriver après produit du **retard**.

Les solutions sont comparées lexicographiquement :

1. retard cumulé sur les heures imposées (toujours ramené à zéro si c'est possible) ;
2. heure de fin de tournée ;
3. temps de trajet total.

Si aucun ordre ne tient les contraintes, la meilleure solution est affichée avec un bandeau
nommant les rendez-vous en retard, plutôt qu'un échec muet.

La recherche est **exhaustive jusqu'à 9 rendez-vous** (optimum garanti pour le modèle ci-dessus).
Au-delà, une recherche locale 2-opt + Or-opt part de plusieurs solutions initiales (ordre de
saisie, plus proche voisin, insertion la moins coûteuse, tirages aléatoires à graine fixe).
Le tirage est déterministe : deux optimisations d'une même saisie rendent le même itinéraire.

## Services externes

| Usage | Service | Clé API |
|---|---|---|
| Géocodage | [Nominatim](https://nominatim.org/) | non |
| Matrice temps/distances et tracé | [OSRM](https://project-osrm.org/) (serveur de démo) | non |
| Fond de carte | tuiles OpenStreetMap | non |

Ces serveurs de démonstration sont gratuits mais soumis à une
[politique d'usage](https://operations.osmfoundation.org/policies/nominatim/) : ils conviennent à
un usage individuel, pas à un déploiement à fort trafic. Pour un usage intensif, renseignez votre
propre instance OSRM dans **Avancé → Serveur OSRM**.

Si le routage est injoignable, l'application bascule sur une estimation (distance à vol d'oiseau
× 1,3, à la vitesse moyenne configurable) et le signale sous le bouton.

## Limites connues

- Profil **voiture** uniquement (le serveur de démo OSRM n'expose que celui-ci).
- Le trafic n'est pas pris en compte : les temps OSRM sont des temps à vide.
- Le lien Google Maps est plafonné à 9 étapes intermédiaires (limite de Google).
- Les heures imposées sont des instants exacts, pas des créneaux.

## Développement

```bash
npx serve .          # ou : python -m http.server
node tests/optimizer.test.mjs
```

Pas de build, pas de dépendance à installer : les modules ES sont servis tels quels. Leaflet est
chargé depuis un CDN.

## Déploiement

`.github/workflows/deploy.yml` lance les tests puis publie la racine du dépôt sur GitHub Pages à
chaque push sur `main`.

Une fois : **Settings → Pages → Build and deployment → Source : GitHub Actions**.

Le site est alors servi sur `https://<votre-compte>.github.io/RdvOptimiser/`. Tous les chemins
sont relatifs, il n'y a donc rien à configurer pour ce sous-répertoire.
