import { asRecord, toNumber } from '../../usage-values.js'
import WebSocket from 'ws'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { ToolCall, ModelConfig } from '../../../../../provider/index.js'
import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMMessage,
  LLMStreamEvent,
  LLMToolDefinition,
} from '../../../../../provider/index.js'
import type {
  ProviderAuthAdapter,
  ProviderRequestContext,
  ProviderTransportAdapter,
  ProviderUsage,
  ProviderUsageWindow,
} from '../../../../../provider/index.js'
import { logger } from '../../../../utils/logger.js'
import { fetchCodexModels } from '../catalog/models-dev.js'
import type { ProviderResetCredits } from '../../../../../shared/types.js'
import { parseResetCredits, readResetCredits } from './reset-credits.js'
import { TEXT_MIME_EXACT, TEXT_MIME_PREFIXES } from '../../../../../shared/constants.js'
import { decodeDataUrl } from '../../../../utils/data-url.js'

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const RESPONSES_LITE_MODEL = 'gpt-5.6-luna'
const CODEX_COMPATIBILITY_VERSION = '0.144.0'
const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'
const RESPONSES_WEBSOCKET_PROTOCOL = 'responses_websockets=2026-02-06'
const RESPONSES_LITE_CLIENT_METADATA = 'ws_request_header_x_openai_internal_codex_responses_lite'

interface RateLimitEventWindow {
  used_percent?: number
  window_minutes?: number
  reset_at?: number
}

interface CodexSseEvent {
  type: string
  message?: string
  error?: { message?: string; code?: string }
  plan_type?: string
  limit_name?: string
  metered_limit_name?: string
  rate_limits?: { primary?: RateLimitEventWindow; secondary?: RateLimitEventWindow }
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string }
  response?: {
    id?: string
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    status?: string
    error?: { message?: string; code?: string }
    incomplete_details?: { reason?: string }
  }
  delta?: string
  item?: {
    id?: string
    type?: string
    name?: string
    call_id?: string
    arguments?: string
    content?: Array<{ type?: string; text?: string }>
  }
  output_index?: number
}

export interface CodexTransportOptions {
  endpoint?: string
  fetch?: typeof fetch
  websocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket
}

export class CodexTransportAdapter implements ProviderTransportAdapter {
  readonly id = 'openai-codex'
  private readonly endpoint: string
  private readonly request: typeof fetch
  private readonly websocketFactory: (url: string, options: WebSocket.ClientOptions) => WebSocket

