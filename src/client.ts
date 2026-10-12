import type { Config } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | undefined | null;

export interface RequestOptions {
  method?: HttpMethod;
  /** Path relative to the base URL (e.g. `/cloud/v2/universes/123`), or an absolute https://*.roblox.com URL. */
  path: string;
  query?: Record<string, QueryValue | QueryValue[]>;
  /** Serialised as JSON. */
  json?: unknown;
  /** Sent as-is; use with `contentType` for binary uploads. */
  body?: BodyInit;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface RobloxResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

export class RobloxApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(`Roblox API ${method} ${url} failed with HTTP ${status}: ${RobloxApiError.describe(body)}`);
    this.name = "RobloxApiError";
  }

  private static describe(body: unknown): string {
    if (typeof body === "string") return body || "(empty body)";
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const message = b.message ?? b.error ?? (Array.isArray(b.errors) ? b.errors : undefined);
      if (message !== undefined) {
        return typeof message === "string" ? `${b.code ? `${b.code}: ` : ""}${message}` : JSON.stringify(message);
      }
      return JSON.stringify(body);
    }
    return String(body);
  }
}

const ALLOWED_HOST = /(^|\.)roblox\.com$/i;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class RobloxClient {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  buildUrl(path: string, query?: RequestOptions["query"]): URL {
    const url = /^https?:\/\//i.test(path)
      ? new URL(path)
      : new URL(`${this.config.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
    // Never send the API key anywhere but Roblox (or an explicitly configured base URL).
    const isRoblox = url.protocol === "https:" && ALLOWED_HOST.test(url.hostname);
    if (!isRoblox && !url.href.startsWith(`${this.config.baseUrl}/`)) {
      throw new Error(`Refusing to send the API key to ${url.origin}; only https://*.roblox.com is allowed.`);
    }
    for (const [key, raw] of Object.entries(query ?? {})) {
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.append(key, String(value));
      }
    }
    return url;
  }

  async request<T = unknown>(options: RequestOptions): Promise<RobloxResponse<T>> {
    const method = options.method ?? "GET";
    const url = this.buildUrl(options.path, options.query);
    const headers: Record<string, string> = {
      "x-api-key": this.config.apiKey,
      accept: "application/json",
      "user-agent": "roblox-creator-hub-mcp",
      ...options.headers,
    };
    let body = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["content-type"] = "application/json";
    } else if (options.contentType) {
      headers["content-type"] = options.contentType;
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`Roblox API ${method} ${url.pathname} timed out after ${this.config.timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      // FormData/stream bodies can't be replayed, so only retry replayable ones.
      const replayable = body === undefined || typeof body === "string" || body instanceof Uint8Array || body instanceof Blob;
      if (RETRYABLE.has(response.status) && attempt < this.config.maxRetries && replayable) {
        await response.body?.cancel();
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      const data = await parseBody(response);
      if (!response.ok) throw new RobloxApiError(response.status, method, `${url.pathname}${url.search}`, data);
      return { status: response.status, headers: response.headers, data: data as T };
    }
  }

  get<T = unknown>(path: string, query?: RequestOptions["query"]) {
    return this.request<T>({ method: "GET", path, query });
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json") || /^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through to raw text
    }
  }
  return text;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.min(reset * 1000, 30_000);
  return Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
