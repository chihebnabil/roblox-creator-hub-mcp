import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sleep } from "../client.js";
import { compact, defineTool, id, optionalPlaceId, optionalUniverseId, pageSize, pageToken, resolvePlace, resolveUniverse, seg, type ToolContext } from "./common.js";

const SERVER_STATUSES = ["active", "shut_down", "restarted", "roblox_restarted", "crashed", "out_of_memory", "moderated", "pending"] as const;
const CRASH_STATUSES = ["crashed", "out_of_memory"];

const versionNumber = id("Place version number. Defaults to the latest published version.").optional();

interface PlaceVersionHistory {
  placeVersions?: { version?: string; isPublished?: boolean }[];
}

/** CEL filter for one or more statuses, combined with an optional extra expression. */
function statusFilter(statuses: readonly string[] | undefined, extra?: string): string | undefined {
  const parts: string[] = [];
  if (statuses?.length) {
    parts.push(statuses.length === 1 ? `status == "${statuses[0]}"` : `status in [${statuses.map((s) => `"${s}"`).join(", ")}]`);
  }
  if (extra) parts.push(`(${extra})`);
  return parts.length ? parts.join(" && ") : undefined;
}

export function registerServerTools(server: McpServer, ctx: ToolContext): void {
  const latestPublishedVersion = async (placeId: string): Promise<string> => {
    const res = await ctx.client.get<PlaceVersionHistory>(`/place-version-history-api/v1/${seg(placeId)}/history`, {
      isPublished: true,
      pageSize: 1,
    });
    const version = res.data?.placeVersions?.[0]?.version;
    if (!version) throw new Error(`Could not find a published version of place ${placeId}; pass versionNumber explicitly.`);
    return version;
  };

  const serversPath = async (universeId?: string, placeId?: string, version?: string) => {
    const place = resolvePlace(ctx, placeId);
    const resolvedVersion = version ?? (await latestPublishedVersion(place));
    return {
      version: resolvedVersion,
      path: `/server-management/v1/universes/${seg(resolveUniverse(ctx, universeId))}/places/${seg(place)}/versions/${seg(resolvedVersion)}/game-servers`,
    };
  };

  defineTool(
    server,
    ctx,
    "roblox_list_place_versions",
    {
      title: "List place versions",
      description: "List a place's saved/published versions (newest first) with who made them and when. Scope: universe.place:read.",
      input: {
        placeId: optionalPlaceId,
        isPublished: z.boolean().optional().describe("Only published (true) or only saved (false) versions."),
        pageSize: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional().describe("nextCursor from a previous response."),
      },
    },
    async ({ placeId, isPublished, pageSize, cursor }) =>
      (await ctx.client.get(`/place-version-history-api/v1/${seg(resolvePlace(ctx, placeId))}/history`, { isPublished, pageSize, cursor })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_list_game_servers",
    {
      title: "List game servers",
      description:
        "List live and recently shut down game servers for a place version, with status (active, crashed, out_of_memory, …), uptime, memory, FPS and players. " +
        "Use roblox_list_server_crashes for crashes only. Scope: universe:read.",
      input: {
        universeId: optionalUniverseId,
        placeId: optionalPlaceId,
        versionNumber,
        status: z.array(z.enum(SERVER_STATUSES)).optional().describe("Only servers with these statuses."),
        filter: z.string().optional().describe('Extra CEL filter, e.g. "memoryUsageBytes > 3000000000". See roblox_get_game_server_filter_options.'),
        orderBy: z.string().optional().describe('One field, optional " desc", e.g. "uptime desc".'),
        pageSize: z.number().int().min(0).max(100).optional(),
        pageToken,
      },
    },
    async ({ universeId, placeId, versionNumber, status, filter, orderBy, pageSize, pageToken }) => {
      const { version, path } = await serversPath(universeId, placeId, versionNumber);
      const res = await ctx.client.get<Record<string, unknown>>(path, {
        Filter: statusFilter(status, filter),
        OrderBy: orderBy,
        MaxPageSize: pageSize,
        PageToken: pageToken,
      });
      return { placeVersion: version, ...res.data };
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_list_server_crashes",
    {
      title: "List crashed servers",
      description:
        "List game servers that crashed or ran out of memory for a place version (default: latest published), newest first. " +
        "Then use roblox_get_game_server_logs with a jobId to read the errors and stack traces leading up to the crash. Scope: universe:read.",
      input: {
        universeId: optionalUniverseId,
        placeId: optionalPlaceId,
        versionNumber,
        includeOutOfMemory: z.boolean().default(true),
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken,
      },
    },
    async ({ universeId, placeId, versionNumber, includeOutOfMemory, pageSize, pageToken }) => {
      const { version, path } = await serversPath(universeId, placeId, versionNumber);
      const res = await ctx.client.get<Record<string, unknown>>(path, {
        Filter: statusFilter(includeOutOfMemory ? CRASH_STATUSES : ["crashed"]),
        OrderBy: "createTime desc",
        MaxPageSize: pageSize,
        PageToken: pageToken,
      });
      return { placeVersion: version, ...res.data };
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_get_game_server_filter_options",
    {
      title: "Game server filter options",
      description: "Show the fields and values that can be used to filter roblox_list_game_servers. Scope: universe:read.",
      input: { universeId: optionalUniverseId, placeId: optionalPlaceId, field: z.string().optional().describe("Only this filter field.") },
    },
    async ({ universeId, placeId, field }) =>
      (
        await ctx.client.get(
          `/server-management/v1/universes/${seg(resolveUniverse(ctx, universeId))}/places/${seg(resolvePlace(ctx, placeId))}/game-servers:filter-options`,
          { Filter: field },
        )
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_get_game_server_logs",
    {
      title: "Get game server logs",
      description:
        "Read a game server's output log (prints, warnings, errors with stack traces), e.g. to find the cause of a crash. " +
        "Get the jobId and versionNumber from roblox_list_server_crashes or roblox_list_game_servers. Scope: universe:read.",
      input: {
        universeId: optionalUniverseId,
        placeId: optionalPlaceId,
        versionNumber: id("Place version the server ran (placeVersion from the server listing)."),
        jobId: z.string().min(1).describe("Server job ID."),
        search: z.string().optional().describe("Case-insensitive full-text search in log messages."),
        filter: z.string().optional().describe('Extra CEL filter on severity, message_timestamp or search, e.g. message_timestamp >= "2026-10-12T00:00:00Z".'),
        newestFirst: z.boolean().default(true),
        pageSize: z.number().int().min(1).max(100).optional(),
        pageToken,
      },
    },
    async ({ universeId, placeId, versionNumber, jobId, search, filter, newestFirst, pageSize, pageToken }) => {
      const filters = [search && `search == ${JSON.stringify(search)}`, filter && `(${filter})`].filter(Boolean).join(" && ");
      return (
        await ctx.client.get(
          `/server-management/v1/universes/${seg(resolveUniverse(ctx, universeId))}/places/${seg(resolvePlace(ctx, placeId))}/versions/${seg(versionNumber)}/game-servers/${seg(jobId)}/logs`,
          {
            Filter: filters || undefined,
            OrderBy: newestFirst ? "message_timestamp desc" : "message_timestamp",
            MaxPageSize: pageSize,
            PageToken: pageToken,
          },
        )
      ).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_query_analytics",
    {
      title: "Query experience analytics",
      description:
        "Query a time series metric from the experience's analytics (the same data as the Creator Hub Analytics dashboards), " +
        "optionally broken down by dimensions such as platform or country. See https://create.roblox.com/docs/cloud/guides/analytics for metric and dimension names. " +
        "Scope: universe.analytics:read (rate limit: 30 queries/minute).",
      input: {
        universeId: optionalUniverseId,
        metric: z.string().min(1).describe("Metric name from the Analytics guide."),
        granularity: z.enum(["OneMinute", "HalfHour", "OneHour", "OneDay", "OneWeek", "OneMonth", "None"]).default("OneDay"),
        startTime: z.string().describe("Inclusive start, RFC 3339 (e.g. 2026-10-01T00:00:00Z)."),
        endTime: z.string().describe("Exclusive end, RFC 3339."),
        breakdown: z.array(z.string()).optional().describe("Dimensions to group by."),
        filter: z
          .array(
            z.object({
              dimension: z.string(),
              operation: z.enum(["In", "NotIn", "GreaterThan", "GreaterThanOrEqual", "LessThan", "LessThanOrEqual", "Match"]),
              values: z.array(z.string()),
            }),
          )
          .optional(),
        limit: z.number().int().min(1).optional().describe("Max breakdown series."),
        waitSeconds: z.number().int().min(0).max(120).default(60),
      },
    },
    async ({ universeId, waitSeconds, ...query }) => {
      const universe = seg(resolveUniverse(ctx, universeId));
      let op = (
        await ctx.client.request<{ path?: string; done?: boolean }>({
          method: "POST",
          path: `/analytics-query-api/v1/universes/${universe}/metrics`,
          json: compact(query),
        })
      ).data;
      const deadline = Date.now() + waitSeconds * 1000;
      let delay = 1_000;
      while (op && !op.done && op.path && Date.now() < deadline) {
        await sleep(delay);
        delay = Math.min(delay * 2, 5_000);
        const operationId = op.path.split("/").pop();
        op = (await ctx.client.get<typeof op>(`/analytics-query-api/v1/universes/${universe}/operations/metrics/${seg(operationId ?? "")}`)).data;
      }
      return op;
    },
  );
}
