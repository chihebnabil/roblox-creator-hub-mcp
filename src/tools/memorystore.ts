import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, defineTool, requireValue, optionalUniverseId, pageSize, pageToken, resolveUniverse, seg, type ToolContext } from "./common.js";

const ttl = z
  .string()
  .regex(/^\d+(\.\d+)?s$/, 'Use seconds with an "s" suffix, e.g. "3600s".')
  .describe('Time to live, e.g. "3600s" (max 45 days).');

export function registerMemoryStoreTools(server: McpServer, ctx: ToolContext): void {
  const memoryStore = (universeId?: string) => `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/memory-store`;
  const sortedMap = z.string().min(1).describe("Sorted map name.");
  const queue = z.string().min(1).describe("Queue name.");
  const itemId = z.string().min(1).describe("Item key.");

  defineTool(
    server,
    ctx,
    "roblox_list_sorted_map_items",
    {
      title: "List memory store sorted map",
      description:
        'List items in a MemoryStore sorted map. filter uses CEL on id/sortKey with <, > and &&, e.g. id > "a" && id < "m". Scope: memory-store.sorted-map:read.',
      input: {
        universeId: optionalUniverseId,
        sortedMap,
        descending: z.boolean().optional(),
        filter: z.string().optional(),
        pageSize,
        pageToken,
      },
    },
    async ({ universeId, sortedMap, descending, filter, pageSize, pageToken }) =>
      (
        await ctx.client.get(`${memoryStore(universeId)}/sorted-maps/${seg(sortedMap)}/items`, {
          orderBy: descending ? "id desc" : undefined,
          filter,
          maxPageSize: pageSize,
          pageToken,
        })
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_get_sorted_map_item",
    {
      title: "Get memory store sorted map item",
      description: "Get one item from a MemoryStore sorted map. Scope: memory-store.sorted-map:read.",
      input: { universeId: optionalUniverseId, sortedMap, itemId },
    },
    async ({ universeId, sortedMap, itemId }) =>
      (await ctx.client.get(`${memoryStore(universeId)}/sorted-maps/${seg(sortedMap)}/items/${seg(itemId)}`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_set_sorted_map_item",
    {
      title: "Set memory store sorted map item",
      description: "Create or overwrite an item in a MemoryStore sorted map. Scope: memory-store.sorted-map:write.",
      write: true,
      destructive: true,
      idempotent: true,
      input: {
        universeId: optionalUniverseId,
        sortedMap,
        itemId,
        value: z.any().describe("Any JSON value."),
        ttl,
        stringSortKey: z.string().optional(),
        numericSortKey: z.number().optional(),
      },
    },
    async ({ universeId, sortedMap, itemId, ...fields }) => {
      requireValue(fields.value, "value");
      return (
        await ctx.client.request({
          method: "PATCH",
          path: `${memoryStore(universeId)}/sorted-maps/${seg(sortedMap)}/items/${seg(itemId)}`,
          query: { allowMissing: true },
          json: compact(fields),
        })
      ).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_delete_sorted_map_item",
    {
      title: "Delete memory store sorted map item",
      description: "Delete an item from a MemoryStore sorted map. Scope: memory-store.sorted-map:write.",
      write: true,
      destructive: true,
      idempotent: true,
      input: { universeId: optionalUniverseId, sortedMap, itemId },
    },
    async ({ universeId, sortedMap, itemId }) => {
      await ctx.client.request({ method: "DELETE", path: `${memoryStore(universeId)}/sorted-maps/${seg(sortedMap)}/items/${seg(itemId)}` });
      return `Deleted "${itemId}" from sorted map "${sortedMap}".`;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_queue_add",
    {
      title: "Add item to memory store queue",
      description: "Add an item to a MemoryStore queue. Scope: memory-store.queue:write.",
      write: true,
      input: {
        universeId: optionalUniverseId,
        queue,
        data: z.any().describe("Any JSON value."),
        ttl,
        priority: z.number().optional().describe("Higher priority items are read first."),
      },
    },
    async ({ universeId, queue, ...fields }) => {
      requireValue(fields.data, "data");
      return (await ctx.client.request({ method: "POST", path: `${memoryStore(universeId)}/queues/${seg(queue)}/items`, json: compact(fields) })).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_queue_read",
    {
      title: "Read memory store queue",
      description:
        "Read items from the front of a MemoryStore queue. Items become invisible for invisibilityWindow; call roblox_queue_discard with the returned readId to remove them for good. " +
        "Scope: memory-store.queue:dequeue.",
      write: true,
      input: {
        universeId: optionalUniverseId,
        queue,
        count: z.number().int().min(1).max(200).optional(),
        allOrNothing: z.boolean().optional().describe("Fail unless `count` items are available."),
        invisibilityWindow: z.string().regex(/^\d+s$/).optional().describe('e.g. "30s" (default "30s").'),
      },
    },
    async ({ universeId, queue, count, allOrNothing, invisibilityWindow }) =>
      (await ctx.client.get(`${memoryStore(universeId)}/queues/${seg(queue)}/items:read`, { count, allOrNothing, invisibilityWindow })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_queue_discard",
    {
      title: "Discard read queue items",
      description: "Permanently remove items previously returned by roblox_queue_read. Scope: memory-store.queue:discard.",
      write: true,
      destructive: true,
      input: { universeId: optionalUniverseId, queue, readId: z.string().min(1) },
    },
    async ({ universeId, queue, readId }) =>
      (await ctx.client.request({ method: "POST", path: `${memoryStore(universeId)}/queues/${seg(queue)}/items:discard`, json: { readId } }))
        .data ?? "Discarded.",
  );

  defineTool(
    server,
    ctx,
    "roblox_flush_memory_store",
    {
      title: "Flush memory store",
      description: "Asynchronously delete ALL data in the experience's memory stores (sorted maps and queues). Irreversible. Scope: memory-store:flush.",
      write: true,
      destructive: true,
      input: { universeId: optionalUniverseId },
    },
    async ({ universeId }) => (await ctx.client.request({ method: "POST", path: `${memoryStore(universeId)}:flush`, json: {} })).data,
  );
}
