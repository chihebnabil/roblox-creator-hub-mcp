import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServer } from "./helpers.mjs";

async function tempFile(name, contents) {
  const dir = await mkdtemp(join(tmpdir(), "rbx-mcp-"));
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

test("upload asset sends multipart form and waits for the operation", async () => {
  const filePath = await tempFile("logo.png", "PNGDATA");
  let polls = 0;
  const s = await startServer({
    routes: {
      "POST /assets/v1/assets": async (call) => {
        const form = call.body;
        assert.ok(form instanceof FormData);
        const request = JSON.parse(form.get("request"));
        assert.deepEqual(request, {
          assetType: "Decal",
          displayName: "Logo",
          description: "",
          creationContext: { creator: { userId: "42" } },
        });
        const file = form.get("fileContent");
        assert.equal(file.name, "logo.png");
        assert.equal(file.type, "image/png");
        assert.equal(await file.text(), "PNGDATA");
        return { path: "operations/op1", operationId: "op1", done: false };
      },
      "GET /assets/v1/operations/op1": () => (++polls < 2 ? { path: "operations/op1", done: false } : { path: "operations/op1", done: true, response: { assetId: "999" } }),
    },
  });
  const res = await s.call("roblox_upload_asset", { filePath, assetType: "Decal", displayName: "Logo", userId: "42" });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.data.done, true);
  assert.equal(res.data.response.assetId, "999");
  await s.close();
});

test("create game pass posts multipart fields", async () => {
  const s = await startServer({
    routes: {
      "POST /game-passes/v1/universes/3/game-passes": (call) => Object.fromEntries(call.body.entries()),
    },
  });
  const res = await s.call("roblox_create_game_pass", { universeId: "3", name: "VIP", price: 100, isForSale: true });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(res.data, { name: "VIP", price: "100", isForSale: "true" });
  await s.close();
});

test("publish place uploads the raw file", async () => {
  const filePath = await tempFile("game.rbxlx", "<roblox/>");
  const s = await startServer({
    routes: {
      "POST /universes/v1/1/places/2/versions": (call) => ({
        versionType: call.url.searchParams.get("versionType"),
        contentType: call.headers["content-type"],
        size: call.body.byteLength,
      }),
    },
  });
  const res = await s.call("roblox_publish_place", { universeId: "1", placeId: "2", filePath });
  assert.deepEqual(res.data, { versionType: "Published", contentType: "application/xml", size: 9 });
  await s.close();
});

test("stdio server completes the MCP handshake", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, ROBLOX_API_KEY: "test-key" },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "0.0.0" });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "roblox-creator-hub");
  const { tools } = await client.listTools();
  const getUniverse = tools.find((t) => t.name === "roblox_get_universe");
  assert.equal(getUniverse.inputSchema.properties.universeId.type, "string");
  await client.close();
});
