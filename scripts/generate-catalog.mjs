#!/usr/bin/env node
// Builds src/catalog/endpoints.json: a compact index of every Open Cloud
// operation that accepts API-key auth, taken from Roblox's published OpenAPI
// spec. Usage: node scripts/generate-catalog.mjs [path-or-url-to-openapi.json]
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_SPEC =
  "https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/cloud/openapi.json";
const OUT = fileURLToPath(new URL("../src/catalog/endpoints.json", import.meta.url));
const DEFAULT_BASE_URL = "https://apis.roblox.com";
const METHODS = ["get", "post", "put", "patch", "delete"];
const MAX_DEPTH = 3;

const source = process.argv[2] ?? DEFAULT_SPEC;
const spec = JSON.parse(
  /^https?:/.test(source) ? await (await fetch(source)).text() : await readFile(source, "utf8"),
);
const schemas = spec.components?.schemas ?? {};

function clip(text, max) {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Inline $refs to a fixed depth and drop read-only fields, so the result
// describes what a caller can actually send.
function simplify(schema, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop();
    if (depth >= MAX_DEPTH || seen.has(name)) return { type: "object", ref: name };
    return simplify(schemas[name], depth + 1, new Set(seen).add(name));
  }
  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.format) out.format = schema.format;
  if (schema.enum) out.enum = schema.enum;
  const description = clip(schema.description, 160);
  if (description) out.description = description;
  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      if (value.readOnly) continue;
      out.properties[key] = simplify(value, depth, seen);
    }
  }
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = simplify(schema.items, depth, seen);
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    if (schema[key]) out[key] = schema[key].map((s) => simplify(s, depth, seen));
  }
  return out;
}

const endpoints = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const security = op.security ?? spec.security ?? [];
    if (!security.some((s) => "roblox-api-key" in s)) continue;

    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => ({
      name: p.name,
      in: p.in,
      required: Boolean(p.required),
      type: p.schema?.type,
      description: clip(p.description, 200),
    }));
    const body = op.requestBody?.content;
    const server = (op.servers ?? item.servers)?.[0]?.url;
    endpoints.push({
      method: method.toUpperCase(),
      path: path.replace(/#.*$/, ""),
      baseUrl: server && server !== DEFAULT_BASE_URL ? server : undefined,
      operationId: op.operationId,
      summary: op.summary,
      description: clip(op.description, 400),
      tags: op.tags,
      scopes: (op["x-roblox-scopes"] ?? []).map((s) => s.name),
      stability: op["x-roblox-stability"],
      params,
      body: body
        ? Object.entries(body).map(([contentType, value]) => ({
            contentType,
            schema: simplify(value.schema),
          }))
        : undefined,
      docs: op.externalDocs?.url,
    });
  }
}

endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
await writeFile(OUT, `${JSON.stringify(endpoints)}\n`);
console.log(`Wrote ${endpoints.length} endpoints to ${OUT}`);
