# AGENTS.md — Brief de ce projet

> Mémoire du projet côté humain. Elle vient avant le guide technique qui suit
> (« MorrisCode Codebase Guide ») et se met à jour au fil des sessions.

## Le projet

- **Ce que fait le produit** : MorrisCode est un assistant de codage agentique, né
  d'un fork d'OpenFox. Sa direction est assumée : moins « LLM local », plus
  multi-fournisseurs en ligne (ChatGPT, Copilot, OpenRouter…), avec une interface
  moderne.
- **Pour qui** : avant tout pour moi. Je le partagerai peut-être plus tard, mais ce
  n'est pas un objectif aujourd'hui.
- **Ce que je ne veux jamais casser** :
  - mes données locales — sessions, projets, historique (base SQLite) ;
  - la filiation avec OpenFox : `upstream` reste joignable, je veux pouvoir
    récupérer plus tard ses correctifs sans tout casser ;
  - ma configuration de production (`~/.config/morriscode/`) ;
  - mes workflows `.morriscode/` et les plugins que j'utilise ;
  - ma chaîne de publication (changelog, tag, merge vers `main`), décrite dans
    `docs/RELEASE.md`.

## Langue

- On se parle en **français**. Mais le **code** — noms de variables, de fichiers,
  commentaires — s'écrit **en anglais** : c'est la convention du métier, et c'est là
  que tu es le plus fiable.
- Même règle sur le repo : commits, titres d'issues et de pull requests en anglais.
- L'application, elle, est bilingue : toute chaîne visible par l'utilisateur existe
  en anglais **et** en français (règle déjà en vigueur ici, voir `docs/I18N.md`).

## Comment je veux qu'on travaille

- Je pilote ce projet sans lire le code : je supervise le produit, pas les fichiers.
- Applique les meilleures pratiques par défaut, même si je ne les demande pas —
  c'est ton métier, pas le mien.
- **Prends-moi par la main** : explique tes choix en langage courant, jamais en
  jargon. Un mot technique = une définition en une phrase simple.
- Avant de te lancer sur quelque chose de gros, dis-moi ton plan en clair et attends
  mon feu vert.
- À chaque fois que tu touches à Git ou à GitHub (commit, branche, pull request,
  workflow), dis-moi en **une phrase simple** ce que tu fais et à quoi ça sert.
- Quand une tâche est finie, dis-moi précisément quoi tester à la main, comme le
  ferait un utilisateur.
- Fais **toujours** des commits au format _conventional commits_ (`feat:`, `fix:`,
  `refactor:`, `docs:`, `chore:`, `feat!:`/`BREAKING CHANGE:`) — c'est ce qui
  alimente la publication. Je n'en écrirai jamais un moi-même : c'est ton travail, à
  chaque fois.

## RÈGLE VIVANTE

Chaque fois qu'une ligne de ce fichier me gêne à l'usage — trop de questions, pas
assez, du jargon, des explications inutiles — je te demande de la modifier ici, et tu
t'y tiens ensuite. Ce brief s'ajuste à moi, pas l'inverse.

## Garde-fous — demande-moi TOUJOURS avant de :

- toucher à l'authentification, aux comptes ou aux mots de passe ;
- toucher à un abonnement payant ou à un moyen de paiement ;
- supprimer des données, des fichiers, ou faire une action irréversible ;
- toucher à la base des sessions, aux workflows `.morriscode/` ou aux plugins que
  j'utilise ;
- modifier la configuration de production (`~/.config/morriscode/`) ;
- ajouter un nouveau service externe ou une nouvelle dépendance importante ;
- fusionner les commits d'OpenFox depuis `upstream` ;
- publier une version ou mettre en production (changelog, tag, merge vers `main`).

Dans ces cas : explique-moi le risque en langage simple, propose, et attends que je
valide.

## La ligne rouge — sécurité non négociable

Ce projet doit, en permanence, respecter ces règles. Si tu vois que l'une d'elles est
violée, préviens-moi immédiatement.

1. Tout ce qui circule sur le réseau est chiffré : HTTPS dès que l'application sort
   de `localhost`.
