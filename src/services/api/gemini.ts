import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaJSONOutputFormat,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { randomUUID } from 'crypto'
import type { AssistantMessage } from 'src/types/message.js'
import { createAssistantMessage } from 'src/utils/messages.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { normalizeModelStringForAPI } from 'src/utils/model/model.js'
import { safeParseJSON } from 'src/utils/json.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'
import { EMPTY_USAGE } from './emptyUsage.js'

type AnthropicLikeMessage = Pick<Anthropic.MessageParam, 'role' | 'content'>

type GeminiBlob = {
  mimeType: string
  data: string
}

type GeminiTextPart = {
  text: string
}

type GeminiInlineDataPart = {
  inlineData: GeminiBlob
}

type GeminiFunctionCallPart = {
  functionCall: {
    id?: string
    name: string
    args: Record<string, unknown>
  }
}

type GeminiFunctionResponsePart = {
  functionResponse: {
    id?: string
    name: string
    response: Record<string, unknown>
  }
}

type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart

type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiFunctionDeclaration = {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

type GeminiTool = {
  functionDeclarations: GeminiFunctionDeclaration[]
}

type GeminiToolConfig = {
  functionCallingConfig: {
    mode: 'AUTO' | 'ANY' | 'NONE'
    allowedFunctionNames?: string[]
  }
}

type GeminiThinkingConfig = {
  thinkingBudget: number
}

type GeminiGenerationConfig = {
  maxOutputTokens?: number
  temperature?: number
  stopSequences?: string[]
  responseMimeType?: 'application/json'
  responseJsonSchema?: Record<string, unknown>
  thinkingConfig?: GeminiThinkingConfig
}

type GeminiGenerateContentRequest = {
  contents: GeminiContent[]
  tools?: GeminiTool[]
  toolConfig?: GeminiToolConfig
  systemInstruction?: {
    parts: GeminiTextPart[]
  }
  generationConfig?: GeminiGenerationConfig
}

type GeminiUsageMetadata = {
  promptTokenCount?: number
  cachedContentTokenCount?: number
  candidatesTokenCount?: number
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
        functionCall?: {
          id?: string
          name?: string
          args?: Record<string, unknown> | string | null
        }
      }>
    }
    finishReason?: string
  }>
  promptFeedback?: {
    blockReason?: string
    blockReasonMessage?: string
  }
  usageMetadata?: GeminiUsageMetadata
}

type GeminiCountTokensResponse = {
  totalTokens?: number
}

export type GeminiQueryResult = {
  assistantMessage: AssistantMessage
  usage: NonNullableUsage
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use'
  responseHeaders: Headers
  requestId: string | null
}

type GeminiRequestOptions = {
  model: string
  systemPrompt?: string | string[] | TextBlockParam[]
  messages: readonly AnthropicLikeMessage[]
  tools?: readonly BetaToolUnion[]
  toolChoice?: BetaToolChoiceAuto | BetaToolChoiceTool
  outputFormat?: BetaJSONOutputFormat
  maxOutputTokens?: number
  temperature?: number
  thinkingBudget?: number
  stopSequences?: string[]
  signal?: AbortSignal
  fetchOverride?: typeof globalThis.fetch
}

type GeminiInlineCapableBlock = {
  source: {
    type: string
    media_type: string
    data: string
  }
}

function getGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  if (!apiKey) {
    throw new Error(
      'Gemini provider is enabled, but GEMINI_API_KEY or GOOGLE_API_KEY is not set.',
    )
  }
  return apiKey
}

function getGeminiBaseUrl(): string {
  return (
    process.env.GEMINI_BASE_URL ||
    'https://generativelanguage.googleapis.com/v1beta'
  ).replace(/\/+$/, '')
}

function flattenSystemPrompt(
  systemPrompt: GeminiRequestOptions['systemPrompt'],
): string | undefined {
  if (!systemPrompt) {
    return undefined
  }
  if (typeof systemPrompt === 'string') {
    return systemPrompt.trim() || undefined
  }
  const text = systemPrompt
    .map(block => (typeof block === 'string' ? block : block.text))
    .join('\n\n')
    .trim()
  return text || undefined
}

function createInlineDataPart(
  block: GeminiInlineCapableBlock,
): GeminiInlineDataPart | null {
  if (block.source.type !== 'base64') {
    return null
  }
  return {
    inlineData: {
      mimeType: block.source.media_type,
      data: block.source.data,
    },
  }
}

function summarizeToolResultContent(
  content: Anthropic.ToolResultBlockParam['content'],
): unknown {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }

  const summarized = content.map(block => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text }
    }
    if (block.type === 'image') {
      return { type: 'image', note: '[image result omitted from Gemini replay]' }
    }
    if (block.type === 'document') {
      return {
        type: 'document',
        note: '[document result omitted from Gemini replay]',
      }
    }
    return {
      type: block.type,
      data: jsonStringify(block),
    }
  })

  if (
    summarized.length > 0 &&
    summarized.every(
      item =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text',
    )
  ) {
    return summarized
      .map(item => (item as { text: string }).text)
      .join('\n\n')
      .trim()
  }

  return summarized
}

