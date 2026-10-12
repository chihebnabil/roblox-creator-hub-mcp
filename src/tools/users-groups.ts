import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cloudV2OperationUrl,
  compact,
  defineTool,
  id,
  optionalUniverseId,
  pageSize,
  pageToken,
  resolveUniverse,
  seg,
  waitForOperation,
  type Operation,
  type ToolContext,
} from "./common.js";

const userId = id("Roblox user ID.");
const groupId = id("Group ID.");

export function registerUserAndGroupTools(server: McpServer, ctx: ToolContext): void {
  // ----- Users --------------------------------------------------------------

  defineTool(
    server,
    ctx,
    "roblox_get_user",
    {
      title: "Get user",
      description: "Get a Roblox user's public profile (name, display name, about, created date, premium/verified status where permitted). Scopes: user.advanced:read, user.social:read (for extra fields).",
      input: { userId },
    },
    async ({ userId }) => (await ctx.client.get(`/cloud/v2/users/${seg(userId)}`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_get_user_thumbnail",
    {
      title: "Get user avatar thumbnail",
      description: "Generate and return the URL of a user's avatar headshot thumbnail.",
      input: {
        userId,
        size: z.enum(["48", "50", "60", "75", "100", "110", "150", "180", "352", "420", "720"]).optional(),
        format: z.enum(["PNG", "JPEG"]).optional(),
        shape: z.enum(["ROUND", "SQUARE"]).optional(),
      },
    },
    async ({ userId, size, format, shape }) => {
      const op = (await ctx.client.get<Operation>(`/cloud/v2/users/${seg(userId)}:generateThumbnail`, { size, format, shape })).data;
      return waitForOperation(ctx, op, cloudV2OperationUrl, 20_000);
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_list_user_inventory",
    {
      title: "List user inventory",
      description:
        "List items in a user's inventory (assets, badges, game passes, private servers). Use filter to check ownership, e.g. " +
        '"gamePassIds=123", "badgeIds=1,2", "assetIds=5", or "inventoryItemAssetTypes=HAT,SHIRT". Scope: user.inventory-item:read.',
      input: { userId, filter: z.string().optional(), pageSize, pageToken },
    },
    async ({ userId, filter, pageSize, pageToken }) =>
      (await ctx.client.get(`/cloud/v2/users/${seg(userId)}/inventory-items`, { filter, maxPageSize: pageSize, pageToken })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_send_user_notification",
    {
      title: "Send experience notification",
      description:
        "Send an experience notification to a user using a notification template (create templates in Creator Dashboard > Engagement > Notifications). " +
        "Scope: user.user-notification:write.",
      write: true,
      input: {
        universeId: optionalUniverseId,
        userId,
        messageId: z.string().min(1).describe("Notification template (message) ID from Creator Dashboard."),
        parameters: z.record(z.string(), z.string()).optional().describe('Template parameters, e.g. {"egg_name": "royal egg"}.'),
        launchData: z.string().max(200).optional().describe("Data passed to the experience when the user joins from the notification."),
        category: z.string().optional().describe("Analytics category."),
      },
    },
    async ({ universeId, userId, messageId, parameters, launchData, category }) =>
      (
        await ctx.client.request({
          method: "POST",
          path: `/cloud/v2/users/${seg(userId)}/notifications`,
          json: {
            source: { universe: `universes/${resolveUniverse(ctx, universeId)}` },
            payload: compact({
              type: "MOMENT",
              messageId,
              parameters: parameters
                ? Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, { stringValue: v }]))
                : undefined,
              joinExperience: launchData !== undefined ? { launchData } : undefined,
              analyticsData: category ? { category } : undefined,
            }),
          },
        })
      ).data,
  );

  // ----- Groups -------------------------------------------------------------

  defineTool(
    server,
    ctx,
    "roblox_get_group",
    {
      title: "Get group",
      description: "Get a group's name, description, owner, member count and settings. Scope: group:read.",
      input: { groupId },
    },
    async ({ groupId }) => (await ctx.client.get(`/cloud/v2/groups/${seg(groupId)}`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_list_group_roles",
    {
      title: "List group roles",
      description: "List a group's roles (ranks) with their IDs and member counts. Scope: group:read.",
      input: { groupId, pageSize, pageToken },
    },
    async ({ groupId, pageSize, pageToken }) =>
      (await ctx.client.get(`/cloud/v2/groups/${seg(groupId)}/roles`, { maxPageSize: pageSize, pageToken })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_list_group_members",
    {
      title: "List group members",
      description: "List group memberships. Optionally only one user, or only members with a role. Scope: group:read.",
      input: {
        groupId,
        userId: id("Only this user's membership.").optional(),
        roleId: id("Only members with this role ID.").optional(),
        pageSize,
        pageToken,
      },
    },
    async ({ groupId, userId, roleId, pageSize, pageToken }) => {
      const filter = userId ? `user == 'users/${userId}'` : roleId ? `role == 'groups/${groupId}/roles/${roleId}'` : undefined;
      return (await ctx.client.get(`/cloud/v2/groups/${seg(groupId)}/memberships`, { filter, maxPageSize: pageSize, pageToken })).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_set_group_member_role",
    {
      title: "Assign/unassign group role",
      description: "Assign a role to (or remove a role from) a group member. Scope: group:write.",
      write: true,
      idempotent: true,
      input: { groupId, userId, roleId: id("Role ID (see roblox_list_group_roles)."), action: z.enum(["assign", "unassign"]).default("assign") },
    },
    async ({ groupId, userId, roleId, action }) => {
      const list = await ctx.client.get<{ groupMemberships?: { path: string }[] }>(`/cloud/v2/groups/${seg(groupId)}/memberships`, {
        filter: `user == 'users/${userId}'`,
      });
      const membership = list.data?.groupMemberships?.[0];
      if (!membership) throw new Error(`User ${userId} is not a member of group ${groupId}.`);
      return (
        await ctx.client.request({
          method: "POST",
          path: `/cloud/v2/${membership.path}:${action}Role`,
          json: { role: `groups/${groupId}/roles/${roleId}` },
        })
      ).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_list_group_join_requests",
    {
      title: "List group join requests",
      description: "List pending requests to join a group. Scope: group:read.",
      input: { groupId, userId: id("Only this user's request.").optional(), pageSize, pageToken },
    },
    async ({ groupId, userId, pageSize, pageToken }) =>
      (
        await ctx.client.get(`/cloud/v2/groups/${seg(groupId)}/join-requests`, {
          filter: userId ? `user == 'users/${userId}'` : undefined,
          maxPageSize: pageSize,
          pageToken,
        })
      ).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_review_group_join_request",
    {
      title: "Accept/decline group join request",
      description: "Accept or decline a user's pending request to join a group. Scope: group:write.",
      write: true,
      input: { groupId, userId, decision: z.enum(["accept", "decline"]) },
    },
    async ({ groupId, userId, decision }) => {
      const list = await ctx.client.get<{ groupJoinRequests?: { path: string }[] }>(`/cloud/v2/groups/${seg(groupId)}/join-requests`, {
        filter: `user == 'users/${userId}'`,
      });
      const request = list.data?.groupJoinRequests?.[0];
      if (!request) throw new Error(`No pending join request from user ${userId} in group ${groupId}.`);
      await ctx.client.request({ method: "POST", path: `/cloud/v2/${request.path}:${decision}`, json: {} });
      return `Join request from user ${userId} ${decision === "accept" ? "accepted" : "declined"}.`;
    },
  );
}
