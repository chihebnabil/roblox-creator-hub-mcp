import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, defineTool, id, pageToken, seg, type ToolContext } from "./common.js";

const ADS = "/ads-management/v1";
const campaignId = z.string().min(1).describe("Campaign ID.");
const maxPageSize = z.number().int().min(1).max(100).optional();

/** Converts a USD amount to the API's micro-USD decimal string. */
export function usdToMicros(usd: number): string {
  return String(Math.round(usd * 1_000_000));
}

const schedule = {
  startTime: z.string().describe("When the campaign starts, RFC 3339 UTC (must not be in the past)."),
  durationInDays: z.number().int().min(1).max(3650),
};

export function registerAdsTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    "roblox_list_ad_campaigns",
    {
      title: "List ad campaigns",
      description:
        "List your Roblox Ads Manager campaigns (active first, then paused, then cancelled) with budget, schedule, targeting, status and delivery status. " +
        "Scope: ad.campaign:read.",
      input: { pageSize: maxPageSize, pageToken },
    },
    async ({ pageSize, pageToken }) => (await ctx.client.get(`${ADS}/campaigns`, { maxPageSize: pageSize, pageToken })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_get_ad_campaign",
    {
      title: "Get ad campaign",
      description: "Get one ad campaign. Scope: ad.campaign:read.",
      input: { campaignId },
    },
    async ({ campaignId }) => (await ctx.client.get(`${ADS}/campaigns/${seg(campaignId)}`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_get_ad_campaign_status",
    {
      title: "Get ad campaign statuses",
      description: "Get the status and delivery status (SERVING, IN_REVIEW, NOT_SERVING, REJECTED) with reasons for up to 100 campaigns. Scope: ad.campaign:read.",
      input: { campaignIds: z.array(z.string()).min(1).max(100) },
    },
    async ({ campaignIds }) => (await ctx.client.request({ method: "POST", path: `${ADS}/campaigns:batchGetStatus`, json: { campaignIds } })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_get_ad_campaign_options",
    {
      title: "Get ad campaign options",
      description:
        "Show the objectives, payment types, ad formats and targeting values accepted when creating a campaign. With universeId, also says whether that experience can be advertised and why not. " +
        "Scope: ad.campaign:read.",
      input: { universeId: id("Experience to check eligibility for.").optional(), objective: z.enum(["PLAYS", "ENGAGEMENT"]).optional() },
    },
    async ({ universeId, objective }) => (await ctx.client.get(`${ADS}/campaign-options`, { universeId, objective })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_list_advertisable_universes",
    {
      title: "List advertisable experiences",
      description: "List the universe IDs your ads billing account can advertise. Scope: ad.campaign:read.",
      input: {},
    },
    async () => (await ctx.client.get(`${ADS}/advertisable-universes`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_list_ad_creatives",
    {
      title: "List ad creatives",
      description: "List the reusable ad creatives (image assets) saved to your ads account, with moderation status. Scope: ad.campaign:read.",
      input: { isArchived: z.boolean().optional(), pageSize: maxPageSize, pageToken },
    },
    async ({ isArchived, pageSize, pageToken }) => (await ctx.client.get(`${ADS}/creatives`, { isArchived, maxPageSize: pageSize, pageToken })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_list_ad_billing_accounts",
    {
      title: "List ad billing accounts",
      description: "List your ads billing accounts (type, status, time zone). Scope: ad.billing:read.",
      input: { pageSize: maxPageSize, pageToken },
    },
    async ({ pageSize, pageToken }) => (await ctx.client.get(`${ADS}/billing-accounts`, { maxPageSize: pageSize, pageToken })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_create_ad_campaign",
    {
      title: "Create ad campaign",
      description:
        "Create a Roblox Ads campaign that spends real money from your ads billing account. Creatives must be existing image asset IDs (upload with roblox_upload_asset). " +
        "The campaign starts IN_REVIEW; check it with roblox_get_ad_campaign_status. Check roblox_get_ad_campaign_options first. Scope: ad.campaign:write.",
      write: true,
      input: {
        name: z.string().min(1),
        targetUniverseId: id("Experience to advertise (see roblox_list_advertisable_universes)."),
        objective: z.enum(["PLAYS", "ENGAGEMENT"]),
        paymentType: z.enum(["CREDIT_CARD", "ADS_CREDIT", "INVOICE"]),
        budgetUsd: z.number().positive().describe("Budget in US dollars, e.g. 25 for $25.00."),
        budgetType: z.enum(["DAILY", "LIFETIME"]),
        ...schedule,
        creativeAssetIds: z.array(z.coerce.string()).min(1).describe("Image asset IDs to show."),
        ageGroups: z.array(z.enum(["AGE_13_17", "AGE_18_24", "AGE_25_PLUS"])).optional().describe("Empty/omitted = all ages."),
        countries: z.array(z.string().length(2)).optional().describe('ISO country codes, e.g. ["US","GB"]. Omitted = all.'),
        devices: z.array(z.enum(["PHONE", "TABLET", "DESKTOP", "CONSOLE"])).optional().describe("Omitted = all devices."),
        idempotencyKey: z.string().uuid().optional().describe("Reuse the same UUID when retrying so the campaign isn't created twice."),
      },
    },
    async ({ budgetUsd, budgetType, startTime, durationInDays, ageGroups, countries, devices, idempotencyKey, ...fields }) => {
      const targeting = compact({ ageGroups, countries, devices });
      return (
        await ctx.client.request({
          method: "POST",
          path: `${ADS}/campaigns`,
          headers: { "x-idempotency-key": idempotencyKey ?? randomUUID() },
          json: {
            ...fields,
            budget: { amountMicros: usdToMicros(budgetUsd), type: budgetType },
            schedule: { startTime, durationInDays },
            ...(Object.keys(targeting).length ? { targeting } : {}),
          },
        })
      ).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_update_ad_campaign",
    {
      title: "Update ad campaign",
      description:
        "Rename, change the budget, reschedule (before start only), or pause/resume/cancel a campaign. CANCELLED is permanent. " +
        "Budget decreases on running campaigns apply at the next midnight in the account's time zone. Scope: ad.campaign:write.",
      write: true,
      destructive: true,
      input: {
        campaignId,
        name: z.string().min(1).optional(),
        budgetUsd: z.number().positive().optional(),
        status: z.enum(["ACTIVE", "PAUSED", "CANCELLED"]).optional().describe("ACTIVE = run/resume, PAUSED = pause, CANCELLED = stop permanently."),
        startTime: schedule.startTime.optional(),
        durationInDays: schedule.durationInDays.optional(),
      },
    },
    async ({ campaignId, name, budgetUsd, status, startTime, durationInDays }) => {
      const body = compact({
        name,
        status,
        budget: budgetUsd !== undefined ? { amountMicros: usdToMicros(budgetUsd) } : undefined,
        schedule: startTime || durationInDays ? compact({ startTime, durationInDays }) : undefined,
      });
      if (Object.keys(body).length === 0) throw new Error("Provide at least one field to update.");
      return (await ctx.client.request({ method: "PATCH", path: `${ADS}/campaigns/${seg(campaignId)}`, json: body })).data;
    },
  );
}