  constructor(
    private readonly auth: ProviderAuthAdapter,
    options: CodexTransportOptions = {},
  ) {
    this.endpoint = options.endpoint ?? CODEX_RESPONSES_URL
    this.request = options.fetch ?? fetch
    this.websocketFactory = options.websocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions))
  }

  private usage = new Map<string, ProviderUsage>()
  private resetCreditCache = new Map<string, { observedAt: number; value: ProviderResetCredits | undefined }>()

  /**
   * Latest metered usage for this account. Asks the backend directly, so the numbers
   * are there as soon as the provider is selected — and keeps whatever the last
   * response carried when that call fails.
   */
  async getUsage(context: ProviderRequestContext): Promise<ProviderUsage | undefined> {
    const observed = this.usageSnapshot(context)
    if (!context.credentialRef) return observed
    const cacheKey = context.credentialRef
    const cachedResets = this.resetCreditCache.get(cacheKey)
    const usageFresh = !!observed?.observedAt && Date.now() - observed.observedAt < USAGE_REFRESH_MS
    const resetsFresh = !!cachedResets && Date.now() - cachedResets.observedAt < USAGE_REFRESH_MS
    const withResets = (usage: ProviderUsage | undefined, resets: ProviderResetCredits | undefined) =>
      usage || resets
        ? {
            ...usage,
            windows: usage?.windows ?? [],
            resetCredits: resets ?? usage?.resetCredits ?? { availableCount: null },
          }
        : undefined
    if (usageFresh && resetsFresh) return withResets(observed, cachedResets.value)

    try {
      const access = await this.auth.getAccessContext(context.credentialRef)
      const [usageResult, resets] = await Promise.all([
        usageFresh
          ? Promise.resolve(observed)
          : this.request(USAGE_URL, {
              method: 'GET',
              headers: { Accept: 'application/json', ...access.headers },
              redirect: 'error',
              signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
            })
              .then(async (response) => (response.ok ? parseWhamUsage(await response.json()) : undefined))
              .catch(() => undefined),
        resetsFresh ? Promise.resolve(cachedResets.value) : readResetCredits(access.headers ?? {}, this.request),
      ])
      if (!resetsFresh) this.resetCreditCache.set(cacheKey, { observedAt: Date.now(), value: resets })
      if (usageResult && !usageFresh) this.captureUsage(usageResult, context)
      return withResets(usageResult ?? observed, resets)
    } catch (error) {
      logger.warn('ChatGPT usage query failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return observed
    }
  }

  private usageSnapshot(context: ProviderRequestContext): ProviderUsage | undefined {
    const usage = this.usage.get(context.credentialRef ?? context.providerId)
    if (!usage) return undefined
    return { ...usage, windows: usage.windows.map((window) => ({ ...window })) }
  }

  private captureUsage(usage: ProviderUsage | undefined, context: ProviderRequestContext): void {
    if (!usage) return
    this.usage.set(context.credentialRef ?? context.providerId, { ...usage, observedAt: Date.now() })
  }

  async listModels(): Promise<ModelConfig[]> {
    try {
      return await fetchCodexModels(this.request)
    } catch (error) {
      // The fixed list below is a last resort, not a catalog: say so in the log, so an
      // outdated model list is never mistaken for the provider's real offer.
      logger.warn('ChatGPT model catalog unavailable, using the fixed fallback list', {
        error: error instanceof Error ? error.message : String(error),
      })
      return [
        { id: 'gpt-5.4', contextWindow: 1050000, source: 'default' },
        { id: 'gpt-5.3-codex', contextWindow: 400000, source: 'default' },
        { id: 'gpt-5.3-codex-spark', contextWindow: 128000, source: 'default' },
      ]
    }
  }

  async complete(request: LLMCompletionRequest, context: ProviderRequestContext): Promise<LLMCompletionResponse> {
    let result: LLMCompletionResponse | undefined
    for await (const event of this.stream(request, context)) {
      if (event.type === 'done') result = event.response
      if (event.type === 'error') throw new Error(event.error)
    }
    if (!result) throw new Error('Codex response completed without a final response')
    return result
  }

  async *stream(request: LLMCompletionRequest, context: ProviderRequestContext): AsyncIterable<LLMStreamEvent> {
    if (!context.credentialRef) {
      yield { type: 'error', error: 'OpenAI account is not connected' }
      return
    }

    try {
      const access = await this.auth.getAccessContext(context.credentialRef)
      const model = context.model ?? 'gpt-5.2-codex'
      const sessionId = crypto.randomUUID()
      const codexRequest = buildCodexRequest(request, model, context.requestBody)
      const isResponsesLite = model === RESPONSES_LITE_MODEL
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...access.headers,
        ...(isResponsesLite && {
          'session-id': sessionId,
          'x-session-affinity': sessionId,
          version: CODEX_COMPATIBILITY_VERSION,
          [RESPONSES_LITE_HEADER]: 'true',
        }),
      }
      const preparedRequest = isResponsesLite ? prepareResponsesLiteRequest(codexRequest, sessionId) : codexRequest
      const response = isResponsesLite
        ? await this.requestResponsesLiteWithRetry(preparedRequest, headers, request.signal)
        : await this.request(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(preparedRequest),
            ...(request.signal && { signal: request.signal }),
          })
      // Read the usage off every response, including the failing ones: a 429 is
      // exactly the moment those numbers matter.
      this.captureUsage(parseRateLimitHeaders(response.headers), context)
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(`Codex HTTP ${response.status}: ${detail}`)
      }
      if (!response.body) throw new Error('Codex response has no stream body')

      let responseId = ''
      let content = ''
      let thinking = ''
      let completed = false
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      const calls = new Map<number, { id: string; name: string; arguments: string }>()

      for await (const event of parseSse(response.body)) {
        this.captureUsage(usageFromEvent(event), context)
        if (
          event.type === 'error' ||
          event.type === 'response.failed' ||
          event.type === 'response.incomplete' ||
          (event.type === 'response.completed' && event.response?.status && event.response.status !== 'completed')
        ) {
          const detail =
            event.response?.error?.message ??
            event.error?.message ??
            event.message ??
            event.response?.incomplete_details?.reason ??
            event.response?.error?.code ??
            event.error?.code ??
            event.response?.status ??
            event.type
          throw new Error(`Codex stream failed: ${detail}`)
        }
        if (event.response?.id) responseId = event.response.id
        if (event.response?.usage) {
          usage = {
            promptTokens: event.response.usage.input_tokens ?? 0,
            completionTokens: event.response.usage.output_tokens ?? 0,
            totalTokens:
              event.response.usage.total_tokens ??
              (event.response.usage.input_tokens ?? 0) + (event.response.usage.output_tokens ?? 0),
          }
        }

        if (event.type === 'response.output_text.delta' && event.delta) {
          content += event.delta
          yield { type: 'text_delta', content: event.delta }
        }
        if (event.type === 'response.reasoning_summary_text.delta' && event.delta) {
          thinking += event.delta
          yield { type: 'thinking_delta', content: event.delta }
        }
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          const index = event.output_index ?? calls.size
          const call = {
            id: event.item.call_id ?? event.item.id ?? '',
            name: event.item.name ?? '',
            arguments: event.item.arguments ?? '',
          }
          calls.set(index, call)
          yield {
            type: 'tool_call_delta',
            index,
            ...(call.id && { id: call.id }),
            ...(call.name && { name: call.name }),
            ...(call.arguments && { arguments: call.arguments }),
          }
        }
        if (event.type === 'response.function_call_arguments.delta' && event.delta) {
          const index = event.output_index ?? 0
          const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
          call.arguments += event.delta
          calls.set(index, call)
          yield { type: 'tool_call_delta', index, arguments: event.delta }
        }
        if (event.type === 'response.completed') {
          completed = true
          break
        }
      }

      if (!completed) throw new Error('Codex stream ended without response.completed confirmation')
      const toolCalls = parseToolCalls(calls)
      yield {
        type: 'done',
        response: {
          id: responseId,
          content: content.trim(),
          ...(thinking.trim() && { thinkingContent: thinking.trim() }),
          ...(toolCalls.length && { toolCalls }),
          finishReason: toolCalls.length ? 'tool_calls' : 'stop',
          usage,
        },
      }
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async requestResponsesLiteWithRetry(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.requestResponsesLiteOverWebSocket(body, headers, signal)
      } catch (error) {
        const status = error instanceof CodexWebSocketHandshakeError ? error.status : undefined
        const retryable = status === 502 || status === 503 || status === 504
        if (!retryable || attempt === maxAttempts || signal?.aborted) throw error
        await delay(250 * 2 ** (attempt - 1), signal)
      }
    }
    throw new Error('Codex WebSocket retry loop completed unexpectedly')
  }

  private requestResponsesLiteOverWebSocket(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const websocketUrl = this.endpoint.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
    const socket = this.websocketFactory(websocketUrl, {
      headers: {
        ...headers,
        'openai-beta': RESPONSES_WEBSOCKET_PROTOCOL,
      },
    })
    const encoder = new TextEncoder()

    return new Promise<Response>((resolve, reject) => {
      let opened = false
      let settled = false

      const cleanupBeforeOpen = () => {
        socket.off('open', onOpen)
        socket.off('error', onInitialError)
        socket.off('close', onInitialClose)
        socket.off('unexpected-response', onUnexpectedResponse)
        signal?.removeEventListener('abort', onAbortBeforeOpen)
      }
      const onInitialError = (error: Error) => {
        if (settled) return
        settled = true
        cleanupBeforeOpen()
        reject(error)
      }
      const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage) => {
        if (settled) return
        settled = true
        cleanupBeforeOpen()
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          const detail = Buffer.concat(chunks).toString('utf8').trim()
          reject(new CodexWebSocketHandshakeError(response.statusCode ?? 0, detail))
        })
        response.on('error', (error: Error) => reject(error))
      }
      const onInitialClose = (code: number, reason: Buffer) => {
        if (opened || settled) return
        settled = true
        cleanupBeforeOpen()
        reject(
          new Error(`Codex WebSocket closed before open (${code}${reason.length ? `: ${reason.toString()}` : ''})`),
        )
      }
      const onAbortBeforeOpen = () => {
        if (settled) return
        settled = true
        cleanupBeforeOpen()
        socket.terminate()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const onOpen = () => {
        opened = true
        cleanupBeforeOpen()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let completed = false
            const finish = () => {
              if (completed) return
              completed = true
              cleanup()
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
              socket.close()
            }
            const fail = (error: Error) => {
              if (completed) return
              completed = true
              cleanup()
              controller.error(error)
              socket.terminate()
            }
            const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
              if (isBinary) {
                fail(new Error('Unexpected binary Codex WebSocket frame'))
                return
              }
              const text = data.toString()
              let event: Record<string, unknown>
              try {
                event = JSON.parse(text) as Record<string, unknown>
              } catch {
                fail(new Error('Invalid Codex WebSocket event'))
                return
              }
              if (event['type'] === 'error') {
                const nested = isRecord(event['error']) ? event['error'] : undefined
                const message = typeof nested?.['message'] === 'string' ? nested['message'] : text
                fail(new Error(message))
                return
              }
              controller.enqueue(encoder.encode(`data: ${text}\n\n`))
              if (
                event['type'] === 'response.completed' ||
                event['type'] === 'response.done' ||
                event['type'] === 'response.failed' ||
                event['type'] === 'response.incomplete'
              ) {
                finish()
              }
            }
            const onError = (error: Error) => fail(error)
            const onClose = (code: number, reason: Buffer) => {
              if (!completed)
                fail(
                  new Error(
                    `Codex WebSocket closed before completion (${code}${reason.length ? `: ${reason.toString()}` : ''})`,
                  ),
                )
            }
            const onAbort = () => fail(new DOMException('Aborted', 'AbortError'))
            const cleanup = () => {
              socket.off('message', onMessage)
              socket.off('error', onError)
              socket.off('close', onClose)
              signal?.removeEventListener('abort', onAbort)
            }

            socket.on('message', onMessage)
            socket.once('error', onError)
            socket.once('close', onClose)
            signal?.addEventListener('abort', onAbort, { once: true })

            const { stream: _stream, background: _background, ...payload } = body
            socket.send(
              JSON.stringify({
                type: 'response.create',
                ...payload,
                client_metadata: {
                  ...(isRecord(payload['client_metadata']) ? payload['client_metadata'] : {}),
                  [RESPONSES_LITE_CLIENT_METADATA]: 'true',
                },
              }),
              (error) => {
                if (error) fail(error)
              },
            )
          },
          cancel() {
            socket.terminate()
          },
        })
        settled = true
        resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
      }

      socket.once('open', onOpen)
      socket.once('error', onInitialError)
      socket.once('close', onInitialClose)
      socket.once('unexpected-response', onUnexpectedResponse)
      signal?.addEventListener('abort', onAbortBeforeOpen, { once: true })
    })
  }
}

