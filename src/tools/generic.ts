import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpMethod } from "../client.js";
import endpoints from "../catalog/endpoints.json" with { type: "json" };
import { defineTool, fileBlob, readLocalFile, type ToolContext } from "./common.js";

export interface CatalogEndpoint {
  method: HttpMethod;
  path: string;
  baseUrl?: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  scopes: string[];
  stability?: string;
  params: { name: string; in: string; required: boolean; type?: string; description?: string }[];
  body?: { contentType: string; schema: unknown }[];
  docs?: string;
}

export const catalog = endpoints as CatalogEndpoint[];

export function searchCatalog(query: string, limit = 15): CatalogEndpoint[] {
  const terms = query.toLowerCase().split(/[\s/:_-]+/).filter(Boolean);
  return catalog
    .map((endpoint) => {
      const haystack = [endpoint.method, endpoint.path, endpoint.summary, endpoint.operationId, endpoint.tags?.join(" "), endpoint.scopes.join(" ")]
        .join(" ")
        .toLowerCase();
      const description = (endpoint.description ?? "").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 3;
        else if (description.includes(term)) score += 1;
        else return { endpoint, score: 0 };
      }
      return { endpoint, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.endpoint.path.length - b.endpoint.path.length)
    .slice(0, limit)
    .map((hit) => hit.endpoint);
}

export function registerGenericTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    "roblox_search_endpoints",
    {
      title: "Search Open Cloud endpoints",
      description:
        `Search the catalog of ${catalog.length} Roblox Open Cloud endpoints that accept API keys (analytics, badges, localization, matchmaking, ` +
        "secrets, thumbnails, ads, creator store, etc.). Use it to find an endpoint for anything the dedicated tools don't cover, then call it with roblox_api_request.",
      input: {
        query: z.string().min(1).describe('Keywords, e.g. "badge", "localization table", "analytics metrics", "game pass".'),
        limit: z.number().int().min(1).max(50).default(15),
      },
    },
    async ({ query, limit }) => {
      const hits = searchCatalog(query, limit);
      if (hits.length === 0) return `No endpoints match "${query}". Try fewer or broader keywords.`;
      return hits.map((e) => ({ method: e.method, path: e.path, summary: e.summary, scopes: e.scopes, ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}) }));
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_describe_endpoint",
    {
      title: "Describe Open Cloud endpoint",
      description: "Show the parameters, request body schema, required API key scopes and docs link for an Open Cloud endpoint.",
      input: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z.string().describe("Path template exactly as returned by roblox_search_endpoints."),
      },
    },
    async ({ method, path }) => {
      const endpoint = catalog.find((e) => e.method === method && e.path === path);
      if (!endpoint) throw new Error(`Unknown endpoint ${method} ${path}. Use roblox_search_endpoints to find the exact path.`);
      return endpoint;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_api_request",
    {
      title: "Call any Open Cloud endpoint",
      description:
        "Send an authenticated request to any Roblox Open Cloud endpoint (the API key is added automatically). Fill in path parameters yourself, " +
        'e.g. "/cloud/v2/universes/123/secrets". Send JSON with `body`, multipart forms with `formFields`/`formFiles`, or a raw file with `filePath`. ' +
        "Only *.roblox.com hosts are allowed.",
      write: true,
      destructive: true,
      // Read-only mode keeps this tool but rejects non-GET methods below.
      alwaysAvailable: true,
      input: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string().min(1).describe('Path on https://apis.roblox.com (e.g. "/cloud/v2/universes/123"), or a full https://*.roblox.com URL.'),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.any().optional().describe("JSON request body."),
        formFields: z
          .record(z.string(), z.any())
          .optional()
          .describe("multipart/form-data text fields. Objects are JSON-encoded (e.g. the Assets API `request` field)."),
        formFiles: z.record(z.string(), z.string()).optional().describe("multipart/form-data file fields: { fieldName: absoluteFilePath }."),
        filePath: z.string().optional().describe("Send this local file as the raw request body."),
        contentType: z.string().optional().describe("Content-Type for filePath uploads."),
        headers: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ method, path, query, body, formFields, formFiles, filePath, contentType, headers }) => {
      if (ctx.config.readOnly && method !== "GET") throw new Error("ROBLOX_READ_ONLY is enabled; only GET requests are allowed.");
      const modes = [body !== undefined, Boolean(formFields || formFiles), Boolean(filePath)].filter(Boolean).length;
      if (modes > 1) throw new Error("Use only one of body, formFields/formFiles, or filePath.");
      if (headers && Object.keys(headers).some((h) => h.toLowerCase() === "x-api-key")) {
        throw new Error("The x-api-key header is set by the server and cannot be overridden.");
      }

      let payload: { json?: unknown; body?: BodyInit; contentType?: string } = {};
      if (body !== undefined) {
        payload = { json: body };
      } else if (formFields || formFiles) {
        const form = new FormData();
        for (const [key, value] of Object.entries(formFields ?? {})) {
          form.append(key, typeof value === "string" ? value : JSON.stringify(value));
        }
        for (const [key, file] of Object.entries(formFiles ?? {})) {
          const local = await readLocalFile(file);
          form.append(key, fileBlob(local), local.name);
        }
        payload = { body: form };
      } else if (filePath) {
        const local = await readLocalFile(filePath, contentType);
        payload = { body: local.bytes, contentType: local.contentType };
      }

      const res = await ctx.client.request({ method, path, query, headers, ...payload });
      return { status: res.status, data: res.data };
    },
  );
}
