import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const HOST = process.env.PROXY_HOST || '127.0.0.1'
const PORT = Number.parseInt(process.env.PROXY_PORT || '11435', 10)
const OPENROUTER_BASE_URL = (
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
).replace(/\/+$/, '')
// Model used for background Claude Code calls that send bare claude-* names.
// These internal names (e.g. claude-haiku-4-5-20251001) are not valid on OpenRouter.
const DEFAULT_MODEL = process.env.PROXY_DEFAULT_MODEL || 'google/gemini-2.5-flash-lite'
const LOG_FILE = 'proxy.log'
const ERR_LOG_FILE = 'proxy.err.log'

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(message, extra) {
  const timestamp = new Date().toISOString()
  const line =
    extra === undefined
      ? `[${timestamp}] ${message}`
      : `[${timestamp}] ${message} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`
  console.log(line)
  appendFileSync(LOG_FILE, `${line}\n`)
}

function logError(message, error) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message} ${error?.stack || error?.message || String(error)}`
  console.error(line)
  appendFileSync(ERR_LOG_FILE, `${line}\n`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function getOpenRouterApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error('Set OPENROUTER_API_KEY before starting the proxy.')
  }
  return apiKey
}

/**
 * Map bare model names to OpenRouter's provider/model format.
 * - provider/model → unchanged (already correct)
 * - gemini-*       → google/gemini-*
 * - claude-*       → DEFAULT_MODEL (Claude Code's internal names like
 *                    claude-haiku-4-5-20251001 are not valid OpenRouter IDs)
 * - anything else  → DEFAULT_MODEL
 */
function toOpenRouterModel(model) {
  if (!model) return DEFAULT_MODEL
  const s = String(model)
  if (s.includes('/')) return s
  if (s.startsWith('gemini-')) return `google/${s}`
  return DEFAULT_MODEL
}

function writeJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function writeAnthropicError(res, statusCode, message, requestId) {
  writeJson(
    res,
    statusCode,
    { type: 'error', error: { type: 'api_error', message }, request_id: requestId },
    { 'x-request-id': requestId },
  )
}

function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function summarizeToolResultContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (block?.type === 'text') return block.text
      if (block?.type === 'image') return '[image omitted]'
      if (block?.type === 'document') return '[document omitted]'
      return JSON.stringify(block)
    })
    .join('\n\n')
    .trim()
}

function flattenSystemPrompt(system) {
  if (!system) return undefined
  if (typeof system === 'string') return system.trim() || undefined
  if (!Array.isArray(system)) return undefined
  const text = system
    .map(block =>
      typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : '',
    )
    .filter(Boolean)
    .join('\n\n')
    .trim()
  return text || undefined
}

// ─── Anthropic → OpenAI-chat format ──────────────────────────────────────────

function anthropicMessagesToOpenAI(messages, system) {
  const out = []

  const systemText = flattenSystemPrompt(system)
  if (systemText) out.push({ role: 'system', content: systemText })

  for (const message of messages || []) {
    const { role, content } = message
    const blocks =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content || []

    if (role === 'assistant') {
      const textParts = []
      const toolCalls = []
      for (const block of blocks) {
        if (block?.type === 'text' && block.text) textParts.push(block.text)
        else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          })
        }
      }
      const msg = { role: 'assistant' }
      if (textParts.length > 0) msg.content = textParts.join('\n')
      if (toolCalls.length > 0) msg.tool_calls = toolCalls
      if (msg.content !== undefined || msg.tool_calls !== undefined) out.push(msg)
    } else {
      const textParts = []
      const toolResults = []
      for (const block of blocks) {
        if (block?.type === 'tool_result') toolResults.push(block)
        else if (block?.type === 'text' && block.text) textParts.push(block.text)
      }
      if (textParts.length > 0) out.push({ role: 'user', content: textParts.join('\n') })
      for (const result of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content: summarizeToolResultContent(result.content) || '',
        })
      }
    }
  }

  return out
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out = []
  for (const tool of tools) {
    if (typeof tool?.type === 'string' && tool.type.startsWith('web_search_')) continue
    if (!tool?.name || !tool?.input_schema) continue
    out.push({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    })
  }
  return out.length > 0 ? out : undefined
}

function anthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice) return undefined
  switch (toolChoice.type) {
    case 'auto': return 'auto'
    case 'any': return 'required'
    case 'none': return 'none'
    case 'tool': return { type: 'function', function: { name: toolChoice.name } }
    default: return 'auto'
  }
}

function buildChatRequest(body) {
  const messages = anthropicMessagesToOpenAI(body.messages, body.system)
  const tools = anthropicToolsToOpenAI(body.tools)
  const toolChoice = tools ? anthropicToolChoiceToOpenAI(body.tool_choice) : undefined

  const request = { model: body.model, messages }
  if (typeof body.max_tokens === 'number') request.max_tokens = body.max_tokens
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    request.stop = body.stop_sequences
  }
  if (tools) request.tools = tools
  if (toolChoice !== undefined) request.tool_choice = toolChoice

  return request
}

// ─── OpenRouter transport ────────────────────────────────────────────────────

async function postOpenRouter(path, body) {
  const response = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${getOpenRouterApiKey()}`,
      'http-referer': process.env.OPENROUTER_REFERER || 'http://localhost',
      'x-title': process.env.OPENROUTER_TITLE || 'WrapdCode',
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let data = {}
  if (text) {
    try { data = JSON.parse(text) } catch { data = { raw: text } }
  }

  if (!response.ok) {
    const message = data?.error?.message || text || `${response.status} ${response.statusText}`
    const error = new Error(message)
    error.statusCode = response.status
    throw error
  }

  return { data }
}