function buildCodexRequest(
  request: LLMCompletionRequest,
  model: string,
  catalogRequestBody?: Record<string, unknown>,
): Record<string, unknown> {
  for (const message of request.messages) {
    if (message.attachments?.length && message.role !== 'user') {
      throw new Error(`Codex attachments are unsupported for ${message.role} messages`)
    }
  }
  const instructions = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const input = request.messages.filter((message) => message.role !== 'system').flatMap(toCodexInputItems)

  const catalogReasoning = isRecord(catalogRequestBody?.['reasoning']) ? catalogRequestBody['reasoning'] : undefined
  const requestBody: Record<string, unknown> = {
    ...(catalogRequestBody ?? {}),
    model,
    stream: true,
    store: false,
    instructions,
    input,
    tools: request.tools?.map(toCodexTool) ?? [],
    tool_choice: request.toolChoice ?? 'auto',
    ...(request.maxTokens && { max_output_tokens: request.maxTokens }),
  }

  if (catalogReasoning || request.reasoningEffort) {
    requestBody['reasoning'] = {
      ...(catalogReasoning ?? {}),
      ...(request.reasoningEffort && { effort: request.reasoningEffort }),
    }
  }

  return requestBody
}

function prepareResponsesLiteRequest(request: Record<string, unknown>, sessionId: string): Record<string, unknown> {
  const input = Array.isArray(request['input']) ? structuredClone(request['input']) : []
  const tools = Array.isArray(request['tools']) ? structuredClone(request['tools']) : []
  const instructions = typeof request['instructions'] === 'string' ? request['instructions'] : ''

  stripImageDetail(input)

  const prepared: Record<string, unknown> = {
    ...request,
    input: [
      { type: 'additional_tools', role: 'developer', tools },
      ...(instructions
        ? [
            {
              type: 'message',
              role: 'developer',
              content: [{ type: 'input_text', text: instructions }],
            },
          ]
        : []),
      ...input,
    ],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    prompt_cache_key: sessionId,
    reasoning: {
      ...(isRecord(request['reasoning']) ? request['reasoning'] : {}),
      context: 'all_turns',
    },
  }

  delete prepared['tools']
  delete prepared['instructions']
  delete prepared['max_output_tokens']
  return prepared
}