2. Les mots de passe et les jetons d'authentification ne sont jamais lisibles par
   personne, même moi.
3. Personne ne parle directement à la base de données (pas d'injection).
4. Les clés API des fournisseurs et les jetons OAuth ne partent jamais vers le
   navigateur.
5. L'agent ne touche jamais un fichier en dehors de son périmètre sans autorisation
   explicite.
6. Avant toute opération risquée sur la base (migration, bascule), une copie de
   sauvegarde existe.
7. Aucun secret (clé API, jeton, mot de passe) n'est écrit dans ce fichier, dans le
   dépôt ou dans un log.

## Conventions et décisions prises

- Fork assumé d'OpenFox : on reste capable de récupérer les commits d'`upstream`.
- Interface bilingue anglais + français, sans repli possible.
- Conventional commits obligatoires : ils alimentent directement le changelog et la
  publication.
- Les connexions par abonnement (ChatGPT Plus, etc.) passent par des points d'entrée
  non officiels, donc susceptibles de casser sans préavis : risque expliqué puis
  assumé explicitement avant l'implémentation.
- Le fournisseur ChatGPT est intégré au produit plutôt qu'installé comme plugin : le
  plugin communautaire d'origine ignore silencieusement tout modèle plus récent que
  `gpt-5` et n'est plus maintenu. Le code porté garde sa licence MIT, voir
  `src/server/providers/builtin/chatgpt/NOTICE.md`. S'il est déjà installé, il est laissé
  de côté au démarrage et affiché comme remplacé.
  Les fournisseurs intégrés se gèrent dans Fournisseurs : ils n'apparaissent pas parmi
  les plugins installés et ne peuvent pas être désactivés ou réinstallés comme plugins.
  Les coupons de réinitialisation ChatGPT sont consultables avec leur expiration,
  uniquement en lecture : leur utilisation reste dans ChatGPT, sans commande de
  consommation dans MorrisCode.
- L'usage d'un fournisseur se lit de deux façons : par son adaptateur de transport quand il
  en a un, sinon par une source intégrée reconnue sur l'hôte du fournisseur
  (`src/server/providers/builtin/usage-sources.ts`). Un point d'entrée non documenté n'est
  jamais appelé sur une adresse ressemblante, pour ne pas y laisser la clé.
- Un modèle décoché dans la fenêtre d'édition est enregistré avec `selected: false` : il
  disparaît du sélecteur de modèles et reste décoché à la réouverture. Dérouler un
  fournisseur dans le sélecteur ne resynchronise jamais sa liste — seule l'action
  explicite de synchronisation le fait.
- Cette liste vit : demande-moi de la tenir à jour quand on tranche quelque chose.

## Où on en est

- **Fait** : rebranding OpenFox → MorrisCode (serveur, web, docs, scripts), palette
  sombre neutre, arborescence de projet dans la barre latérale. MorrisCode est
  versionné 0.1.0, fork d'OpenFox 2.0.161.
- **Fait** : fournisseur ChatGPT Plus / Pro intégré, catalogue actuel, sélection persistante des modèles
  et indicateurs d’usage par fournisseur. Les erreurs de flux sont propagées et les images sont transmises.
- **Fait** : lecture vocale locale des réponses avec Kokoro int8 sur processeur, voix française et anglaise,
  installation guidée et contrôles lecture/pause/arrêt. Voir `docs/VOICE.md`.
- **Fait** : interface revue, accès HTTPS, authentification Windows alignée entre serveur et CLI.
  Tout accès hors localhost exige HTTPS et un mot de passe réseau valide.
- **Préparation production locale** : les changements sont regroupés sur `morriscode-rebrand`.
  Une installation Windows séparée conserve le code compilé ; les tâches MorrisCode remplacent celles
  d’OpenFox après vérification. Voir `docs/WINDOWS-PRODUCTION.md`.
- **Mise à jour automatique** : les releases signées sont publiées dans le dépôt public
  `morrisdevstudio/morriscode-releases` ; l’application les télécharge et attend le clic
  « Installer et redémarrer ». Voir `docs/AUTO-UPDATE.md`. Une installation manuelle d’une version 0.3.x
  reste nécessaire sur les installations antérieures.
- **Historique** : consolidation des bases OpenFox, MorrisCode et développement dans une nouvelle base,
  avec sauvegardes et conservation séparée des conversations divergentes. Ne jamais utiliser le script
  de remplacement historique pour réunir des conversations indépendantes.

---

# MorrisCode Codebase Guide

> Guidelines for AI coding agents operating in this repository.

## Project Overview

MorrisCode is a local-LLM-first agentic coding assistant. It provides:

- **Core Functionality**: Autonomous coding agent that plans, implements, and verifies tasks using local LLMs
- **Dual Modes**: Planner (task breakdown) → Builder (implementation with verification loop)
- **Real-time Communication**: WebSocket-based protocol for streaming agent thoughts, tool calls, and results
- **Persistence**: SQLite database for sessions, projects, and message history
- **LSP Integration**: Language Server Protocol support for diagnostics across multiple languages

### Tech Stack

- **Backend**: TypeScript, Node.js 24+, Hono/Express, WebSocket, SQLite (better-sqlite3)
- **Frontend**: React 19, TailwindCSS, Zustand, Vite
- **LLM Integration**: OpenAI-compatible API (vLLM, sglang, ollama, llamacpp)
- **Testing**: Vitest (unit + e2e)

### Directory Structure

```
/                     # Root: server code lives here (NOT in ./server/)
  src/                # Server source (tools, agents, workflows, database, websocket)
  web/                # React frontend source
  e2e/                # Vitest e2e tests
  e2e-playwright/     # Playwright e2e tests
  dist/               # Build output
  docs/               # Documentation
```

## Build, Lint, Test Commands

### From Root

```bash
npm run build        # Build server (tsup) + web (vite)
npm run dev          # Start CLI dev server (tsx watch) on port 10469
npm run start        # Start production server
npm run test         # Run all tests (unit + e2e)
npm run test:unit    # Run unit tests only
npm run test:e2e     # Run e2e tests only
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint server code
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier check
npm run format:fix   # Prettier write
npm run check        # typecheck + duplicate detection
npm run duplicate    # Check for duplicate code (server + web)
```

### Dev server

The dev server can already be running. Do not kill it.

Default ports: **10469** (dev), **10369** (prod). The password is `password`.

If it is not running, use the dev_server tool to start it

### Single Test File

```bash
# Server tests
npx vitest run src/tools/read.test.ts
npx vitest run src/tools/read.test.ts -t "test name"  # Specific test

# Web tests
npx vitest run web/src/hooks/usePromptHistory.test.ts
npx vitest run web/src/components/shared/PromptHistory.test.tsx

# Multiple related test files
npx vitest run web/src/hooks/usePromptHistory.test.ts web/src/components/shared/PromptHistory.test.tsx

# Watch mode
npx vitest --watch src/tools/        # Watch server tests
npx vitest --watch web/src/          # Watch web tests
```

### E2E Tests

```bash
cd e2e
npx vitest run                    # Run all e2e tests
npx vitest run protocol.test.ts   # Run specific test

# Verbose mode (shows tool calls, agent thinking, phase transitions)
MORRISCODE_TEST_VERBOSE=true npx vitest run
```

### Testing Workflow

- During development: `npm run test:unit` for quick feedback
- Before considering work done: `npm run test` (full suite must pass)

**Important:** Run both commands without piping to `tail` or `grep` — they're already token-efficient and return errors properly. Grepping hides failure context and leads to wasteful re-runs.

### Git Commands

Precommit hooks take >40s, so always use a 120s timeout when committing:

```bash
git commit -m "message"   # timeout: 120000ms
```

Never skip the hooks unless the user explicitly asks.

### Release

**When asked to publish, read [docs/RELEASE.md](RELEASE.md) and follow the playbook.** It's the single source of truth: changelog generation, version bump, publish, and the merge to `main` (all release work happens on `develop`; `main` only ever receives a successful release).

## Code Conventions

### TypeScript Configuration

Strict mode enabled with:

- `noUncheckedIndexedAccess` - Index access returns `T | undefined`
- `exactOptionalPropertyTypes` - `undefined` not allowed for optional props
- `verbatimModuleSyntax` - Enforces proper import/export syntax
- `noPropertyAccessFromIndexSignature` - Use bracket notation for index signatures

### SVG Icons

All SVG icons must be extracted into `web/src/components/shared/icons/` as reusable components. Each icon gets its own file named `{IconName}Icon.tsx`.

**Forbidden:** Inline `<svg>` elements in component files.

**Allowed exceptions:**

- Complex interactive canvases (e.g., workflow editor diagram)
- Generic pattern components that accept SVG paths as props (e.g., `IconButton`, `ToolIcon`)
- Data visualizations with dynamic content (e.g., `Sparkline`)

**Usage:**

```typescript
import { FolderIcon, CheckIcon, ChevronDownIcon } from './shared/icons'

<FolderIcon className="w-5 h-5 text-accent-primary" />
<CheckIcon />
<ChevronDownIcon rotate={isOpen ? 180 : 0} />
```

### Error Handling

- Custom error classes extend `MorrisCodeError`
- In tools, return result objects instead of throwing:

```typescript
return { success: false, error: error.message, durationMs, truncated: false }
```

### Functional Patterns

- Prefer pure functions, immutability, and composition
- Use Zod for runtime validation of config/external input
- Event sourcing pattern for session state (EventStore)

### Internationalization (en + fr)

All user-facing strings ship in English AND French — no fallback, a missing `fr` entry is a type error.

- Web UI strings go through `useT()`/`t({ en, fr })`; the `jsx-no-literals` lint gate enforces this — never bypass it with a disable.
- The gate flags JSX text, string literals (including `cond ? 'a' : 'b'` and `a && 'b'`) and `aria-label`/`placeholder`/`title`/`alt`. Language-neutral glyphs and acronyms (e.g. `MCP`, `99+`) go in the `allowedStrings` allowlist in `eslint.config.js`, not in `t()`.
- If the gate misses a string shape, extend `eslint/jsx-no-literals.mjs` and add a case to `eslint/jsx-no-literals.test.ts` first.
- Never call `useT()` after a conditional early return — keep hooks at the top of the component.
- Server/CLI use `serverT()`/`cliT()`; LLM-facing, external tool output, and dev-facing strings stay English. Full reference: `docs/I18N.md`.

## Design Principles

### Dumb Client, Smart Server

The web client must be as simple as possible - it renders what the server sends without complex data transformations, joins, or lookups. The server is the single source of truth and normalizes data before sending.

**Rationale:** Other UIs (CLI, mobile, VS Code extension) will be built around the server. Business logic and data shaping belong in the server, not duplicated across clients.

### Streaming/Fetch Parity

Data streamed during real-time operations must be identical in shape to data fetched later (e.g., on page reload). The frontend should use the same rendering code regardless of how data arrived.

**Rationale:** If streaming attaches `toolCall.result` inline, then `session.state` must also have `toolCall.result` attached. No conditional frontend logic to reconcile different data shapes.

### Event Sourcing

Session state is derived from EventStore, not persisted directly:

- All state changes go through events
- EventStore replays events to reconstruct state
- Enables time-travel debugging and audit trails

### Resource Cache (Data Loading)

REST/WS-driven data belongs to the data layer, never a component. Define a
`xxxResource` in `web/src/lib/resources.ts` via the `resource()` factory
(keyed, single-flight, freshness-aware) and consume it through
`useResource`/`useResourceWhen` in `web/src/hooks/`. Mounting the hook loads +
retains the cache entry; unmounting releases it — implicit loadership, no
component `useEffect` fetch.

**Do:**

- Create one resource per data domain (keyed by its scope args) + a thin
  `useXxx(scope)` hook; consumers just subscribe, whoever mounts first loads.
- Write WS payloads and POST/PUT responses through `resource.write(data, ...)`
  so every subscriber converges without refetching (see `mcpServersResource`,
  `boardResource`).
- Keep append-only, unbounded streams (e.g. dev-server logs) in a store with
  rAF batching and a cap — replace-on-fetch resources don't fit streaming.

**Don't:**

- Don't fire fetches from a component `useEffect` — it makes the first consumer
  responsible for loading. Real bug this caused: the compact sidebar showed
  "Aucune config" until the dev-server popover mounted and fetched, because the
  fetch lived in `DevServerFooter`. If a fetch is needed on mount, it belongs in
  the data hook or the resource itself.

### `.morriscode/` Directory Contract

Every file in `.morriscode/` must be **committable** and **meaningful in the project context** — it describes how MorrisCode interacts with _this repository_ for any contributor.

**Belongs in `.morriscode/`:** `dev.json`, `workspace.json`, `commands/*`, `skills/*`, `workflows/*`, `agents/*` — anything that shapes the project's tooling, automation, or agent behavior.

**Does NOT belong:** Personal preferences (model, theme, keybindings, API keys). Those go in the **database** — globally or project-scoped per user.

**Rationale:** Clean repo, no leaked personal config, reliable source of truth for CI and collaborators.

**Workflows:** When asked to create or edit a workflow, load the built-in `workflows` skill via `load_skill("workflows")` — it is the authoritative reference for workflow file format, storage locations (project `.morriscode/workflows/` vs global `{configDir}/workflows/`), the full JSON schema, step types, transition conditions, and template variables ([docs/WORKFLOWS.md](docs/WORKFLOWS.md) is a pointer to it). Project workflows belong in `.morriscode/workflows/` and are committable.

**Plugins:** When asked to create or edit a plugin, read [docs/PLUGINS.md](docs/PLUGINS.md) — the authoritative reference for the `morriscode/plugin` contract (manifest, registry API, UI slots, settings, hooks, RPC, transitions, versioning, trust model). For host internals (lifecycle, install pipeline, wiring) see [docs/PLUGIN-ARCHITECTURE.md](docs/PLUGIN-ARCHITECTURE.md). The reference implementation lives in [examples/hello-plugin](examples/hello-plugin). Plugins run in-process with full trust; never load project-local plugin code from a cloned repo.

## TDD Workflow

When fixing or refactoring: write/update the failing test FIRST, then make it pass.

## Debugging

Need to trace through a session, understand why the agent did something, or find that pesky bug? Check out [docs/SESSION-DEBUGGING.md](SESSION-DEBUGGING.md) — it has everything you need to query the database directly, including DB locations, table schemas, event types, and ready-to-use queries.

**Event handling in nested components:** When a child button is inside a parent with `onClick`, both fire even with `stopPropagation`. Use `e.nativeEvent.stopImmediatePropagation()` to prevent parent handlers.

## Database & Config Locations

|                | Production                              | Development                                 |
| -------------- | --------------------------------------- | ------------------------------------------- |
| **Config dir** | `~/.config/morriscode/`                 | `~/.config/morriscode-dev/`                 |
| **Database**   | `~/.local/share/morriscode/sessions.db` | `~/.local/share/morriscode-dev/sessions.db` |

**Port-based distinction:** Port **10369** is always production. Dev servers start at **10370** and increment (10371, 10372, ...) depending on project startup order (prod proxifies the dev server on its own port + N).

## Production Config

NEVER modify production configuration files (e.g., `~/.config/morriscode/`). These are user-specific and should only be changed by the user.

## Local Network Access & HTTPS

Reaching MorrisCode from other machines on the LAN (bind address + self-signed HTTPS) is documented
in [docs/NETWORK-ACCESS.md](docs/NETWORK-ACCESS.md). The same switches live in Settings → Advanced →
Network, and as CLI flags: `morriscode --network --https`.

HTTPS is served by the same listener as the app: the HTTP(S) server is created before the dev-mode
Vite middleware so Vite can share it for HMR (`server.hmr.server`), and the application WebSocket
only claims upgrades on `/ws` — Vite owns every other upgrade path.
