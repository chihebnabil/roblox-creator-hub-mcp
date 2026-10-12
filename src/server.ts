import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RobloxClient } from "./client.js";
import type { Config } from "./config.js";
import { registerAdsTools } from "./tools/ads.js";
import { registerAssetTools } from "./tools/assets.js";
import type { ToolContext } from "./tools/common.js";
import { registerDataStoreTools } from "./tools/datastores.js";
import { registerGenericTools } from "./tools/generic.js";
import { registerLuauTools } from "./tools/luau.js";
import { registerMemoryStoreTools } from "./tools/memorystore.js";
import { registerModerationTools } from "./tools/moderation.js";
import { registerMonetizationTools } from "./tools/monetization.js";
import { registerInstanceTools } from "./tools/places-instances.js";
import { registerServerTools } from "./tools/servers.js";
import { registerUniverseTools } from "./tools/universes.js";
import { registerUserAndGroupTools } from "./tools/users-groups.js";

export const SERVER_NAME = "roblox-creator-hub";
export const SERVER_VERSION = "0.1.0";

export function createServer(config: Config, client = new RobloxClient(config)): McpServer {
  const defaults = [
    config.defaultUniverseId && `default universe ${config.defaultUniverseId}`,
    config.defaultPlaceId && `default place ${config.defaultPlaceId}`,
  ].filter(Boolean);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Manage Roblox experiences through the Open Cloud API using the user's API key: experience/place settings, publishing, " +
        "data stores, ordered data stores, memory stores, assets, bans, Luau execution, game servers and crash logs, analytics, ad campaigns, users, groups, game passes and developer products. " +
        "A universe ID (experience) differs from a place ID. " +
        (defaults.length ? `Configured ${defaults.join(" and ")}; omit those IDs to use them. ` : "") +
        (config.readOnly ? "The server is in READ-ONLY mode; tools that change data are disabled. " : "") +
        "For anything without a dedicated tool, use roblox_search_endpoints, roblox_describe_endpoint and roblox_api_request. " +
        "On HTTP 401/403, the API key is missing a permission or the experience isn't added to it in Creator Dashboard.",
    },
  );

  const ctx: ToolContext = { client, config };
  registerUniverseTools(server, ctx);
  registerDataStoreTools(server, ctx);
  registerMemoryStoreTools(server, ctx);
  registerAssetTools(server, ctx);
  registerModerationTools(server, ctx);
  registerLuauTools(server, ctx);
  registerInstanceTools(server, ctx);
  registerServerTools(server, ctx);
  registerUserAndGroupTools(server, ctx);
  registerMonetizationTools(server, ctx);
  registerAdsTools(server, ctx);
  registerGenericTools(server, ctx);
  return server;
}
