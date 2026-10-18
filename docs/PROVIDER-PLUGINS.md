# Provider Plugins

MorrisCode supports third-party provider plugins that add new authentication methods and API transports. This document explains the plugin system, how to write a plugin, and how it integrates with the runtime.

---

## Concepts

A provider plugin can contribute three things:

| Contribution          | Interface                  | Purpose                                                                     |
| --------------------- | -------------------------- | --------------------------------------------------------------------------- |
| **Auth adapter**      | `ProviderAuthAdapter`      | Handles authentication flows (OAuth, device code, API key exchange)         |
| **Transport adapter** | `ProviderTransportAdapter` | Implements the API protocol for listing models and making LLM requests      |
| **Preset**            | `ProviderPreset`           | Defines a UI tile in the "Add Provider" wizard with pre-configured defaults |

### Auth adapter

An auth adapter manages identity and credential lifecycle. It:

- Initiates a login flow (e.g., OAuth2 device grant)
- Returns a challenge the user must complete (e.g., visit a URL, enter a code)
- Produces a `credentialRef` — an opaque identifier the runtime stores in config
- Provides access context (tokens, headers) for transport adapters to use
- Supports status checks and logout

### Transport adapter

A transport adapter implements the wire protocol for a specific LLM API. It:

- Lists available models with their capabilities (context window, reasoning efforts, etc.)
- Sends completion requests and streams responses
- Optionally reports the account's metered usage via `getUsage()`, which the UI shows
  next to the provider selector
- Receives a `ProviderRequestContext` with the resolved model, credentials, and metadata

### Preset

A preset is a UI convenience: it appears as a clickable tile in the provider setup wizard, pre-filling the URL, backend, auth adapter, and transport adapter. Users can also configure providers manually via the "Other" tile.

---

## Writing a Plugin

### Package structure

A plugin is an npm package. The runtime discovers plugins in these locations (in order):

1. `{configDirectory}/plugins/` — primary location for user-installed plugins (`~/.config/morriscode/plugins/` in production, `~/.config/morriscode-dev/plugins/` in development)
2. `{cwd}/node_modules/` — for local development
3. The MorrisCode installation's own `node_modules/`

```
my-provider-plugin/
├── package.json
└── index.js          # compiled JS (or .ts loaded via tsx)
```

### Manifest (`package.json`)

The `openfox` field marks the package as a provider plugin:

```json
{
  "name": "@openfox/my-provider-plugin",
  "version": "1.0.0",
  "openfox": {
    "apiVersion": 1,
    "plugin": "./index.js"
  }
}
```

| Field                | Description                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `openfox.apiVersion` | Plugin API version. Must be `1`. Any other value (including `undefined`) causes the plugin to be skipped with a diagnostic error. |
| `openfox.plugin`     | Path to the plugin entry point (relative to package root).                                                                        |

### Entry point

The module must export a `register` function that receives a `ProviderPluginRegistry`:

```typescript
import type { ProviderPluginRegistry } from 'openfox/provider'

export function register(registry: ProviderPluginRegistry) {
  registry.registerAuth(myAuthAdapter)
  registry.registerTransport(myTransportAdapter)
  registry.registerPreset(myPreset)
}
```

The `ProviderPlugin` interface (with `manifest` and `register`) is available for type-checking but the runtime only requires the `register` export. The manifest metadata is declared in `package.json` (see above).

### Interfaces

#### `ProviderAuthAdapter`

```typescript
interface ProviderAuthAdapter {
  readonly id: string

  /** Initiate a login flow. Returns a challenge and a promise that resolves on completion. */
  beginLogin(context: { providerId: string }): Promise<{
    challenge: ProviderLoginChallenge
    completion: Promise<ProviderLoginResult>
  }>

  /** Check the current auth state. */
  getStatus(context: { providerId: string; credentialRef?: string }): Promise<ProviderAuthStatus>

  /** Resolve a credentialRef into an access context (tokens, headers). */
  getAccessContext(credentialRef: string): Promise<ProviderAccessContext>

  /** Revoke credentials and sign out. */
  logout(credentialRef: string): Promise<void>
}
```

#### `ProviderTransportAdapter`

```typescript
interface ProviderTransportAdapter {
  readonly id: string

  /** Fetch the catalog of available models. */
  listModels(context: ProviderRequestContext): Promise<ModelConfig[]>

  /**
   * Optional. Latest metered usage for this account, or `undefined` when the provider
   * does not meter usage — or when nothing has been observed yet. Returning
   * `undefined` rather than throwing keeps the caller simple: no data means nothing
   * to display, and the indicator stays hidden.
   */
  getUsage?(context: ProviderRequestContext): Promise<ProviderUsage | undefined>

  /** Send a non-streaming completion request. */
  complete(request: LLMCompletionRequest, context: ProviderRequestContext): Promise<LLMCompletionResponse>

  /** Stream a completion request. */
  stream(request: LLMCompletionRequest, context: ProviderRequestContext): AsyncIterable<LLMStreamEvent>
}
```

