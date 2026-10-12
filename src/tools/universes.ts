import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  compact,
  defineTool,
  id,
  optionalPlaceId,
  optionalUniverseId,
  readLocalFile,
  resolvePlace,
  resolveUniverse,
  seg,
  updateMask,
  type ToolContext,
} from "./common.js";

const socialLink = z
  .object({ title: z.string().optional(), uri: z.string().url() })
  .describe("Social link shown on the experience page.");

export function registerUniverseTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    "roblox_get_universe",
    {
      title: "Get experience",
      description: "Get an experience (universe): name, description, visibility, owner, root place, device settings, social links. Scope: universe:read.",
      input: { universeId: optionalUniverseId },
    },
    async ({ universeId }) => (await ctx.client.get(`/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_update_universe",
    {
      title: "Update experience settings",
      description:
        "Update experience (universe) settings such as voice chat, private server price, supported devices and social links. " +
        "Only the fields you pass are changed. Name/description are changed on the root place via roblox_update_place. Scope: universe:write.",
      write: true,
      idempotent: true,
      input: {
        universeId: optionalUniverseId,
        voiceChatEnabled: z.boolean().optional(),
        privateServerPriceRobux: z.number().int().min(0).optional().describe("Price of private servers in Robux."),
        desktopEnabled: z.boolean().optional(),
        mobileEnabled: z.boolean().optional(),
        tabletEnabled: z.boolean().optional(),
        consoleEnabled: z.boolean().optional(),
        vrEnabled: z.boolean().optional(),
        facebookSocialLink: socialLink.optional(),
        twitterSocialLink: socialLink.optional(),
        youtubeSocialLink: socialLink.optional(),
        twitchSocialLink: socialLink.optional(),
        discordSocialLink: socialLink.optional(),
        robloxGroupSocialLink: socialLink.optional(),
        guildedSocialLink: socialLink.optional(),
      },
    },
    async ({ universeId, ...fields }) => {
      const body = compact(fields);
      const res = await ctx.client.request({
        method: "PATCH",
        path: `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}`,
        query: { updateMask: updateMask(body) },
        json: body,
      });
      return res.data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_get_place",
    {
      title: "Get place",
      description: "Get a place's name, description, server size and whether it is the root place. Scope: universe.place:read.",
      input: { universeId: optionalUniverseId, placeId: optionalPlaceId },
    },
    async ({ universeId, placeId }) =>
      (await ctx.client.get(`/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/places/${seg(resolvePlace(ctx, placeId))}`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_update_place",
    {
      title: "Update place",
      description:
        "Update a place's display name, description or max server size. Updating the root place's name/description also renames the experience. Scope: universe.place:write.",
      write: true,
      idempotent: true,
      input: {
        universeId: optionalUniverseId,
        placeId: optionalPlaceId,
        displayName: z.string().optional(),
        description: z.string().optional(),
        serverSize: z.number().int().min(1).max(700).optional().describe("Maximum players per server."),
      },
    },
    async ({ universeId, placeId, ...fields }) => {
      const body = compact(fields);
      const res = await ctx.client.request({
        method: "PATCH",
        path: `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}/places/${seg(resolvePlace(ctx, placeId))}`,
        query: { updateMask: updateMask(body) },
        json: body,
      });
      return res.data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_publish_place",
    {
      title: "Publish place file",
      description:
        "Upload a local .rbxl or .rbxlx file as a new version of a place. versionType 'Published' makes it live; 'Saved' only saves it. " +
        "Returns the new versionNumber. Scope: universe-places:write.",
      write: true,
      input: {
        universeId: optionalUniverseId,
        placeId: optionalPlaceId,
        filePath: z.string().describe("Absolute path to a local .rbxl (binary) or .rbxlx (XML) place file."),
        versionType: z.enum(["Published", "Saved"]).default("Published"),
      },
    },
    async ({ universeId, placeId, filePath, versionType }) => {
      const file = await readLocalFile(filePath);
      const res = await ctx.client.request({
        method: "POST",
        path: `/universes/v1/${seg(resolveUniverse(ctx, universeId))}/places/${seg(resolvePlace(ctx, placeId))}/versions`,
        query: { versionType },
        body: file.bytes,
        contentType: file.name.toLowerCase().endsWith(".rbxlx") ? "application/xml" : "application/octet-stream",
      });
      return res.data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_restart_servers",
    {
      title: "Restart servers",
      description:
        "Restart (shut down) the experience's live servers so players move to the latest version. " +
        "By default only servers running an outdated version are restarted. Scope: universe:write.",
      write: true,
      destructive: true,
      input: {
        universeId: optionalUniverseId,
        placeIds: z.array(id("Place ID")).optional().describe("Limit to these places. Default: all places."),
        closeAllVersions: z.boolean().optional().describe("Also restart servers already on the newest version."),
        bleedOffServers: z.boolean().optional().describe("Stop matchmaking into old servers and let them drain before shutting down."),
        bleedOffDurationMinutes: z.number().int().min(1).max(60).optional(),
      },
    },
    async ({ universeId, ...options }) => {
      const res = await ctx.client.request({
        method: "POST",
        path: `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}:restartServers`,
        json: compact(options),
      });
      return res.data ?? "Restart requested.";
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_publish_message",
    {
      title: "Publish MessagingService message",
      description:
        "Publish a message to all live servers on a MessagingService topic (received via MessagingService:SubscribeAsync). Scope: universe-messaging-service:publish.",
      write: true,
      input: {
        universeId: optionalUniverseId,
        topic: z.string().min(1).max(80),
        message: z.string().max(1024).describe("Message payload (string; JSON-encode structured data)."),
      },
    },
    async ({ universeId, topic, message }) => {
      const res = await ctx.client.request({
        method: "POST",
        path: `/cloud/v2/universes/${seg(resolveUniverse(ctx, universeId))}:publishMessage`,
        json: { topic, message },
      });
      return res.data ?? `Published to topic "${topic}".`;
    },
  );
}