// ─── OpenAI-chat → Anthropic format ──────────────────────────────────────────

function chatResponseToAnthropic({ requestedModel, openAIResponse, requestId }) {
  const choice = openAIResponse?.choices?.[0]
  if (!choice) throw new Error('OpenRouter returned no choices.')

  const content = []
  const msg = choice.message

  if (msg.content) content.push({ type: 'text', text: msg.content })

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {}
      try { input = JSON.parse(tc.function?.arguments || '{}') } catch {}
      content.push({
        type: 'tool_use',
        id: tc.id || randomUUID(),
        name: tc.function?.name || '',
        input,
      })
    }
  }

  if (content.length === 0) content.push({ type: 'text', text: '' })

  const finishReason = choice.finish_reason
  let stopReason = 'end_turn'
  if (finishReason === 'length') stopReason = 'max_tokens'
  else if (finishReason === 'tool_calls') stopReason = 'tool_use'

  const usage = openAIResponse.usage || {}

  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
    },
    _request_id: requestId,
  }
}

// ─── SSE streaming ───────────────────────────────────────────────────────────

function streamAnthropicMessage(res, message, requestId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': requestId,
  })

  sendSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })

  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      sendSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })
      if (block.text) {
        sendSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        })
      }
      sendSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
      return
    }

    if (block.type === 'tool_use') {
      sendSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })
      sendSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
      })
      sendSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
    }
  })

  sendSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: {
      input_tokens: 0,
      output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })

  sendSseEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

// ─── Request handlers ─────────────────────────────────────────────────────────

async function handleMessages(req, res, body) {
  const requestId = `req_${randomUUID()}`
  const requestedModel = body.model
  const orModel = toOpenRouterModel(requestedModel)

  log(`messages request -> openrouter:${orModel}${orModel !== requestedModel ? ` (mapped from ${requestedModel})` : ''}`)

  try {
    const chatRequest = buildChatRequest({ ...body, model: orModel })
    const { data } = await postOpenRouter('/chat/completions', chatRequest)
    const message = chatResponseToAnthropic({ requestedModel, openAIResponse: data, requestId })

    if (body.stream) {
      streamAnthropicMessage(res, message, requestId)
      return
    }
    writeJson(res, 200, message, { 'x-request-id': requestId })
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500
    log(`messages error`, error?.message || String(error))
    writeAnthropicError(res, statusCode, error?.message || String(error), requestId)
  }
}

async function handleCountTokens(req, res, body) {
  const requestId = `req_${randomUUID()}`
  const requestedModel = body.model
  const orModel = toOpenRouterModel(requestedModel)

  // OpenRouter has no token-counting endpoint — estimate via char count.
  log(`count_tokens request -> openrouter:${orModel} (estimated)`)
  const text = JSON.stringify(body.messages || '')
  const estimatedTokens = Math.ceil(text.length / 4)
  writeJson(res, 200, { input_tokens: estimatedTokens }, { 'x-request-id': requestId })
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      providers: { openrouter: Boolean(process.env.OPENROUTER_API_KEY) },
    })
    return
  }

  log(`request ${req.method} ${url.pathname}`)

  if (req.method !== 'POST') {
    writeJson(res, 404, { error: 'Not found' })
    return
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    writeAnthropicError(res, 400, `Invalid JSON body: ${error?.message || String(error)}`, `req_${randomUUID()}`)
    return
  }

  if (url.pathname === '/v1/messages') {
    await handleMessages(req, res, body)
    return
  }

  if (
    url.pathname === '/v1/messages/count_tokens' ||
    url.pathname === '/v1/messages/countTokens'
  ) {
    await handleCountTokens(req, res, body)
    return
  }

  writeJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, HOST, () => {
  log(`WrapdCode proxy listening on http://${HOST}:${PORT}`)
})

server.on('error', error => {
  logError('proxy server error', error)
  process.exit(1)
})

process.on('unhandledRejection', error => {
  logError('unhandled rejection', error)
})

process.on('uncaughtException', error => {
  logError('uncaught exception', error)
  process.exit(1)
})