#### `ProviderRequestContext`

```typescript
interface ProviderRequestContext {
  providerId: string
  credentialRef?: string
  auth?: ProviderAccessContext
  model?: string // The API model ID (may differ from catalog ID)
  catalogModel?: string // The catalog-level model ID
  requestBody?: Record<string, unknown>
}
```

`ProviderUsage` describes the metered windows a backend reports — the short slot first,
then the long one — each with `usedPercent` (0-100), an optional `windowMinutes` and an
optional `resetsAt` (epoch seconds), plus the optional plan label and credits. It is
defined in `src/shared/types.ts` and re-exported by `morriscode/provider`. The ChatGPT
provider reads it from the backend's `x-codex-*` response headers and from its
`codex.rate_limits` stream event, so nothing extra has to be requested.

### Security considerations

- Plugins run **in-process** with full access to the Node.js runtime. Only install plugins you trust.
- Credentials are stored via the `credentialRef` system. The runtime stores the ref in config; the plugin is responsible for secure storage of the actual tokens.
- The `credentialRef` is opaque to the runtime — it never inspects or modifies credential data.
- Transport adapters receive `credentialRef` and should call `getAccessContext()` to obtain tokens. The auth adapter controls token lifecycle (refresh, revocation).

---

## Lifecycle

```
MorrisCode starts
  │
  ├── Scan plugins directory for packages with openfox.plugin field
  ├── Validate apiVersion === 1 (skip with diagnostic if not)
  ├── Dynamic import() each plugin entry point
  ├── Call plugin.register(registry)
  │     ├── registry.registerAuth(adapter)
  │     ├── registry.registerTransport(adapter)
  │     └── registry.registerPreset(preset)
  │
  └── ProviderManager uses registry to:
        ├── Resolve preset-backed providers in config
        ├── Create transport-aware LLM clients
        └── Serve auth routes (/api/provider-auth/*)
```

### Plugin loading diagnostics

The server exposes `GET /api/plugins` returning load results:

```json
{
  "plugins": [
    { "packageName": "@openfox/my-plugin", "loaded": true },
    { "packageName": "@openfox/broken-plugin", "loaded": false, "error": "Unsupported apiVersion: 2" }
  ]
}
```

---

## Example: Minimal Plugin

```typescript
import type {
  ProviderAuthAdapter,
  ProviderTransportAdapter,
  ProviderPreset,
  ProviderPluginRegistry,
} from 'openfox/provider'

const auth: ProviderAuthAdapter = {
  id: 'demo-auth',
  async beginLogin() {
    return {
      challenge: {
        mode: 'device',
        verificationUrl: 'https://example.com/device',
        userCode: 'ABCD-1234',
        instructions: 'Visit the URL and enter the code.',
      },
      completion: Promise.resolve({ credentialRef: 'demo-cred-' + Date.now() }),
    }
  },
  async getStatus() {
    return { state: 'connected', accountLabel: 'demo@example.com' }
  },
  async getAccessContext(ref) {
    return { accessToken: 'tok_' + ref, headers: { Authorization: 'Bearer tok_' + ref } }
  },
  async logout() {},
}

const transport: ProviderTransportAdapter = {
  id: 'demo-transport',
  async listModels() {
    return [{ id: 'demo-model', contextWindow: 128000 }]
  },
  async complete(request, context) {
    return { content: 'echo: ' + request.messages[0]?.content, usage: {} }
  },
  async *stream(request, context) {
    yield { type: 'delta', delta: 'hello from demo transport' }
    yield { type: 'done', response: { content: 'hello from demo transport', usage: {} } }
  },
}

const preset: ProviderPreset = {
  id: 'demo',
  name: 'Demo Provider',
  description: 'Example provider plugin',
  requiresAuth: true,
  authAdapter: 'demo-auth',
  transportAdapter: 'demo-transport',
  defaults: { url: 'https://demo.example.com/v1', backend: 'openai' },
}

export function register(registry: ProviderPluginRegistry) {
  registry.registerAuth(auth)
  registry.registerTransport(transport)
  registry.registerPreset(preset)
}
```

---

## Testing a Plugin Locally

1. Build your plugin package
2. Copy it to the plugins directory:
   ```bash
   mkdir -p ~/.config/morriscode-dev/plugins/my-plugin
   cp -r dist/* ~/.config/morriscode-dev/plugins/my-plugin/
   ```
3. Restart MorrisCode (dev mode picks up `~/.config/morriscode-dev/`)
4. Check `GET /api/plugins` for load status
5. The preset appears in the "Add Provider" wizard under the available inference engines
