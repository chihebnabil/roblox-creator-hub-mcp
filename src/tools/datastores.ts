import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, defineTool, requireValue, optionalUniverseId, pageSize, pageToken, resolveUniverse, seg, type ToolContext } from "./common.js";

const dataStore = z.string().min(1).describe("Data store name (as used in DataStoreService:GetDataStore).");
const key = z.string().min(1).describe("Entry key.");
const scope = z
  .string()
  .optional()
  .describe('Data store scope. Defaults to "global". When listing, "-" lists entries across all scopes.');
const jsonValue = z.any().describe("Any JSON value: object, array, string, number, boolean or null.");

function entriesPath(ctx: ToolContext, universeId: string | undefined, store: string, scopeId?: string): string {
  const base = `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/data-stores/${seg(store)}`;
  return scopeId ? `${base}/scopes/${seg(scopeId)}/entries` : `${base}/entries`;
}

function prefixFilter(prefix?: string): string | undefined {
  return prefix ? `id.startsWith(${JSON.stringify(prefix)})` : undefined;
}

export function registerDataStoreTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    "roblox_list_data_stores",
    {
      title: "List data stores",
      description: "List the standard data stores in an experience. Scope: universe-datastores.control:list.",
      input: {
        universeId: optionalUniverseId,
        prefix: z.string().optional().describe("Only return data stores whose name starts with this."),
        showDeleted: z.boolean().optional().describe("Include data stores pending deletion."),
        pageSize,
        pageToken,
      },
    },
    async ({ universeId, prefix, showDeleted, pageSize, pageToken }) =>
      (
        await ctx.client.get(`/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/data-stores`, {
          filter: prefixFilter(prefix),
          showDeleted,
          maxPageSize: pageSize,
          pageToken,
        })
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_list_data_store_entries",
    {
      title: "List data store keys",
      description:
        "List entry keys in a data store (values are not included; use roblox_get_data_store_entry). Scope: universe-datastores.objects:list.",
      input: {
        universeId: optionalUniverseId,
        dataStore,
        scope,
        prefix: z.string().optional().describe("Only return keys starting with this."),
        showDeleted: z.boolean().optional(),
        pageSize,
        pageToken,
      },
    },
    async ({ universeId, dataStore, scope, prefix, showDeleted, pageSize, pageToken }) =>
      (
        await ctx.client.get(entriesPath(ctx, universeId, dataStore, scope), {
          filter: prefixFilter(prefix),
          showDeleted,
          maxPageSize: pageSize,
          pageToken,
        })
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_get_data_store_entry",
    {
      title: "Get data store entry",
      description:
        "Read a data store entry's value, attributes, user IDs, etag and revision. Optionally read a past revision or the value at a point in time. " +
        "Scope: universe-datastores.objects:read.",
      input: {
        universeId: optionalUniverseId,
        dataStore,
        key,
        scope,
        revisionId: z.string().optional().describe("Read this specific revision (from roblox_list_data_store_entry_revisions)."),
        asOf: z.string().optional().describe("RFC 3339 timestamp; read the value that was current at that time."),
      },
    },
    async ({ universeId, dataStore, key, scope, revisionId, asOf }) => {
      if (revisionId && asOf) throw new Error("Pass either revisionId or asOf, not both.");
      const suffix = revisionId ? `@${revisionId}` : asOf ? `@latest:${asOf}` : key.includes("@") ? "@latest" : "";
      return (await ctx.client.get(`${entriesPath(ctx, universeId, dataStore, scope)}/${seg(key)}${suffix}`)).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_set_data_store_entry",
    {
      title: "Set data store entry",
      description:
        "Create or overwrite a data store entry (like SetAsync). Pass etag to only write if the entry hasn't changed since you read it. " +
        "Set createOnly to fail instead of overwriting an existing key. Scopes: universe-datastores.objects:create and :update.",
      write: true,
      destructive: true,
      idempotent: true,
      input: {
        universeId: optionalUniverseId,
        dataStore,
        key,
        scope,
        value: jsonValue,
        users: z.array(z.string()).optional().describe('User IDs associated with the entry (for GDPR), e.g. ["12345"].'),
        attributes: z.record(z.string(), z.any()).optional().describe("Entry metadata attributes."),
        etag: z.string().optional().describe("Only write if the current etag matches (optimistic concurrency)."),
        createOnly: z.boolean().optional().describe("Fail if the entry already exists."),
      },
    },
    async ({ universeId, dataStore, key, scope, value, users, attributes, etag, createOnly }) => {
      requireValue(value, "value");
      const body = compact({
        value,
        users: users?.map((u) => (u.startsWith("users/") ? u : `users/${u}`)),
        attributes,
        etag,
      });
      const path = entriesPath(ctx, universeId, dataStore, scope);
      const res = createOnly
        ? await ctx.client.request({ method: "POST", path, query: { id: key }, json: body })
        : await ctx.client.request({ method: "PATCH", path: `${path}/${seg(key)}`, query: { allowMissing: true }, json: body });
      return res.data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_increment_data_store_entry",
    {
      title: "Increment data store entry",
      description:
        "Atomically add to an integer entry (like IncrementAsync); creates it if missing. Scopes: universe-datastores.objects:create and :update.",
      write: true,
      input: {
        universeId: optionalUniverseId,
        dataStore,
        key,
        scope,
        amount: z.number().int().describe("Amount to add (may be negative)."),
      },
    },
    async ({ universeId, dataStore, key, scope, amount }) =>
      (
        await ctx.client.request({
          method: "POST",
          path: `${entriesPath(ctx, universeId, dataStore, scope)}/${seg(key)}:increment`,
          json: { amount },
        })
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_delete_data_store_entry",
    {
      title: "Delete data store entry",
      description:
        "Delete a data store entry (like RemoveAsync). The entry is tombstoned and previous revisions remain readable for 30 days. Scope: universe-datastores.objects:delete.",
      write: true,
      destructive: true,
      idempotent: true,
      input: { universeId: optionalUniverseId, dataStore, key, scope },
    },
    async ({ universeId, dataStore, key, scope }) => {
      await ctx.client.request({ method: "DELETE", path: `${entriesPath(ctx, universeId, dataStore, scope)}/${seg(key)}` });
      return `Deleted "${key}" from data store "${dataStore}".`;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_list_data_store_entry_revisions",
    {
      title: "List entry revisions",
      description:
        "List the revision history of a data store entry (newest first). Use a revisionId with roblox_get_data_store_entry to read old values. Scope: universe-datastores.versions:list.",
      input: {
        universeId: optionalUniverseId,
        dataStore,
        key,
        scope,
        startTime: z.string().optional().describe("RFC 3339; only revisions created at or after this time."),
        endTime: z.string().optional().describe("RFC 3339; only revisions created at or before this time."),
        pageSize,
        pageToken,
      },
    },
    async ({ universeId, dataStore, key, scope, startTime, endTime, pageSize, pageToken }) => {
      const filter = [startTime && `revision_create_time >= ${startTime}`, endTime && `revision_create_time <= ${endTime}`]
        .filter(Boolean)
        .join(" && ");
      return (
        await ctx.client.get(`${entriesPath(ctx, universeId, dataStore, scope)}/${seg(key)}:listRevisions`, {
          filter: filter || undefined,
          maxPageSize: pageSize,
          pageToken,
        })
      ).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_delete_data_store",
    {
      title: "Delete data store",
      description:
        "Schedule an entire data store for deletion. It can be restored with roblox_undelete_data_store for 30 days, after which all its data is permanently removed. " +
        "Scope: universe-datastores.control:delete.",
      write: true,
      destructive: true,
      input: { universeId: optionalUniverseId, dataStore },
    },
    async ({ universeId, dataStore }) =>
      (
        await ctx.client.request({
          method: "DELETE",
          path: `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/data-stores/${seg(dataStore)}`,
        })
      ).data ?? `Data store "${dataStore}" scheduled for deletion.`,
  );

  defineTool(
    server,
    ctx,
    "roblox_undelete_data_store",
    {
      title: "Restore deleted data store",
      description: "Restore a data store that was scheduled for deletion. Scope: universe-datastores.control:create.",
      write: true,
      idempotent: true,
      input: { universeId: optionalUniverseId, dataStore },
    },
    async ({ universeId, dataStore }) =>
      (
        await ctx.client.request({
          method: "POST",
          path: `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/data-stores/${seg(dataStore)}:undelete`,
          json: {},
        })
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_snapshot_data_stores",
    {
      title: "Snapshot data stores",
      description:
        "Take a snapshot of all data stores in the experience, guaranteeing current values are retained as a revision (useful before a risky migration). " +
        "Limited to one snapshot per UTC day. Scope: universe-datastores.control:snapshot.",
      write: true,
      input: { universeId: optionalUniverseId },
    },
    async ({ universeId }) =>
      (
        await ctx.client.request({
          method: "POST",
          path: `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/data-stores:snapshot`,
          json: {},
        })
      ).data,
  );

  // ----- Ordered data stores (leaderboards) -------------------------------

  const orderedStore = z.string().min(1).describe("Ordered data store name.");
  const orderedScope = z.string().default("global").describe('Scope. Defaults to "global".');
  const orderedPath = (universeId: string | undefined, store: string, scopeId: string) =>
    `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/ordered-data-stores/${seg(store)}/scopes/${seg(scopeId)}/entries`;

  defineTool(
    server,
    ctx,
    "roblox_list_ordered_data_store_entries",
    {
      title: "List ordered data store (leaderboard)",
      description:
        "List entries of an ordered data store sorted by value, e.g. a leaderboard. Scope: universe.ordered-data-store.scope.entry:read.",
      input: {
        universeId: optionalUniverseId,
        orderedDataStore: orderedStore,
        scope: orderedScope,
        descending: z.boolean().default(true).describe("Highest values first."),
        minValue: z.number().int().optional(),
        maxValue: z.number().int().optional(),
        pageSize,
        pageToken,
      },
    },
    async ({ universeId, orderedDataStore, scope, descending, minValue, maxValue, pageSize, pageToken }) => {
      const filter = [minValue !== undefined && `entry >= ${minValue}`, maxValue !== undefined && `entry <= ${maxValue}`]
        .filter(Boolean)
        .join(" && ");
      return (
        await ctx.client.get(orderedPath(universeId, orderedDataStore, scope), {
          orderBy: descending ? "value desc" : "value",
          filter: filter || undefined,
          maxPageSize: pageSize,
          pageToken,
        })
      ).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_get_ordered_data_store_entry",
    {
      title: "Get ordered data store entry",
      description: "Get one entry of an ordered data store. Scope: universe.ordered-data-store.scope.entry:read.",
      input: { universeId: optionalUniverseId, orderedDataStore: orderedStore, scope: orderedScope, key },
    },
    async ({ universeId, orderedDataStore, scope, key }) =>
      (await ctx.client.get(`${orderedPath(universeId, orderedDataStore, scope)}/${seg(key)}`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_set_ordered_data_store_entry",
    {
      title: "Set ordered data store entry",
      description: "Create or overwrite an ordered data store entry with an integer value. Scope: universe.ordered-data-store.scope.entry:write.",
      write: true,
      destructive: true,
      idempotent: true,
      input: { universeId: optionalUniverseId, orderedDataStore: orderedStore, scope: orderedScope, key, value: z.number().int() },
    },
    async ({ universeId, orderedDataStore, scope, key, value }) =>
      (
        await ctx.client.request({
          method: "PATCH",
          path: `${orderedPath(universeId, orderedDataStore, scope)}/${seg(key)}`,
          query: { allowMissing: true },
          json: { value },
        })
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_increment_ordered_data_store_entry",
    {
      title: "Increment ordered data store entry",
      description: "Atomically add to an ordered data store entry. Scope: universe.ordered-data-store.scope.entry:write.",
      write: true,
      input: { universeId: optionalUniverseId, orderedDataStore: orderedStore, scope: orderedScope, key, amount: z.number().int() },
    },
    async ({ universeId, orderedDataStore, scope, key, amount }) =>
      (
        await ctx.client.request({
          method: "POST",
          path: `${orderedPath(universeId, orderedDataStore, scope)}/${seg(key)}:increment`,
          json: { amount },
        })
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_delete_ordered_data_store_entry",
    {
      title: "Delete ordered data store entry",
      description: "Delete an ordered data store entry. Scope: universe.ordered-data-store.scope.entry:write.",
      write: true,
      destructive: true,
      idempotent: true,
      input: { universeId: optionalUniverseId, orderedDataStore: orderedStore, scope: orderedScope, key },
    },
    async ({ universeId, orderedDataStore, scope, key }) => {
      await ctx.client.request({ method: "DELETE", path: `${orderedPath(universeId, orderedDataStore, scope)}/${seg(key)}` });
      return `Deleted "${key}" from ordered data store "${orderedDataStore}".`;
    },
  );
}