function normalizeToolArgs(
  args: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args
  }
  if (typeof args === 'string') {
    const parsed = safeParseJSON(args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  }
  return {}
}

function anthropicContentToGeminiParts(
  role: 'assistant' | 'user',
  content: AnthropicLikeMessage['content'],
  toolNameById: Map<string, string>,
): GeminiPart[] {
  const blocks =
    typeof content === 'string' ? [{ type: 'text', text: content }] : content

  return blocks.flatMap(block => {
    switch (block.type) {
      case 'text':
        return block.text ? [{ text: block.text }] : []
      case 'image':
      case 'document': {
        if (role === 'assistant') {
          return []
        }
        const inlinePart = createInlineDataPart(block)
        return inlinePart ? [inlinePart] : []
      }
      case 'tool_use': {
        if (role !== 'assistant') {
          return []
        }
        toolNameById.set(block.id, block.name)
        return [
          {
            functionCall: {
              id: block.id,
              name: block.name,
              args:
                block.input && typeof block.input === 'object'
                  ? (block.input as Record<string, unknown>)
                  : {},
            },
          },
        ]
      }
      case 'tool_result': {
        if (role !== 'user') {
          return []
        }
        return [
          {
            functionResponse: {
              id: block.tool_use_id,
              name: toolNameById.get(block.tool_use_id) ?? 'tool_result',
              response: {
                tool_use_id: block.tool_use_id,
                is_error: block.is_error ?? false,
                result: summarizeToolResultContent(block.content),
              },
            },
          },
        ]
      }
      case 'thinking':
      case 'redacted_thinking':
        return []
      default:
        if (role === 'assistant') {
          return []
        }
        return [
          {
            text: jsonStringify(block),
          },
        ]
    }
  })
}

function anthropicMessagesToGeminiContents(
  messages: readonly AnthropicLikeMessage[],
): GeminiContent[] {
  const toolNameById = new Map<string, string>()
  const contents: GeminiContent[] = []

  for (const message of messages) {
    const geminiRole = message.role === 'assistant' ? 'model' : 'user'
    const parts = anthropicContentToGeminiParts(
      message.role,
      message.content,
      toolNameById,
    )
    if (parts.length > 0) {
      contents.push({ role: geminiRole, parts })
    }
  }

  return contents
}

function geminiToolsFromAnthropic(
  tools: readonly BetaToolUnion[] | undefined,
): GeminiTool[] | undefined {
  if (!tools?.length) {
    return undefined
  }

  const functionDeclarations = tools.flatMap(tool => {
    const candidate = tool as {
      name?: string
      description?: string
      input_schema?: Record<string, unknown>
    }
    if (!candidate.name || !candidate.input_schema) {
      return []
    }
    return [
      {
        name: candidate.name,
        description: candidate.description,
        parameters: candidate.input_schema,
      },
    ]
  })

  if (functionDeclarations.length === 0) {
    return undefined
  }

  return [{ functionDeclarations }]
}

function geminiToolConfigFromAnthropic(
  toolChoice: BetaToolChoiceAuto | BetaToolChoiceTool | undefined,
): GeminiToolConfig | undefined {
  if (!toolChoice) {
    return undefined
  }

  if (toolChoice.type === 'tool') {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [toolChoice.name],
      },
    }
  }

  return {
    functionCallingConfig: {
      mode: 'AUTO',
    },
  }
}

function geminiGenerationConfig({
  maxOutputTokens,
  temperature,
  outputFormat,
  thinkingBudget,
  stopSequences,
}: Pick<
  GeminiRequestOptions,
  | 'maxOutputTokens'
  | 'temperature'
  | 'outputFormat'
  | 'thinkingBudget'
  | 'stopSequences'
>): GeminiGenerationConfig | undefined {
  const config: GeminiGenerationConfig = {}

  if (maxOutputTokens !== undefined) {
    config.maxOutputTokens = maxOutputTokens
  }
  if (temperature !== undefined) {
    config.temperature = temperature
  }
  if (stopSequences && stopSequences.length > 0) {
    config.stopSequences = stopSequences
  }
  if (thinkingBudget !== undefined) {
    config.thinkingConfig = {
      thinkingBudget,
    }
  }
  if (outputFormat?.type === 'json_schema') {
    config.responseMimeType = 'application/json'
    config.responseJsonSchema = outputFormat.schema as Record<string, unknown>
  }

  return Object.keys(config).length > 0 ? config : undefined
}

function buildGeminiRequest(
  opts: GeminiRequestOptions,
): GeminiGenerateContentRequest {
  const contents = anthropicMessagesToGeminiContents(opts.messages)
  const tools = geminiToolsFromAnthropic(opts.tools)
  const toolConfig = geminiToolConfigFromAnthropic(opts.toolChoice)
  const systemPrompt = flattenSystemPrompt(opts.systemPrompt)

  return {
    contents:
      contents.length > 0
        ? contents
        : [{ role: 'user', parts: [{ text: 'Continue.' }] }],
    ...(tools && { tools }),
    ...(toolConfig && { toolConfig }),
    ...(systemPrompt && {
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
    }),
    ...(geminiGenerationConfig(opts) && {
      generationConfig: geminiGenerationConfig(opts),
    }),
  }
}