function stripImageDetail(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripImageDetail(item)
    return
  }
  if (!isRecord(value)) return
  if (value['type'] === 'input_image') delete value['detail']
  for (const item of Object.values(value)) stripImageDetail(item)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toCodexInputItems(message: LLMMessage): Record<string, unknown>[] {
  if (message.role === 'tool') {
    return [{ type: 'function_call_output', call_id: message.toolCallId ?? '', output: message.content }]
  }
  if (message.role === 'assistant') {
    const items: Record<string, unknown>[] = []
    if (message.content) {
      items.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
    }
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })
    }
    return items
  }
  const content: Record<string, unknown>[] = [{ type: 'input_text', text: message.content }]
  for (const attachment of message.attachments ?? []) {
    const { mimeType, data, filename } = attachment
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
      if (!data.startsWith(`data:${mimeType};base64,`) || !decodeDataUrl(data)?.length) {
        throw new Error(`Invalid Codex image attachment: ${filename}`)
      }
      content.push({ type: 'input_image', image_url: data })
    } else if (TEXT_MIME_EXACT.includes(mimeType) || TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
      content.push({
        type: 'input_text',
        text: `[File: ${filename}]\n${decodeDataUrl(data)?.toString('utf8') ?? data}`,
      })
    } else {
      throw new Error(`Unsupported Codex attachment type: ${mimeType} (${filename})`)
    }
  }
  return [{ role: message.role, content }]
}

