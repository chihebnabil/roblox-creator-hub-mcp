import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RobloxClient } from "../dist/client.js";
import { loadConfig } from "../dist/config.js";
import { createServer } from "../dist/server.js";

/**
 * Starts the MCP server in-process against a fake fetch. `routes` maps
 * "METHOD /path" to a handler returning { status, json } (or a plain object as JSON).
 */
export async function startServer({ env = {}, routes = {} } = {}) {
  const config = loadConfig({ ROBLOX_API_KEY: "test-key", ROBLOX_MAX_RETRIES: "1", ...env });
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method ?? "GET", url: u, headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    const handler = routes[`${call.method} ${u.pathname}`];
    if (!handler) return new Response(JSON.stringify({ message: `no route for ${call.method} ${u.pathname}` }), { status: 404 });
    const result = await handler(call, calls);
    const { status = 200, json, headers = {} } = result && "status" in result ? result : { json: result };
    return new Response(json === undefined ? "" : JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  const server = createServer(config, new RobloxClient(config, fakeFetch));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);

  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.map((c) => c.text).join("\n");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: Boolean(result.isError), text, data };
  };
  return { client, call, calls, close: () => client.close() };
}
