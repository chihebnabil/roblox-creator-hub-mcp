import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, fileBlob, id, optionalUniverseId, readLocalFile, resolveUniverse, seg, type ToolContext } from "./common.js";

type Kind = "game pass" | "developer product";

interface KindConfig {
  base: string;
  collection: string;
  tool: string;
  plural: string;
  idName: "gamePassId" | "productId";
  readScope: string;
  writeScope: string;
}

const KINDS: Record<Kind, KindConfig> = {
  "game pass": {
    base: "/game-passes/v1",
    collection: "game-passes",
    tool: "game_pass",
    plural: "game_passes",
    idName: "gamePassId",
    readScope: "game-pass:read",
    writeScope: "game-pass:write",
  },
  "developer product": {
    base: "/developer-products/v2",
    collection: "developer-products",
    tool: "developer_product",
    plural: "developer_products",
    idName: "productId",
    readScope: "developer-product:read",
    writeScope: "developer-product:write",
  },
};

const productFields = {
  description: z.string().optional(),
  price: z.number().int().min(0).optional().describe("Price in Robux."),
  isForSale: z.boolean().optional(),
  isManagedPricingEnabled: z.boolean().optional().describe("Let Roblox manage regional pricing."),
  imagePath: z.string().optional().describe("Absolute path to a local thumbnail image (.png/.jpg)."),
};

async function productForm(fields: Record<string, unknown>, imagePath?: string): Promise<FormData> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, String(value));
  }
  if (imagePath) {
    const image = await readLocalFile(imagePath);
    form.append("imageFile", fileBlob(image), image.name);
  }
  return form;
}

export function registerMonetizationTools(server: McpServer, ctx: ToolContext): void {
  for (const [kind, k] of Object.entries(KINDS) as [Kind, KindConfig][]) {
    const root = (universeId?: string) => `${k.base}/universes/${seg(resolveUniverse(ctx, universeId))}/${k.collection}`;
    const itemId = id(`The ${kind} ID.`);

    defineTool(
      server,
      ctx,
      `roblox_list_${k.plural}`,
      {
        title: `List ${kind}s`,
        description: `List the ${kind}s of an experience with price, sale status and IDs. Scope: ${k.readScope}.`,
        input: {
          universeId: optionalUniverseId,
          pageSize: z.number().int().min(1).max(100).optional(),
          pageToken: z.string().optional(),
        },
      },
      async ({ universeId, pageSize, pageToken }) => (await ctx.client.get(`${root(universeId)}/creator`, { pageSize, pageToken })).data,
    );

    defineTool(
      server,
      ctx,
      `roblox_get_${k.tool}`,
      {
        title: `Get ${kind}`,
        description: `Get one ${kind}'s configuration. Scope: ${k.readScope}.`,
        input: { universeId: optionalUniverseId, [k.idName]: itemId },
      },
      async (args) => (await ctx.client.get(`${root(args.universeId)}/${seg(String(args[k.idName]))}/creator`)).data,
    );

    defineTool(
      server,
      ctx,
      `roblox_create_${k.tool}`,
      {
        title: `Create ${kind}`,
        description: `Create a new ${kind} in an experience. Scope: ${k.writeScope}.`,
        write: true,
        input: { universeId: optionalUniverseId, name: z.string().min(1).max(50), ...productFields },
      },
      async ({ universeId, imagePath, ...fields }) =>
        (await ctx.client.request({ method: "POST", path: root(universeId), body: await productForm(fields, imagePath) })).data,
    );

    defineTool(
      server,
      ctx,
      `roblox_update_${k.tool}`,
      {
        title: `Update ${kind}`,
        description: `Update a ${kind}'s name, description, price, sale status or icon. Only fields you pass are changed. Scope: ${k.writeScope}.`,
        write: true,
        idempotent: true,
        input: { universeId: optionalUniverseId, [k.idName]: itemId, name: z.string().min(1).max(50).optional(), ...productFields },
      },
      async (args) => {
        const { universeId, imagePath, [k.idName]: itemIdValue, ...fields } = args as Record<string, unknown>;
        const res = await ctx.client.request({
          method: "PATCH",
          path: `${root(universeId as string | undefined)}/${seg(String(itemIdValue))}`,
          body: await productForm(fields, imagePath as string | undefined),
        });
        return res.data ?? `Updated ${kind} ${itemIdValue}.`;
      },
    );
  }
}