function toCodexTool(tool: LLMToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }
}

const RATE_LIMIT_HEADER_PREFIX = 'x-codex'
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const USAGE_REFRESH_MS = 30_000
const USAGE_REQUEST_TIMEOUT_MS = 15_000

function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)
  if (raw === null) return undefined
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : undefined
}

function windowFromHeaders(headers: Headers, side: 'primary' | 'secondary'): ProviderUsageWindow | undefined {
  const usedPercent = numericHeader(headers, `${RATE_LIMIT_HEADER_PREFIX}-${side}-used-percent`)
  if (usedPercent === undefined) return undefined
  const windowMinutes = numericHeader(headers, `${RATE_LIMIT_HEADER_PREFIX}-${side}-window-minutes`)
  const resetsAt = numericHeader(headers, `${RATE_LIMIT_HEADER_PREFIX}-${side}-reset-at`)
  return {
    usedPercent,
    ...(windowMinutes !== undefined && { windowMinutes }),
    ...(resetsAt !== undefined && { resetsAt }),
  }
}

function collectWindows(...candidates: (ProviderUsageWindow | undefined)[]): ProviderUsageWindow[] {
  return candidates.filter((window): window is ProviderUsageWindow => window !== undefined)
}

function windowFromEvent(window: RateLimitEventWindow | undefined): ProviderUsageWindow | undefined {
  if (!window || typeof window.used_percent !== 'number') return undefined
  return {
    usedPercent: window.used_percent,
    ...(typeof window.window_minutes === 'number' && { windowMinutes: window.window_minutes }),
    ...(typeof window.reset_at === 'number' && { resetsAt: window.reset_at }),
  }
}

