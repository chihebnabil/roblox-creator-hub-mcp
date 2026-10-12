# Roblox Creator Hub MCP

A local [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) manage your Roblox experiences through the [Open Cloud API](https://create.roblox.com/docs/cloud), using an **API key** from Creator Hub.

It runs on your machine over stdio. Your API key stays in your local MCP config and is only ever sent to `*.roblox.com`.

## What it can do

84 tools, grouped by area:

| Area | Tools |
| --- | --- |
| **Experiences & places** | `roblox_get_universe`, `roblox_update_universe`, `roblox_get_place`, `roblox_update_place`, `roblox_publish_place` (upload `.rbxl`/`.rbxlx`), `roblox_restart_servers`, `roblox_publish_message` (MessagingService) |
| **Data stores** | `roblox_list_data_stores`, `roblox_list_data_store_entries`, `roblox_get_data_store_entry` (incl. past revisions / point in time), `roblox_set_data_store_entry`, `roblox_increment_data_store_entry`, `roblox_delete_data_store_entry`, `roblox_list_data_store_entry_revisions`, `roblox_delete_data_store`, `roblox_undelete_data_store`, `roblox_snapshot_data_stores` |
| **Ordered data stores** (leaderboards) | `roblox_list_ordered_data_store_entries`, `roblox_get_ordered_data_store_entry`, `roblox_set_ordered_data_store_entry`, `roblox_increment_ordered_data_store_entry`, `roblox_delete_ordered_data_store_entry` |
| **Memory stores** | `roblox_list_sorted_map_items`, `roblox_get_sorted_map_item`, `roblox_set_sorted_map_item`, `roblox_delete_sorted_map_item`, `roblox_queue_add`, `roblox_queue_read`, `roblox_queue_discard`, `roblox_flush_memory_store` |
| **Assets** | `roblox_upload_asset` (audio, decals/images, models, animations, video), `roblox_update_asset`, `roblox_get_asset`, `roblox_get_asset_operation`, `roblox_list_asset_versions`, `roblox_rollback_asset`, `roblox_archive_asset`, `roblox_restore_asset` |
| **Moderation** | `roblox_list_bans`, `roblox_get_ban`, `roblox_ban_user`, `roblox_unban_user`, `roblox_list_ban_logs` |
| **Luau execution** | `roblox_run_luau` (run a script headlessly against a place and get results + `print` logs), `roblox_get_luau_task` |
| **Place instances** | `roblox_get_instance`, `roblox_list_instance_children`, `roblox_update_script_source` |
| **Game servers & crashes** | `roblox_list_server_crashes` (servers that crashed or ran out of memory), `roblox_get_game_server_logs` (errors and stack traces for one server), `roblox_list_game_servers`, `roblox_get_game_server_filter_options`, `roblox_list_place_versions` |
| **Analytics** | `roblox_query_analytics` (time series metrics with breakdowns, as in the Creator Hub dashboards) |
| **Ad campaigns** (Ads Manager) | `roblox_list_ad_campaigns`, `roblox_get_ad_campaign`, `roblox_get_ad_campaign_status`, `roblox_create_ad_campaign`, `roblox_update_ad_campaign` (rename, budget, schedule, pause/resume/cancel), `roblox_get_ad_campaign_options`, `roblox_list_advertisable_universes`, `roblox_list_ad_creatives`, `roblox_list_ad_billing_accounts` |
| **Monetization** | `roblox_list_game_passes`, `roblox_get_game_pass`, `roblox_create_game_pass`, `roblox_update_game_pass`, `roblox_list_developer_products`, `roblox_get_developer_product`, `roblox_create_developer_product`, `roblox_update_developer_product` |
| **Users** | `roblox_get_user`, `roblox_get_user_thumbnail`, `roblox_list_user_inventory`, `roblox_send_user_notification` |
| **Groups** | `roblox_get_group`, `roblox_list_group_roles`, `roblox_list_group_members`, `roblox_set_group_member_role`, `roblox_list_group_join_requests`, `roblox_review_group_join_request` |
| **Everything else** | `roblox_search_endpoints`, `roblox_describe_endpoint`, `roblox_api_request` |

The last three cover the rest of Open Cloud. The server ships a catalog of the **254 endpoints that accept API keys**, generated from Roblox's official OpenAPI spec. That covers analytics, badges, localization, matchmaking, secrets, thumbnails, ads, the creator store and more. The model can search the catalog, read an endpoint's parameters and required scopes, and then call it with `roblox_api_request`.

## 1. Create an API key

1. Open **[Creator Hub → Credentials → API Keys](https://create.roblox.com/dashboard/credentials)** and click **Create API Key**. To manage group-owned experiences, switch to the group first.
2. Under **Access Permissions**, add each API system you want to use. Select the experience(s) and the operations (read/write) for each one. Common ones:

   | To use… | Add API system | Operations |
   | --- | --- | --- |
   | Experience/place info & settings | `universe`, `universe.place` | read, write |
   | Publishing place files | `universe-places` | write |
   | Restart servers | `universe` | write |
   | MessagingService | `universe-messaging-service` | publish |
   | Data stores | `universe-datastores` (Standard Data Stores) | list/read/create/update/delete, versions |
   | Ordered data stores | `universe.ordered-data-store` | read, write |
   | Memory stores | `memory-store` | read, write, queue, flush |
   | Assets | `asset` | read, write |
   | Bans | `universe.user-restriction` | read, write |
   | Luau execution | `universe.place.luau-execution-session` | read, write |
   | Place instances | `universe.place.instance` | read, write |
   | Game passes / developer products | `game-pass`, `developer-product` | read, write |
   | Groups | `group` | read, write |
   | Game servers, crash logs, place versions | `universe`, `universe.place` | read |
   | Analytics | `universe.analytics` | read |
   | Ad campaigns | `ad.campaign` (and `ad.billing` for billing accounts) | read, write |
   | User inventory / notifications | `user.inventory-item`, `user.user-notification` | read / write |

   Every tool description lists its exact scope, and `roblox_describe_endpoint` shows the scopes for any endpoint.
3. Under **Security**, add your IP to **Accepted IP Addresses**, or `0.0.0.0/0` to allow any IP. Set an expiration if you want one.
4. Click **Save & Generate Key** and copy the key. Roblox shows it only once.

> Give the key only the permissions you need. To browse safely, start with read-only permissions or set `ROBLOX_READ_ONLY=true` (see below).

You also need the **universe ID** of your experience, which is different from the place ID. In Creator Hub, open the experience, click **⋯** on its tile and choose **Copy Universe ID**.

## 2. Install

Requires Node.js 20+. The server is published on npm as [`@studmill/roblox-creator-hub-mcp`](https://www.npmjs.com/package/@studmill/roblox-creator-hub-mcp). The MCP configs below run it with `npx`, so there is nothing to install by hand.

To run it from source instead, clone the repo, run `npm install && npm run build`, and replace `npx -y @studmill/roblox-creator-hub-mcp` with `node /absolute/path/to/roblox-creator-hub-mcp/dist/index.js` in the configs below.

## 3. Connect it to your MCP client

### Claude Code

```bash
claude mcp add roblox \
  -e ROBLOX_API_KEY=your-api-key \
  -e ROBLOX_UNIVERSE_ID=1234567890 \
  -e ROBLOX_PLACE_ID=9876543210 \
  -- npx -y @studmill/roblox-creator-hub-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json`. Open it from **Settings → Developer → Edit Config**. It lives at `~/Library/Application Support/Claude/` on macOS and `%APPDATA%\Claude\` on Windows.

```json
{
  "mcpServers": {
    "roblox": {
      "command": "npx",
      "args": ["-y", "@studmill/roblox-creator-hub-mcp"],
      "env": {
        "ROBLOX_API_KEY": "your-api-key",
        "ROBLOX_UNIVERSE_ID": "1234567890",
        "ROBLOX_PLACE_ID": "9876543210"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Cursor / VS Code / other clients

Use the same `command`, `args` and `env` in the client's MCP settings: `.cursor/mcp.json` for Cursor, or `.vscode/mcp.json` with a `"servers"` key for VS Code.

### Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `ROBLOX_API_KEY` | ✅ | Your Open Cloud API key. |
| `ROBLOX_UNIVERSE_ID` | | Default universe (experience) ID, used whenever a tool call omits `universeId`. |
| `ROBLOX_PLACE_ID` | | Default place ID, used whenever a tool call omits `placeId`. |
| `ROBLOX_READ_ONLY` | | `true` hides every tool that changes data. `roblox_api_request` stays available but only for `GET`. |
| `ROBLOX_TIMEOUT_MS` | | Per-request timeout. Default `60000`. |
| `ROBLOX_MAX_RETRIES` | | Retries on 429/5xx, honouring `Retry-After`. Default `3`. |

## Example prompts

- "Show me the settings of my experience and turn on voice chat."
- "List the keys in the `PlayerData` data store starting with `user_` and show me player 123456's data."
- "Player 123456 lost their coins yesterday. Show their entry as it was at 2026-10-11T12:00:00Z and restore it."
- "Ban user 98765 for 3 days for exploiting, then show me the ban log."
- "Upload `C:\art\logo.png` as a decal owned by my user 42."
- "Publish `./build/game.rbxl` to my place, then restart outdated servers."
- "Run a Luau script in my place that counts the parts in Workspace."
- "Did any servers crash on the latest version? Show me the errors before each crash."
- "List my ad campaigns and pause the ones that aren't serving."
- "Create a $20/day PLAYS campaign for my experience in the US and UK for 7 days starting tomorrow, using image asset 123."
- "Create a VIP game pass for 199 Robux."
- "Show my experience's top 10 on the `Wins` ordered data store."
- "Find the Open Cloud endpoint for creating badges and create one called 'First Win'."

## Safety notes

- Tools that change data carry MCP annotations (`readOnlyHint`, `destructiveHint`), so clients can ask before running them. Deleting data stores, flushing memory stores, restarting servers and bans are all marked destructive.
- `ROBLOX_READ_ONLY=true` is the simplest way to let a model explore without risk.
- The API key goes only to `https://*.roblox.com`. Requests to any other host are refused, and tools cannot override the `x-api-key` header.
- `roblox_create_ad_campaign` and `roblox_update_ad_campaign` spend real money. The create tool sends an idempotency key, so a retry won't create a duplicate campaign.
- The Server Management, Analytics and Ads APIs are marked **beta** by Roblox and may change.
- `roblox_run_luau` runs in a temporary server. DataModel changes are not saved, but data store and other API calls made from the script are real.

## Development

```bash
npm run build            # compile to dist/
npm test                 # build + run the test suite (mocked Roblox API)
npm run inspect          # open the MCP Inspector against the built server
npm run generate-catalog # refresh src/catalog/endpoints.json from Roblox's OpenAPI spec
```

`npm run generate-catalog` downloads the official spec from [Roblox/creator-docs](https://github.com/Roblox/creator-docs/blob/main/content/en-us/reference/cloud/openapi.json). It keeps only the operations that accept API-key auth. You can also pass a local path: `node scripts/generate-catalog.mjs ./openapi.json`.

Project layout:

```
src/
  index.ts            stdio entrypoint
  server.ts           builds the MCP server and registers tools
  config.ts           environment configuration
  client.ts           Open Cloud HTTP client (auth, retries, errors, host allow-list)
  tools/              one module per API area
  catalog/            generated endpoint catalog
scripts/generate-catalog.mjs
test/                 node:test suite with an in-memory MCP client and fake fetch
```

## License

MIT
