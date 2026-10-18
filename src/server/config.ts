import { z } from 'zod'
import type { Config, LlmBackend } from '../shared/types.js'

const backendSchema = z.enum(['vllm', 'sglang', 'ollama', 'llamacpp', 'unknown']).default('unknown')

const envSchema = z.object({
  // MORRISCODE_VLLM_URL is the deprecated alias of MORRISCODE_LLM_URL.
  MORRISCODE_LLM_URL: z.string().url().optional(),
  MORRISCODE_VLLM_URL: z.string().url().optional(),
  MORRISCODE_BACKEND: backendSchema,
  MORRISCODE_MODEL_NAME: z.string().default(''),
  MORRISCODE_MAX_CONTEXT: z.coerce.number().default(200000),
  MORRISCODE_PORT: z.coerce.number().default(10369),
  MORRISCODE_HOST: z.string().optional(),
  // Kept as a string so "0"/"false" don't trip z.coerce.boolean(), which treats any
  // non-empty string as true.
  MORRISCODE_HTTPS: z
    .string()
    .optional()
    .transform((value) => value !== undefined && !['', '0', 'false', 'no'].includes(value.toLowerCase())),
  MORRISCODE_HTTPS_CERT: z.string().optional(),
  MORRISCODE_HTTPS_KEY: z.string().optional(),
  MORRISCODE_WORKDIR: z.string().optional(),
  MORRISCODE_DB_PATH: z.string().default('./morriscode.db'),
  MORRISCODE_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  MORRISCODE_REASONING_EFFORT: z.string().optional(),
  // Deprecated: use MORRISCODE_REASONING_EFFORT=none instead
  MORRISCODE_DISABLE_THINKING: z.coerce.boolean().default(false),
  MORRISCODE_LLM_TIMEOUT: z.coerce.number().default(300_000),
  MORRISCODE_LLM_IDLE_TIMEOUT: z.coerce.number().default(300_000),
  MORRISCODE_DEV: z.coerce.boolean().default(false),
  MORRISCODE_DISABLE_AUTO_SESSION_TITLE: z.coerce.boolean().optional(),
  MORRISCODE_DEFAULT_AGENT: z.string().optional(),
})

export function loadConfig(): Config {
  const env = envSchema.parse(process.env)

  // Prefer the explicit URL, then the deprecated alias, then the local default.
  const llmUrl = env.MORRISCODE_LLM_URL ?? env.MORRISCODE_VLLM_URL ?? 'http://localhost:8000/v1'

  // Workdir from env only (serve.ts will merge with global config)
  const workdir = env.MORRISCODE_WORKDIR ?? process.cwd()

  return {
    llm: {
      baseUrl: llmUrl,
      model: env.MORRISCODE_MODEL_NAME,
      timeout: env.MORRISCODE_LLM_TIMEOUT,
      idleTimeout: env.MORRISCODE_LLM_IDLE_TIMEOUT,
      backend: env.MORRISCODE_BACKEND as LlmBackend,
      ...(env.MORRISCODE_REASONING_EFFORT
        ? { reasoningEffort: env.MORRISCODE_REASONING_EFFORT }
        : env.MORRISCODE_DISABLE_THINKING
          ? { reasoningEffort: 'none' }
          : {}),
    },
    context: {
      maxTokens: env.MORRISCODE_MAX_CONTEXT,
      compactionThreshold: 0.85,
      compactionTarget: 0.6,
    },
    agent: {
      maxIterations: 10,
      maxConsecutiveFailures: 3,
      toolTimeout: 300_000,
    },
    server: {
      port: env.MORRISCODE_PORT,
      ...(env.MORRISCODE_HOST !== undefined ? { host: env.MORRISCODE_HOST } : {}),
      ...(env.MORRISCODE_HTTPS ? { https: true } : {}),
      ...(env.MORRISCODE_HTTPS_CERT !== undefined ? { httpsCert: env.MORRISCODE_HTTPS_CERT } : {}),
      ...(env.MORRISCODE_HTTPS_KEY !== undefined ? { httpsKey: env.MORRISCODE_HTTPS_KEY } : {}),
    },
    database: {
      path: env.MORRISCODE_DB_PATH,
    },
    mode: env.MORRISCODE_DEV ? 'development' : 'production',
    workdir,
    ...(env.MORRISCODE_DISABLE_AUTO_SESSION_TITLE !== undefined
      ? { disableAutoSessionTitle: env.MORRISCODE_DISABLE_AUTO_SESSION_TITLE }
      : {}),
    ...(env.MORRISCODE_DEFAULT_AGENT !== undefined ? { defaultAgent: env.MORRISCODE_DEFAULT_AGENT } : {}),
  }
}

export type { Config }
