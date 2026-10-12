import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./helpers.mjs";

test("list server crashes resolves the latest published version and filters by status", async () => {
  const s = await startServer({
    env: { ROBLOX_UNIVERSE_ID: "1", ROBLOX_PLACE_ID: "2" },
    routes: {
      "GET /place-version-history-api/v1/2/history": (call) => {
        assert.equal(call.url.searchParams.get("isPublished"), "true");
        return { placeVersions: [{ version: "57", isPublished: true }] };
      },
      "GET /server-management/v1/universes/1/places/2/versions/57/game-servers": (call) => ({
        filter: call.url.searchParams.get("Filter"),
        orderBy: call.url.searchParams.get("OrderBy"),
        gameServers: [{ jobId: "job-1", status: "crashed" }],
      }),
    },
  });
  const res = await s.call("roblox_list_server_crashes");
  assert.equal(res.isError, false, res.text);
  assert.equal(res.data.placeVersion, "57");
  assert.equal(res.data.filter, 'status in ["crashed", "out_of_memory"]');
  assert.equal(res.data.orderBy, "createTime desc");
  assert.equal(res.data.gameServers[0].jobId, "job-1");
  await s.close();
});

test("game server logs combine search and filter", async () => {
  const s = await startServer({
    routes: {
      "GET /server-management/v1/universes/1/places/2/versions/57/game-servers/job-1/logs": (call) => ({
        filter: call.url.searchParams.get("Filter"),
        orderBy: call.url.searchParams.get("OrderBy"),
      }),
    },
  });
  const res = await s.call("roblox_get_game_server_logs", {
    universeId: "1",
    placeId: "2",
    versionNumber: "57",
    jobId: "job-1",
    search: "attempt to index nil",
  });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.data.filter, 'search == "attempt to index nil"');
  assert.equal(res.data.orderBy, "message_timestamp desc");
  await s.close();
});

test("create ad campaign converts USD to micros and sends an idempotency key", async () => {
  const s = await startServer({
    routes: {
      "POST /ads-management/v1/campaigns": (call) => ({ key: call.headers["x-idempotency-key"], body: JSON.parse(call.body) }),
    },
  });
  const res = await s.call("roblox_create_ad_campaign", {
    name: "Launch",
    targetUniverseId: "123",
    objective: "PLAYS",
    paymentType: "CREDIT_CARD",
    budgetUsd: 25.5,
    budgetType: "DAILY",
    startTime: "2026-11-01T00:00:00Z",
    durationInDays: 7,
    creativeAssetIds: [111],
    countries: ["US"],
  });
  assert.equal(res.isError, false, res.text);
  assert.match(res.data.key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(res.data.body, {
    name: "Launch",
    targetUniverseId: "123",
    objective: "PLAYS",
    paymentType: "CREDIT_CARD",
    creativeAssetIds: ["111"],
    budget: { amountMicros: "25500000", type: "DAILY" },
    schedule: { startTime: "2026-11-01T00:00:00Z", durationInDays: 7 },
    targeting: { countries: ["US"] },
  });
  await s.close();
});

test("update ad campaign sends only changed fields", async () => {
  const s = await startServer({
    routes: { "PATCH /ads-management/v1/campaigns/c1": (call) => ({ status: 200, json: JSON.parse(call.body) }) },
  });
  const res = await s.call("roblox_update_ad_campaign", { campaignId: "c1", status: "PAUSED", budgetUsd: 10 });
  assert.deepEqual(res.data, { status: "PAUSED", budget: { amountMicros: "10000000" } });
  await s.close();
});

test("campaign write tools are hidden in read-only mode, read tools remain", async () => {
  const s = await startServer({ env: { ROBLOX_READ_ONLY: "true" } });
  const names = (await s.client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("roblox_list_ad_campaigns"));
  assert.ok(names.includes("roblox_list_server_crashes"));
  assert.ok(!names.includes("roblox_create_ad_campaign"));
  assert.ok(!names.includes("roblox_update_ad_campaign"));
  await s.close();
});
