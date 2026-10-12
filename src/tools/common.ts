import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RobloxApiError, sleep, type RobloxClient } from "../client.js";
import type { Config } from "../config.js";

export interface ToolContext {
  client: RobloxClient;
  config: Config;
}

export interface ToolOptions<S extends z.ZodRawShape> {
  title: string;
  description: string;
  input: S;
  /** Changes state in Roblox. Hidden when ROBLOX_READ_ONLY is set. */
  write?: boolean;
  /** Deletes or irreversibly overwrites data. */
  destructive?: boolean;
  idempotent?: boolean;
  /** Register even in read-only mode (the handler must enforce it). */
  alwaysAvailable?: boolean;
}

/** Registers a tool, honouring read-only mode and turning thrown errors into MCP tool errors. */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  options: ToolOptions<S>,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  if (options.write && ctx.config.readOnly && !options.alwaysAvailable) return;
  server.registerTool(
    name,
    {
      title: options.title,
      description: options.description,
      inputSchema: options.input,
      annotations: {
        title: options.title,
        readOnlyHint: !options.write,
        destructiveHint: Boolean(options.write && options.destructive),
        idempotentHint: options.write ? Boolean(options.idempotent) : true,
        openWorldHint: true,
      },
    },
    (async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
      try {
        return toResult(await handler(args));
      } catch (error) {
        return errorResult(error);
      }
    }) as never,
  );
}

export function toResult(data: unknown): CallToolResult {
  const text = data === null || data === undefined ? "OK (no content)" : typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

export function errorResult(error: unknown): CallToolResult {
  let text = error instanceof Error ? error.message : String(error);
  if (error instanceof RobloxApiError) {
    const hint = HINTS[error.status];
    if (hint) text += `\n\nHint: ${hint}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}

const HINTS: Record<number, string> = {
  401: "The API key was rejected. Check ROBLOX_API_KEY, that the key is enabled, not expired, and that your IP is allowed by the key's IP restrictions (use 0.0.0.0/0 to allow all).",
  403: "The API key lacks permission for this resource. In Creator Dashboard > Credentials, add the required API system and scope (see roblox_describe_endpoint) and make sure the experience/group is selected for it.",
  404: "Resource not found. Double-check the IDs (universe ID is not the same as place ID).",
  429: "Rate limited by Roblox. Wait a moment and try again.",
};

// ---------------------------------------------------------------------------
// Shared argument schemas & resolvers

export const id = (what: string) => z.coerce.string().min(1).describe(what);

export const optionalUniverseId = id("Universe (experience) ID. Defaults to ROBLOX_UNIVERSE_ID.").optional();
export const optionalPlaceId = id("Place ID. Defaults to ROBLOX_PLACE_ID.").optional();

export const pageSize = z.number().int().min(1).max(1000).optional().describe("Maximum number of results to return.");
export const pageToken = z.string().optional().describe("Page token from a previous response's nextPageToken.");

export function resolveUniverse(ctx: ToolContext, universeId?: string): string {
  const resolved = universeId ?? ctx.config.defaultUniverseId;
  if (!resolved) throw new Error("universeId is required (or set ROBLOX_UNIVERSE_ID).");
  return resolved;
}

export function resolvePlace(ctx: ToolContext, placeId?: string): string {
  const resolved = placeId ?? ctx.config.defaultPlaceId;
  if (!resolved) throw new Error("placeId is required (or set ROBLOX_PLACE_ID).");
  return resolved;
}

/** Encodes one path segment (entry keys may contain `/`, spaces, etc.). */
export const seg = (value: string | number) => encodeURIComponent(String(value));

/** Builds a field mask from the keys that were actually supplied. */
export function updateMask(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields).filter((key) => fields[key] !== undefined);
  if (keys.length === 0) throw new Error("Provide at least one field to update.");
  return keys.join(",");
}

/** z.any() fields are optional in JSON Schema; use this for required JSON values. */
export function requireValue(value: unknown, name: string): void {
  if (value === undefined) throw new Error(`${name} is required.`);
}

export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Files

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bmp": "image/bmp",
  ".tga": "image/tga",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".fbx": "model/fbx",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".obj": "model/obj",
  ".rbxm": "model/x-rbxm",
  ".rbxmx": "model/x-rbxm",
  ".mp4": "video/mp4",
  ".mov": "video/mov",
  ".rbxl": "application/octet-stream",
  ".rbxlx": "application/xml",
};

export interface LocalFile {
  name: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export async function readLocalFile(path: string, contentType?: string): Promise<LocalFile> {
  const info = await stat(path).catch(() => {
    throw new Error(`File not found: ${path}`);
  });
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  return {
    name: basename(path),
    contentType: contentType ?? MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
    bytes: new Uint8Array(await readFile(path)),
  };
}

export function fileBlob(file: LocalFile): Blob {
  return new Blob([file.bytes], { type: file.contentType });
}

// ---------------------------------------------------------------------------
// Long-running operations

export interface Operation {
  path?: string;
  done?: boolean;
  error?: unknown;
  response?: unknown;
  [key: string]: unknown;
}

/**
 * Polls a long-running operation until it finishes or `timeoutMs` elapses.
 * `operationUrl` maps the operation to the path it can be fetched from.
 */
export async function waitForOperation(
  ctx: ToolContext,
  initial: Operation,
  operationUrl: (op: Operation) => string,
  timeoutMs = 60_000,
): Promise<Operation> {
  let op = initial;
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  while (!op.done && op.path && Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 2, 5_000);
    op = (await ctx.client.get<Operation>(operationUrl(op))).data;
  }
  return op;
}

export const cloudV2OperationUrl = (op: Operation) => `/cloud/v2/${op.path}`;
