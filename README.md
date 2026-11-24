# Planning IDEL

Espace privé de coordination des quatre IDEL pour le planning de janvier à juin 2027. Les tournées correspondent à des créneaux et des affectations d'équipe, pas à des visites de patients. Le chat de démonstration est réservé à la coordination de l'équipe : aucune donnée patient, adresse de visite, information de soins ou document ne doit y être partagé, ni importé dans le planning. Les motifs de refus sont prédéfinis.

## Mise en service

1. **Supabase Free.** Utiliser un projet dédié dans une région précise de l'UE. Activer le MFA TOTP, laisser le fournisseur e-mail actif, désactiver l'inscription publique et les comptes anonymes, et fixer la longueur minimale à 14. Avec la CLI Supabase actuelle, vérifier la cible et les migrations avec `supabase db push --remote --dry-run`, puis appliquer avec `supabase db push --remote`. Activer ensuite le hook d'envoi `pg-functions://postgres/public/idel_block_auth_email` dans les paramètres Auth. Ne pas pousser tel quel le fichier `supabase/config.toml` : il contient une URL locale et une option e-mail héritée. Ne pas transférer les anciens messages ou motifs libres vers ce projet.
2. **Comptes et planning.** Vérifier les adresses par un canal connu, puis créer les quatre utilisateurs Auth avec e-mail confirmé et mot de passe temporaire unique. Dans l'éditeur SQL, lier chaque UUID Auth à son prénom dans `public.members (id, name)` ; le changement de mot de passe est forcé au premier accès. Pour le compte administrateur dédié (hors `members`), créer un utilisateur Auth confirmé et exécuter `select public.provision_operator('<uuid-auth-administrateur>');` dans l'éditeur SQL. Valider puis importer uniquement le CSV revu (date et deux affectations, sans colonne patient) :

   ```powershell
   npm run planning -- validate chemin/vers/planning.csv
   npm run planning -- import chemin/vers/planning.csv --confirm-reviewed
   ```

   L'import est unique. Il lit `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` depuis l'environnement d'une session privée ; ne jamais fournir cette clé à Cloudflare, au navigateur ou au dépôt.

3. **Cloudflare Pages Free.** Connecter le dépôt privé, choisir `main` comme branche de production, puis définir `npm run build` et le dossier de sortie `dist`, avec Node 22. Renseigner seulement `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY` pour l'environnement de production (voir `.env.example`). Ne pas brancher les aperçus sur la production. Pages sert nativement l'application React sans règle générique de réécriture. Définir le lien HTTPS définitif comme `Site URL` dans Supabase. Ne jamais exposer le Compose local : il utilise des identifiants de test publics.
4. **Second facteur administrateur.** L'administrateur se connecte, scanne le QR dans son application d'authentification et valide un premier code. Vérifier sa référence de facteur par un canal connu (ne jamais demander le QR, la clé ou le code), puis exécuter `select public.approve_operator_totp('<uuid-auth-administrateur>', '<uuid-facteur>');` dans l'éditeur SQL. Cela révoque ses sessions : il se reconnecte avec le mot de passe et un nouveau code. Si l'appareil est perdu, vérifier l'identité, retirer l'ancien facteur dans Supabase Auth, exécuter `approve_operator_totp` avec le même UUID utilisateur et `null`, puis refaire l'association.
5. **Recette avant diffusion.** Exécuter `supabase/checks/preflight.sql` dans l'éditeur SQL et exiger que tous les contrôles soient vrais. Vérifier sur téléphone et ordinateur : visite sans compte, premier changement de mot de passe, échange approuvé par les deux participantes, refus prédéfini, suspension puis réactivation et connexion administrateur avec TOTP. Tester les échanges avec des données fictives sur un projet distinct, pas sur le planning officiel.

## Exploitation

- Communiquer le lien et chaque mot de passe temporaire séparément par des canaux privés. Les IDEL n'ont pas de compte chez les hébergeurs. Informer l'équipe sur les données de compte et de planning conservées, la durée de conservation et le contact responsable ; vérifier les conditions de sous-traitance des hébergeurs.
- En cas d'oubli du mot de passe, l'administrateur vérifie l'identité et suspend le membre ; le responsable Supabase définit un mot de passe temporaire via l'API Auth Admin, puis exécute `require_password_change` pour le UUID concerné avant la réactivation. L'activation et la suspension se font dans l'application. Aucune réinitialisation automatique par e-mail n'est utilisée.
- Supabase Free peut suspendre le projet après une semaine d'inactivité et n'inclut pas les sauvegardes automatiques. Conserver un export chiffré, tester la restauration des affectations et des comptes dans un environnement isolé selon le [guide de sauvegarde Supabase](https://supabase.com/docs/guides/platform/backups), et garder une copie récente du planning accessible au cabinet en cas d'interruption. Ne pas tester une restauration sur la production.