function usageFromEvent(event: CodexSseEvent): ProviderUsage | undefined {
  if (event.type !== 'codex.rate_limits') return undefined
  const windows = collectWindows(
    windowFromEvent(event.rate_limits?.primary),
    windowFromEvent(event.rate_limits?.secondary),
  )
  const credits = event.credits
  const planType = event.plan_type ?? event.limit_name ?? event.metered_limit_name
  if (windows.length === 0 && !credits && !planType) return undefined
  return {
    windows,
    ...(planType ? { planType } : {}),
    ...(credits
      ? {
          credits: {
            hasCredits: credits.has_credits ?? false,
            unlimited: credits.unlimited ?? false,
            ...(credits.balance ? { balance: credits.balance } : {}),
          },
        }
      : {}),
  }
}

/** One window of the `wham/usage` payload: percentages and a length in seconds. */
function windowFromWham(value: unknown): ProviderUsageWindow | undefined {
  const row = asRecord(value)
  const usedPercent = toNumber(row?.['used_percent'])
  if (!row || usedPercent === undefined) return undefined
  const seconds = toNumber(row['limit_window_seconds'])
  const resetsAt = toNumber(row['reset_at'])
  return {
    usedPercent,
    ...(seconds !== undefined && { windowMinutes: seconds / 60 }),
    ...(resetsAt !== undefined && { resetsAt }),
  }
}

/**
 * The ChatGPT backend answers `/wham/usage` with the same two metered windows the
 * responses carry, so the numbers can be shown before any message is sent. Shape per
 * the Codex CLI and opencodex parses of that endpoint.
 */
export function parseWhamUsage(payload: unknown): ProviderUsage | undefined {
  const root = asRecord(payload)
  const rateLimit = asRecord(root?.['rate_limit'])
  const windows = collectWindows(
    windowFromWham(rateLimit?.['primary_window']),
    windowFromWham(rateLimit?.['secondary_window']),
  )
  const credits = asRecord(root?.['credits'])
  const resetCredits = parseResetCredits(root?.['rate_limit_reset_credits'])
  const planType = typeof root?.['plan_type'] === 'string' ? root['plan_type'] : undefined
  if (windows.length === 0 && !credits && !planType && !resetCredits) return undefined
  return {
    windows,
    ...(resetCredits ? { resetCredits } : {}),
    ...(planType ? { planType } : {}),
    ...(credits
      ? {
          credits: {
            hasCredits: credits['has_credits'] === true,
            unlimited: credits['unlimited'] === true,
            ...(typeof credits['balance'] === 'string' ? { balance: credits['balance'] } : {}),
          },
        }
      : {}),
  }
}

/**
 * The ChatGPT backend reports metered usage in `x-codex-*` response headers: the
 * short slot in `primary`, the week in `secondary`. Mirrors the header family the
 * Codex CLI parses (openai/codex, `codex-rs/codex-api/src/rate_limits.rs`).
 */
export function parseRateLimitHeaders(headers: Headers): ProviderUsage | undefined {
  const windows = collectWindows(windowFromHeaders(headers, 'primary'), windowFromHeaders(headers, 'secondary'))
  if (windows.length === 0) return undefined
  const limitName = headers.get(`${RATE_LIMIT_HEADER_PREFIX}-limit-name`)
  return { windows, ...(limitName ? { planType: limitName } : {}) }
}

/** Same windows, delivered as a `codex.rate_limits` stream event. */
export function parseRateLimitEvent(payload: string): ProviderUsage | undefined {
  try {
    return usageFromEvent(JSON.parse(payload) as CodexSseEvent)
  } catch {
    return undefined
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<CodexSseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
        if (data === '[DONE]') return
        if (!data) continue
        yield JSON.parse(data) as CodexSseEvent
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function parseToolCalls(calls: Map<number, { id: string; name: string; arguments: string }>): ToolCall[] {
  return [...calls.values()].map((call) => {
    try {
      return { id: call.id, name: call.name, arguments: JSON.parse(call.arguments || '{}') as Record<string, unknown> }
    } catch (error) {
      return {
        id: call.id,
        name: call.name,
        arguments: {},
        parseError: error instanceof Error ? error.message : 'Invalid JSON',
        rawArguments: call.arguments,
      }
    }
  })
}

class CodexWebSocketHandshakeError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Codex WebSocket handshake failed (${status})${detail ? `: ${detail}` : ''}`)
    this.name = 'CodexWebSocketHandshakeError'
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}