async function postGemini<T>(
  path: string,
  body: Record<string, unknown>,
  fetchOverride?: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<{ data: T; headers: Headers }> {
  const fetchImpl = fetchOverride ?? globalThis.fetch
  const response = await fetchImpl(`${getGeminiBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': getGeminiApiKey(),
    },
    body: JSON.stringify(body),
    signal,
    ...getProxyFetchOptions(),
  })

  if (!response.ok) {
    const text = await response.text()
    const parsed = safeParseJSON(text)
    const message =
      parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      parsed.error &&
      typeof parsed.error === 'object' &&
      'message' in parsed.error &&
      typeof parsed.error.message === 'string'
        ? parsed.error.message
        : text || `${response.status} ${response.statusText}`
    throw new Error(`Gemini API error (${response.status}): ${message}`)
  }

  const data = (await response.json()) as T
  return { data, headers: response.headers }
}

function geminiUsageToAnthropicUsage(
  usageMetadata: GeminiUsageMetadata | undefined,
): NonNullableUsage {
  if (!usageMetadata) {
    return { ...EMPTY_USAGE }
  }

  return {
    ...EMPTY_USAGE,
    input_tokens: usageMetadata.promptTokenCount ?? 0,
    cache_read_input_tokens: usageMetadata.cachedContentTokenCount ?? 0,
    output_tokens: usageMetadata.candidatesTokenCount ?? 0,
  }
}

function geminiCandidateToAssistantMessage(
  model: string,
  candidate: NonNullable<GeminiGenerateContentResponse['candidates']>[number],
  usage: NonNullableUsage,
  requestId: string | null,
): Pick<GeminiQueryResult, 'assistantMessage' | 'stopReason'> {
  const contentBlocks =
    candidate.content?.parts?.flatMap(part => {
      if (typeof part.text === 'string' && part.text.length > 0) {
        return [{ type: 'text' as const, text: part.text }]
      }
      if (part.functionCall?.name) {
        return [
          {
            type: 'tool_use' as const,
            id: part.functionCall.id ?? randomUUID(),
            name: part.functionCall.name,
            input: normalizeToolArgs(part.functionCall.args),
          },
        ]
      }
      return []
    }) ?? []

  const hasToolUse = contentBlocks.some(block => block.type === 'tool_use')
  const stopReason =
    candidate.finishReason === 'MAX_TOKENS'
      ? 'max_tokens'
      : hasToolUse
        ? 'tool_use'
        : 'end_turn'

  const assistantMessage = createAssistantMessage({
    content: contentBlocks.length > 0 ? contentBlocks : '',
    usage,
  })

  assistantMessage.message = {
    ...assistantMessage.message,
    model,
    stop_reason: stopReason,
    usage,
  }
  assistantMessage.requestId = requestId ?? undefined

  return {
    assistantMessage,
    stopReason,
  }
}

export async function queryGemini(
  opts: GeminiRequestOptions,
): Promise<GeminiQueryResult> {
  const model = normalizeModelStringForAPI(opts.model)
  const request = buildGeminiRequest({ ...opts, model })
  const { data, headers } = await postGemini<GeminiGenerateContentResponse>(
    `/models/${encodeURIComponent(model)}:generateContent`,
    request,
    opts.fetchOverride,
    opts.signal,
  )

  const requestId =
    headers.get('x-request-id') || headers.get('x-goog-request-id')

  const candidate = data.candidates?.[0]
  if (!candidate) {
    const blockReason = data.promptFeedback?.blockReason
    const blockReasonMessage = data.promptFeedback?.blockReasonMessage
    if (blockReason || blockReasonMessage) {
      throw new Error(
        `Gemini blocked the request: ${blockReasonMessage ?? blockReason}`,
      )
    }
    throw new Error('Gemini returned no candidates.')
  }

  const usage = geminiUsageToAnthropicUsage(data.usageMetadata)
  const { assistantMessage, stopReason } = geminiCandidateToAssistantMessage(
    model,
    candidate,
    usage,
    requestId,
  )

  return {
    assistantMessage,
    usage,
    stopReason,
    responseHeaders: headers,
    requestId,
  }
}

export async function countGeminiTokens({
  model,
  systemPrompt,
  messages,
  tools,
  toolChoice,
  signal,
  fetchOverride,
}: Pick<
  GeminiRequestOptions,
  | 'model'
  | 'systemPrompt'
  | 'messages'
  | 'tools'
  | 'toolChoice'
  | 'signal'
  | 'fetchOverride'
>): Promise<number | null> {
  const normalizedModel = normalizeModelStringForAPI(model)
  const request = buildGeminiRequest({
    model: normalizedModel,
    systemPrompt,
    messages,
    tools,
    toolChoice,
  })

  try {
    const { data } = await postGemini<GeminiCountTokensResponse>(
      `/models/${encodeURIComponent(normalizedModel)}:countTokens`,
      {
        generateContentRequest: request,
      },
      fetchOverride,
      signal,
    )
    return data.totalTokens ?? null
  } catch {
    return null
  }
}
