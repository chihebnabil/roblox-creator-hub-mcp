export interface Config {
  apiKey: string;
  baseUrl: string;
  defaultUniverseId?: string;
  defaultPlaceId?: string;
  readOnly: boolean;
  timeoutMs: number;
  maxRetries: number;
}

function flag(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.ROBLOX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "ROBLOX_API_KEY is not set. Create an Open Cloud API key at " +
        "https://create.roblox.com/dashboard/credentials and pass it to the server via the ROBLOX_API_KEY environment variable.",
    );
  }
  return {
    apiKey,
    baseUrl: (env.ROBLOX_API_BASE_URL?.trim() || "https://apis.roblox.com").replace(/\/+$/, ""),
    defaultUniverseId: env.ROBLOX_UNIVERSE_ID?.trim() || undefined,
    defaultPlaceId: env.ROBLOX_PLACE_ID?.trim() || undefined,
    readOnly: flag(env.ROBLOX_READ_ONLY),
    timeoutMs: Number(env.ROBLOX_TIMEOUT_MS) || 60_000,
    maxRetries: env.ROBLOX_MAX_RETRIES !== undefined ? Number(env.ROBLOX_MAX_RETRIES) : 3,
  };
}
