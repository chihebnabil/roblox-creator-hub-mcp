import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, defineTool, id, optionalUniverseId, pageSize, pageToken, resolveUniverse, seg, type ToolContext } from "./common.js";

const userId = id("Roblox user ID.");
const placeId = id("Restrict to a single place instead of the whole experience.").optional();

export function registerModerationTools(server: McpServer, ctx: ToolContext): void {
  const restrictions = (universeId?: string, place?: string) =>
    `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}${place ? `/places/${seg(place)}` : ""}/user-restrictions`;

  const setRestriction = (universeId: string | undefined, place: string | undefined, user: string, gameJoinRestriction: object) =>
    ctx.client.request({
      method: "PATCH",
      path: `${restrictions(universeId, place)}/${seg(user)}`,
      query: { updateMask: "gameJoinRestriction" },
      json: { gameJoinRestriction },
    });

  defineTool(
    server,
    ctx,
    "roblox_list_bans",
    {
      title: "List bans",
      description: "List users currently banned from the experience (or a place). Scope: universe.user-restriction:read.",
      input: { universeId: optionalUniverseId, placeId, pageSize, pageToken },
    },
    async ({ universeId, placeId, pageSize, pageToken }) =>
      (await ctx.client.get(restrictions(universeId, placeId), { maxPageSize: pageSize, pageToken })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_get_ban",
    {
      title: "Get user ban status",
      description: "Get a user's ban (join restriction) status in the experience or a place. Scope: universe.user-restriction:read.",
      input: { universeId: optionalUniverseId, placeId, userId },
    },
    async ({ universeId, placeId, userId }) => (await ctx.client.get(`${restrictions(universeId, placeId)}/${seg(userId)}`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_ban_user",
    {
      title: "Ban user",
      description:
        "Ban a user from the experience (or a single place). Omit durationSeconds for a permanent ban. Alt accounts are also banned unless excludeAltAccounts is true. " +
        "Scope: universe.user-restriction:write.",
      write: true,
      destructive: true,
      idempotent: true,
      input: {
        universeId: optionalUniverseId,
        placeId,
        userId,
        durationSeconds: z.number().int().min(1).max(315_576_000_000).optional().describe("Ban length in seconds. Omit for permanent."),
        displayReason: z.string().max(400).describe("Reason shown to the banned user."),
        privateReason: z.string().max(1000).optional().describe("Internal note, not shown to the user."),
        excludeAltAccounts: z.boolean().optional(),
      },
    },
    async ({ universeId, placeId, userId, durationSeconds, displayReason, privateReason, excludeAltAccounts }) =>
      (
        await setRestriction(
          universeId,
          placeId,
          userId,
          compact({
            active: true,
            duration: durationSeconds ? `${durationSeconds}s` : undefined,
            displayReason,
            privateReason: privateReason ?? displayReason,
            excludeAltAccounts,
          }),
        )
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_unban_user",
    {
      title: "Unban user",
      description: "Lift a user's ban from the experience (or a single place). Scope: universe.user-restriction:write.",
      write: true,
      idempotent: true,
      input: { universeId: optionalUniverseId, placeId, userId },
    },
    async ({ universeId, placeId, userId }) => (await setRestriction(universeId, placeId, userId, { active: false })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_list_ban_logs",
    {
      title: "List ban history",
      description: "List the history of ban/unban actions in the experience, optionally for one user or place. Scope: universe.user-restriction:read.",
      input: {
        universeId: optionalUniverseId,
        userId: id("Only logs for this user.").optional(),
        placeId: id("Only logs for this place.").optional(),
        pageSize,
        pageToken,
      },
    },
    async ({ universeId, userId, placeId, pageSize, pageToken }) => {
      const filter = [userId && `user == 'users/${userId}'`, placeId && `place == 'places/${placeId}'`].filter(Boolean).join(" && ");
      return (
        await ctx.client.get(`/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/user-restrictions:listLogs`, {
          filter: filter || undefined,
          maxPageSize: pageSize,
          pageToken,
        })
      ).data;
    },
  );
}
