/**
 * @fileoverview Custom AI Gateway client (OpenAI-compatible) for Late Meet.
 * Routes all meeting summarization, chunk processing, and MoM synthesis through
 * a configurable Base URL (e.g. OpenAI, OpenRouter, Groq, local Ollama, LM Studio).
 */

import { AiGatewayConfig } from "../types";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL_NAME = "gpt-4o-mini";
export const AI_GATEWAY_STORAGE_KEY = "aiGatewayConfig";

/** Normalizes a user-provided Base URL to standard OpenAI base format (no trailing slash, no trailing /chat/completions). */
export function normalizeBaseUrl(url: string | null | undefined): string {
  if (!url || !url.trim()) return DEFAULT_BASE_URL;
  let normalized = url.trim().replace(/\/+$/, "");
  // Strip trailing /chat/completions if the user accidentally pasted the complete endpoint
  if (normalized.endsWith("/chat/completions")) {
    normalized = normalized.slice(0, -"/chat/completions".length).replace(/\/+$/, "");
  }
  return normalized || DEFAULT_BASE_URL;
}

/** Reads the stored AI Gateway configuration from chrome.storage.local. */
export async function getAiGatewayConfig(): Promise<AiGatewayConfig> {
  try {
    const result = await chrome.storage.local.get([
      AI_GATEWAY_STORAGE_KEY,
      "openai_api_key",
      "apiKey",
      "settings",
    ]);
    const stored = result[AI_GATEWAY_STORAGE_KEY] as Partial<AiGatewayConfig> | undefined;

    const baseURL = normalizeBaseUrl(stored?.baseURL);
    const modelName =
      stored?.modelName?.trim() || (result.settings as any)?.aiModel || DEFAULT_MODEL_NAME;
    const language = stored?.language || "auto";

    // API Key: prioritize gateway config, fallback to legacy stored keys if available
    let apiKey = stored?.apiKey?.trim() || "";
    if (!apiKey) {
      if (typeof result.openai_api_key === "string" && !result.openai_api_key.startsWith("enc:")) {
        apiKey = result.openai_api_key.trim();
      } else if (typeof result.apiKey === "string" && !result.apiKey.startsWith("enc:")) {
        apiKey = result.apiKey.trim();
      }
    }

    return {
      baseURL,
      apiKey,
      modelName,
      language,
    };
  } catch (err) {
    console.warn("[LateMeet][aiGateway] Failed to read gateway config, using defaults:", err);
    return {
      baseURL: DEFAULT_BASE_URL,
      apiKey: "",
      modelName: DEFAULT_MODEL_NAME,
      language: "auto",
    };
  }
}

/** Persists AI Gateway configuration to chrome.storage.local. */
export async function saveAiGatewayConfig(config: Partial<AiGatewayConfig>): Promise<void> {
  const current = await getAiGatewayConfig();
  const updated: AiGatewayConfig = {
    baseURL: config.baseURL !== undefined ? normalizeBaseUrl(config.baseURL) : current.baseURL,
    apiKey: config.apiKey !== undefined ? config.apiKey.trim() : current.apiKey,
    modelName: config.modelName !== undefined ? config.modelName.trim() : current.modelName,
    language: config.language !== undefined ? config.language : current.language,
  };

  await chrome.storage.local.set({ [AI_GATEWAY_STORAGE_KEY]: updated });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  model?: string;
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model: string;
}

/**
 * Sends a chat completion request to the configured Custom AI Gateway.
 * Automatically retries without `response_format` if the target gateway does not support json_object mode.
 */
export async function callChatCompletion(
  options: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  const config = await getAiGatewayConfig();
  const endpoint = `${config.baseURL}/chat/completions`;
  const modelToUse = options.model || config.modelName || DEFAULT_MODEL_NAME;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const payload: Record<string, any> = {
    model: modelToUse,
    messages: options.messages,
    temperature: options.temperature ?? 0.2,
  };

  if (typeof options.maxTokens === "number" && options.maxTokens > 0) {
    payload.max_tokens = options.maxTokens;
  }

  if (options.jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  const executeRequest = async (bodyPayload: any): Promise<Response> => {
    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload),
      signal: options.signal || AbortSignal.timeout(60000),
    });
  };

  let response = await executeRequest(payload);

  // Fallback for providers that reject `response_format: { type: "json_object" }` (e.g. older Ollama, Claude proxies)
  if (!response.ok && options.jsonMode && response.status === 400) {
    console.warn(
      "[LateMeet][aiGateway] json_object mode rejected (HTTP 400), retrying without response_format...",
    );
    const fallbackPayload = { ...payload };
    delete fallbackPayload.response_format;
    response = await executeRequest(fallbackPayload);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`AI Gateway Error (${response.status}): ${errorText || response.statusText}`);
  }

  const data = await response.json();
  const choice = data?.choices?.[0];
  const content = choice?.message?.content?.trim() || "";

  return {
    content,
    usage: data?.usage,
    model: modelToUse,
  };
}

/** Diagnostic tool to verify that the Custom AI Gateway is reachable and accepts requests. */
export async function testGatewayConnection(config: Partial<AiGatewayConfig>): Promise<{
  success: boolean;
  latencyMs: number;
  modelUsed: string;
  error?: string;
}> {
  const startTime = Date.now();
  const endpoint = `${normalizeBaseUrl(config.baseURL)}/chat/completions`;
  const modelToUse = config.modelName || DEFAULT_MODEL_NAME;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const payload = {
    model: modelToUse,
    messages: [{ role: "user", content: "Reply with the word 'OK' only." }],
    max_tokens: 10,
    temperature: 0,
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        success: false,
        latencyMs,
        modelUsed: modelToUse,
        error: `HTTP ${response.status}: ${errorText || response.statusText}`,
      };
    }

    return {
      success: true,
      latencyMs,
      modelUsed: modelToUse,
    };
  } catch (err: any) {
    return {
      success: false,
      latencyMs: Date.now() - startTime,
      modelUsed: modelToUse,
      error: err?.message || String(err),
    };
  }
}
