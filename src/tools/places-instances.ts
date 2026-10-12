import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cloudV2OperationUrl,
  defineTool,
  optionalPlaceId,
  optionalUniverseId,
  pageSize,
  pageToken,
  resolvePlace,
  resolveUniverse,
  seg,
  waitForOperation,
  type Operation,
  type ToolContext,
} from "./common.js";

const instanceId = z.string().default("root").describe('Instance ID. "root" is the DataModel (game).');

export function registerInstanceTools(server: McpServer, ctx: ToolContext): void {
  const base = (universeId?: string, placeId?: string) =>
    `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/places/${seg(resolvePlace(ctx, placeId))}/instances`;

  const resolveOperation = async (op: Operation) => {
    const done = await waitForOperation(ctx, op, cloudV2OperationUrl, 30_000);
    if (done.error) throw new Error(`Operation failed: ${JSON.stringify(done.error)}`);
    return done.done ? done.response : done;
  };

  defineTool(
    server,
    ctx,
    "roblox_get_instance",
    {
      title: "Get place instance",
      description:
        "Read an Instance in the published place (e.g. a Script's Source, a Folder's properties). Start from \"root\" and walk down with roblox_list_instance_children. " +
        "Scope: universe.place.instance:read.",
      input: { universeId: optionalUniverseId, placeId: optionalPlaceId, instanceId },
    },
    async ({ universeId, placeId, instanceId }) =>
      resolveOperation((await ctx.client.get<Operation>(`${base(universeId, placeId)}/${seg(instanceId)}`)).data),
  );

  defineTool(
    server,
    ctx,
    "roblox_list_instance_children",
    {
      title: "List instance children",
      description: "List the child Instances of an Instance in the published place (IDs, names, classes). Scope: universe.place.instance:read.",
      input: { universeId: optionalUniverseId, placeId: optionalPlaceId, instanceId, pageSize, pageToken },
    },
    async ({ universeId, placeId, instanceId, pageSize, pageToken }) =>
      resolveOperation(
        (await ctx.client.get<Operation>(`${base(universeId, placeId)}/${seg(instanceId)}:listChildren`, { maxPageSize: pageSize, pageToken })).data,
      ),
  );

  defineTool(
    server,
    ctx,
    "roblox_update_script_source",
    {
      title: "Update script source",
      description:
        "Overwrite the Source of a Script, LocalScript or ModuleScript instance in the place and save it as a new place version (not published live until you publish). " +
        "Find the instance ID with roblox_list_instance_children. Scope: universe.place.instance:write.",
      write: true,
      destructive: true,
      idempotent: true,
      input: {
        universeId: optionalUniverseId,
        placeId: optionalPlaceId,
        instanceId: z.string().min(1),
        className: z.enum(["Script", "LocalScript", "ModuleScript"]),
        source: z.string(),
      },
    },
    async ({ universeId, placeId, instanceId, className, source }) =>
      resolveOperation(
        (
          await ctx.client.request<Operation>({
            method: "PATCH",
            path: `${base(universeId, placeId)}/${seg(instanceId)}`,
            query: { updateMask: `engineInstance.Details.${className}.Source` },
            json: { engineInstance: { Id: instanceId, Details: { [className]: { Source: source } } } },
          })
        ).data,
      ),
  );
}
