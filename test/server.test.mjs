import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { startServer } from "./helpers.mjs";

test("lists tools and hides write tools in read-only mode", async () => {
  const full = await startServer();
  const ro = await startServer({ env: { ROBLOX_READ_ONLY: "true" } });
  const fullNames = (await full.client.listTools()).tools.map((t) => t.name);
  const roTools = (await ro.client.listTools()).tools;
  const roNames = roTools.map((t) => t.name);

  assert.ok(fullNames.length > 50, `expected many tools, got ${fullNames.length}`);
  assert.ok(fullNames.includes("roblox_set_data_store_entry"));
  assert.ok(!roNames.includes("roblox_set_data_store_entry"));
  assert.ok(roNames.includes("roblox_get_data_store_entry"));
  assert.ok(roNames.includes("roblox_api_request"), "generic request stays available for GETs");
  for (const tool of roTools.filter((t) => t.name !== "roblox_api_request")) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} should be read-only`);
  }
  await full.close();
  await ro.close();
});

test("sends the API key and uses the default universe", async () => {
  const s = await startServer({
    env: { ROBLOX_UNIVERSE_ID: "111" },
    routes: { "GET /cloud/v2/universes/111": () => ({ path: "universes/111", displayName: "My Game" }) },
  });
  const res = await s.call("roblox_get_universe");
  assert.equal(res.isError, false, res.text);
  assert.equal(res.data.displayName, "My Game");
  assert.equal(s.calls[0].headers["x-api-key"], "test-key");
  await s.close();
});

test("missing universe ID yields a helpful tool error", async () => {
  const s = await startServer();
  const res = await s.call("roblox_get_universe");
  assert.equal(res.isError, true);
  assert.match(res.text, /universeId is required/);
  await s.close();
});

test("set data store entry upserts with PATCH allowMissing and encodes keys", async () => {
  const s = await startServer({
    routes: {
      "PATCH /cloud/v2/universes/1/data-stores/Players/scopes/global/entries/user%2F42": (call) => ({
        echo: JSON.parse(call.body),
        allowMissing: call.url.searchParams.get("allowMissing"),
      }),
    },
  });
  const res = await s.call("roblox_set_data_store_entry", {
    universeId: "1",
    dataStore: "Players",
    scope: "global",
    key: "user/42",
    value: { coins: 10 },
    users: ["42"],
  });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(res.data.echo, { value: { coins: 10 }, users: ["users/42"] });
  assert.equal(res.data.allowMissing, "true");
  await s.close();
});

test("get data store entry at a revision", async () => {
  const s = await startServer({
    routes: { "GET /cloud/v2/universes/1/data-stores/S/entries/k@rev1": () => ({ value: 1 }) },
  });
  const res = await s.call("roblox_get_data_store_entry", { universeId: 1, dataStore: "S", key: "k", revisionId: "rev1" });
  assert.equal(res.isError, false, res.text);
  assert.deepEqual(res.data, { value: 1 });
  await s.close();
});

test("update universe builds an update mask from supplied fields only", async () => {
  const s = await startServer({
    routes: {
      "PATCH /cloud/v2/universes/5": (call) => ({ mask: call.url.searchParams.get("updateMask"), body: JSON.parse(call.body) }),
    },
  });
  const res = await s.call("roblox_update_universe", { universeId: "5", voiceChatEnabled: true, vrEnabled: false });
  assert.equal(res.data.mask, "voiceChatEnabled,vrEnabled");
  assert.deepEqual(res.data.body, { voiceChatEnabled: true, vrEnabled: false });
  await s.close();
});

test("ban user sends a game join restriction", async () => {
  const s = await startServer({
    routes: {
      "PATCH /cloud/v2/universes/9/user-restrictions/77": (call) => ({ mask: call.url.searchParams.get("updateMask"), body: JSON.parse(call.body) }),
    },
  });
  const res = await s.call("roblox_ban_user", { universeId: "9", userId: "77", durationSeconds: 3600, displayReason: "Exploiting" });
  assert.equal(res.data.mask, "gameJoinRestriction");
  assert.deepEqual(res.data.body.gameJoinRestriction, {
    active: true,
    duration: "3600s",
    displayReason: "Exploiting",
    privateReason: "Exploiting",
  });
  await s.close();
});

test("run luau polls until the task completes and returns logs", async () => {
  const taskPath = "universes/1/places/2/versions/3/luau-execution-sessions/s/tasks/t";
  let polls = 0;
  const s = await startServer({
    routes: {
      "POST /cloud/v2/universes/1/places/2/luau-execution-session-tasks": (call) => {
        assert.deepEqual(JSON.parse(call.body), { script: "return 1 + 1" });
        return { path: taskPath, state: "QUEUED" };
      },
      [`GET /cloud/v2/${taskPath}`]: () => (++polls < 2 ? { path: taskPath, state: "PROCESSING" } : { path: taskPath, state: "COMPLETE", output: { results: [2] } }),
      [`GET /cloud/v2/${taskPath}/logs`]: () => ({ luauExecutionSessionTaskLogs: [{ messages: ["hello"] }] }),
    },
  });
  const res = await s.call("roblox_run_luau", { universeId: "1", placeId: "2", script: "return 1 + 1" });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.data.state, "COMPLETE");
  assert.deepEqual(res.data.results, [2]);
  assert.deepEqual(res.data.logs, ["hello"]);
  await s.close();
});

test("API errors include status and a permission hint", async () => {
  const s = await startServer({
    routes: { "GET /cloud/v2/universes/1": () => ({ status: 403, json: { code: "PERMISSION_DENIED", message: "Insufficient scope" } }) },
  });
  const res = await s.call("roblox_get_universe", { universeId: "1" });
  assert.equal(res.isError, true);
  assert.match(res.text, /HTTP 403/);
  assert.match(res.text, /PERMISSION_DENIED: Insufficient scope/);
  assert.match(res.text, /Hint:/);
  await s.close();
});

test("retries on 429 then succeeds", async () => {
  let n = 0;
  const s = await startServer({
    routes: {
      "GET /cloud/v2/universes/1": () => (++n === 1 ? { status: 429, json: {}, headers: { "retry-after": "0" } } : { ok: true }),
    },
  });
  const res = await s.call("roblox_get_universe", { universeId: "1" });
  assert.equal(res.isError, false, res.text);
  assert.equal(n, 2);
  await s.close();
});

test("generic request refuses non-Roblox hosts and writes in read-only mode", async () => {
  const s = await startServer({ env: { ROBLOX_READ_ONLY: "1" } });
  const evil = await s.call("roblox_api_request", { path: "https://example.com/steal" });
  assert.equal(evil.isError, true);
  assert.match(evil.text, /Refusing to send the API key/);
  const write = await s.call("roblox_api_request", { method: "DELETE", path: "/cloud/v2/universes/1/data-stores/x" });
  assert.equal(write.isError, true);
  assert.match(write.text, /READ_ONLY/);
  await s.close();
});

test("endpoint catalog search finds badges and describes them", async () => {
  const s = await startServer();
  const res = await s.call("roblox_search_endpoints", { query: "badge" });
  assert.ok(res.data.some((e) => e.path.includes("badges")), res.text);
  const described = await s.call("roblox_describe_endpoint", { method: res.data[0].method, path: res.data[0].path });
  assert.equal(described.isError, false, described.text);
  assert.ok(Array.isArray(described.data.scopes));
  await s.close();
});

test("stdio entrypoint fails fast without an API key", async () => {
  const env = { ...process.env };
  delete env.ROBLOX_API_KEY;
  const child = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /ROBLOX_API_KEY is not set/);
});
