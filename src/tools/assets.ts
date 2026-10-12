import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  compact,
  defineTool,
  fileBlob,
  id,
  pageSize,
  pageToken,
  readLocalFile,
  seg,
  updateMask,
  waitForOperation,
  type Operation,
  type ToolContext,
} from "./common.js";

const assetId = id("Asset ID.");
const operationUrl = (op: Operation) => `/assets/v1/${op.path}`;
const wait = z.boolean().default(true).describe("Wait (up to ~60s) for processing to finish and return the final asset.");

export function registerAssetTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    ctx,
    "roblox_upload_asset",
    {
      title: "Upload asset",
      description:
        "Upload a local file as a new Roblox asset owned by a user or group. Supported: Audio (.mp3/.ogg/.wav/.flac), Decal/Image (.png/.jpg/.bmp/.tga), " +
        "Model (.fbx/.gltf/.glb/.rbxm/.rbxmx), Animation (.rbxm), Video (.mp4/.mov). Returns the asset (or the pending operation). Scopes: asset:read, asset:write.",
      write: true,
      input: {
        filePath: z.string().describe("Absolute path to the local file."),
        assetType: z.string().describe("Audio, Decal, Image, Model, Animation or Video."),
        displayName: z.string().min(1).max(50),
        description: z.string().max(1000).default(""),
        userId: id("Owner user ID (use this or groupId).").optional(),
        groupId: id("Owner group ID (use this or userId).").optional(),
        contentType: z.string().optional().describe("Override the MIME type guessed from the file extension."),
        expectedPrice: z.number().int().min(0).optional().describe("Max upload fee in Robux you accept; upload fails if higher."),
        wait,
      },
    },
    async ({ filePath, assetType, displayName, description, userId, groupId, contentType, expectedPrice, wait }) => {
      if (!userId === !groupId) throw new Error("Provide exactly one of userId or groupId.");
      const file = await readLocalFile(filePath, contentType);
      const form = new FormData();
      form.append(
        "request",
        JSON.stringify({
          assetType,
          displayName,
          description,
          creationContext: compact({
            creator: userId ? { userId } : { groupId },
            expectedPrice,
          }),
        }),
      );
      form.append("fileContent", fileBlob(file), file.name);
      const op = (await ctx.client.request<Operation>({ method: "POST", path: "/assets/v1/assets", body: form })).data;
      return wait ? waitForOperation(ctx, op, operationUrl) : op;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_update_asset",
    {
      title: "Update asset",
      description:
        "Update an asset's name/description and/or upload a new version of its content from a local file. Scopes: asset:read, asset:write.",
      write: true,
      input: {
        assetId,
        displayName: z.string().max(50).optional(),
        description: z.string().max(1000).optional(),
        filePath: z.string().optional().describe("Local file with the new content (creates a new asset version)."),
        contentType: z.string().optional(),
        wait,
      },
    },
    async ({ assetId, displayName, description, filePath, contentType, wait }) => {
      const fields = compact({ displayName, description });
      if (!filePath && Object.keys(fields).length === 0) throw new Error("Provide filePath and/or a field to update.");
      const form = new FormData();
      form.append("request", JSON.stringify({ assetId: Number(assetId), ...fields }));
      if (filePath) {
        const file = await readLocalFile(filePath, contentType);
        form.append("fileContent", fileBlob(file), file.name);
      }
      const op = (
        await ctx.client.request<Operation>({
          method: "PATCH",
          path: `/assets/v1/assets/${seg(assetId)}`,
          query: { updateMask: Object.keys(fields).length ? updateMask(fields) : undefined },
          body: form,
        })
      ).data;
      return wait ? waitForOperation(ctx, op, operationUrl) : op;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_get_asset",
    {
      title: "Get asset",
      description: "Get an asset's metadata, current version and moderation state. Scope: asset:read.",
      input: {
        assetId,
        readMask: z.string().optional().describe('Comma-separated extra fields, e.g. "description,displayName,icon,previews,socialLink".'),
      },
    },
    async ({ assetId, readMask }) => (await ctx.client.get(`/assets/v1/assets/${seg(assetId)}`, { readMask })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_get_asset_operation",
    {
      title: "Get asset operation",
      description: "Check the status of an asset upload/update operation. Scope: asset:read.",
      input: { operationId: z.string().min(1).describe('Operation ID (or a path like "operations/{id}").') },
    },
    async ({ operationId }) => (await ctx.client.get(`/assets/v1/operations/${seg(operationId.replace(/^operations\//, ""))}`)).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_list_asset_versions",
    {
      title: "List asset versions",
      description: "List the versions of an asset (newest first). Scope: asset:read.",
      input: { assetId, pageSize, pageToken },
    },
    async ({ assetId, pageSize, pageToken }) =>
      (await ctx.client.get(`/assets/v1/assets/${seg(assetId)}/versions`, { maxPageSize: pageSize, pageToken })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_rollback_asset",
    {
      title: "Roll back asset version",
      description: "Make an earlier version of an asset the current one. Scopes: asset:read, asset:write.",
      write: true,
      input: { assetId, versionNumber: z.number().int().min(1) },
    },
    async ({ assetId, versionNumber }) => {
      const form = new FormData();
      form.append("assetVersion", `assets/${assetId}/versions/${versionNumber}`);
      return (await ctx.client.request({ method: "POST", path: `/assets/v1/assets/${seg(assetId)}/versions:rollback`, body: form })).data;
    },
  );

  defineTool(
    server,
    ctx,
    "roblox_archive_asset",
    {
      title: "Archive asset",
      description: "Archive an asset so it is hidden and unusable in experiences (reversible with roblox_restore_asset). Scopes: asset:read, asset:write.",
      write: true,
      destructive: true,
      idempotent: true,
      input: { assetId },
    },
    async ({ assetId }) => (await ctx.client.request({ method: "POST", path: `/assets/v1/assets/${seg(assetId)}:archive` })).data,
  );

  defineTool(
    server,
    ctx,
    "roblox_restore_asset",
    {
      title: "Restore archived asset",
      description: "Restore an archived asset. Scopes: asset:read, asset:write.",
      write: true,
      idempotent: true,
      input: { assetId },
    },
    async ({ assetId }) => (await ctx.client.request({ method: "POST", path: `/assets/v1/assets/${seg(assetId)}:restore` })).data,
  );
}
