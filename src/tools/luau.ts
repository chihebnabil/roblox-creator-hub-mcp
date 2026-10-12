import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sleep } from "../client.js";
import { compact, defineTool, id, optionalPlaceId, optionalUniverseId, resolvePlace, resolveUniverse, seg, type ToolContext } from "./common.js";

interface LuauTask {
  path: string;
  state?: string;
  output?: { results?: unknown[] };
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELLED"]);

async function fetchLogs(ctx: ToolContext, taskPath: string): Promise<string[]> {
  const res = await ctx.client.get<{ luauExecutionSessionTaskLogs?: { messages?: string[] }[] }>(`/cloud/v2/${taskPath}/logs`, {
    maxPageSize: 10_000,
  });
  return (res.data?.luauExecutionSessionTaskLogs ?? []).flatMap((log) => log.messages ?? []);
}

async function summarize(ctx: ToolContext, task: LuauTask, includeLogs: boolean) {
  const done = task.state !== undefined && TERMINAL.has(task.state);
  return compact({
    taskPath: task.path,
    state: task.state,
    results: task.output?.results,
    error: task.error,
    logs: includeLogs && done ? await fetchLogs(ctx, task.path).catch((e: Error) => [`(could not fetch logs: ${e.message})`]) : undefined,
    note: done ? undefined : "Task is still running; call roblox_get_luau_task with taskPath to check again.",
  });
}

export function registerLuauTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    "roblox_run_luau",
    {
      title: "Run Luau script in place",
      description:
        "Run a Luau script headlessly against a place (Open Cloud Luau Execution) and return its return values, print() logs and errors. " +
        "The script runs in a fresh server with the place's DataModel loaded; changes to the DataModel are NOT saved. Useful for inspecting the place, " +
        "running tests, or doing data store migrations with DataStoreService. Scope: universe.place.luau-execution-session:write.",
      write: true,
      input: {
        universeId: optionalUniverseId,
        placeId: optionalPlaceId,
        script: z.string().min(1).describe("Luau source. Use `return` to send values back (JSON-serialisable)."),
        versionId: id("Run against this place version instead of the latest.").optional(),
        timeoutSeconds: z.number().int().min(1).max(300).optional().describe("Script time limit (default 300)."),
        waitSeconds: z.number().int().min(0).max(600).default(120).describe("How long to wait for the result before returning the task path."),
        includeLogs: z.boolean().default(true),
      },
    },
    async ({ universeId, placeId, script, versionId, timeoutSeconds, waitSeconds, includeLogs }) => {
      const base = `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/places/${seg(resolvePlace(ctx, placeId))}`;
      const path = versionId ? `${base}/versions/${seg(versionId)}/luau-execution-session-tasks` : `${base}/luau-execution-session-tasks`;
      let task = (
        await ctx.client.request<LuauTask>({
          method: "POST",
          path,
          json: compact({ script, timeout: timeoutSeconds ? `${timeoutSeconds}s` : undefined }),
        })
      ).data;

      const deadline = Date.now() + waitSeconds * 1000;
      let delay = 1_000;
      while (!TERMINAL.has(task.state ?? "") && Date.now() < deadline) {
        await sleep(Math.min(delay, Math.max(deadline - Date.now(), 0)));
        delay = Math.min(delay * 1.5, 5_000);
        task = (await ctx.client.get<LuauTask>(`/cloud/v2/${task.path}`)).data;
      }
      return summarize(ctx, task, includeLogs);
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_get_luau_task",
    {
      title: "Get Luau task result",
      description: "Get the state, results, error and logs of a Luau execution task started by roblox_run_luau. Scope: universe.place.luau-execution-session:read.",
      input: {
        taskPath: z.string().min(1).describe('The taskPath returned by roblox_run_luau, e.g. "universes/1/places/2/versions/3/luau-execution-sessions/…/tasks/…".'),
        includeLogs: z.boolean().default(true),
      },
    },
    async ({ taskPath, includeLogs }) => {
      const clean = taskPath.replace(/^\/?(cloud\/v2\/)?/, "");
      return summarize(ctx, (await ctx.client.get<LuauTask>(`/cloud/v2/${clean}`)).data, includeLogs);
    },
  );
}
