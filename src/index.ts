import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const LOG_PREFIX = "[mcp-auto-reauth]";
const TOKEN_REFRESH_SKEW_SECONDS = 60;
const HTTP_TIMEOUT_MS = 10_000;

interface AuthTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

interface ClientInfo {
  clientId?: string;
  clientSecret?: string;
}

interface AuthEntry {
  clientInfo?: ClientInfo;
  serverUrl?: string;
  tokens?: AuthTokens;
  oauthState?: unknown;
  codeVerifier?: string;
}

type AuthFile = Record<string, AuthEntry>;

interface McpConfigEntry {
  type?: string;
  url?: string;
  enabled?: boolean;
  oauth?: boolean | object;
}

interface OpencodeConfig {
  mcp?: Record<string, McpConfigEntry | unknown>;
}

interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

type OpencodeClient = PluginInput["client"];

function getDataDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(appData, "opencode");
  }

  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode");
}

function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "opencode");
  }

  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "opencode");
}

function getAuthPath(): string {
  return join(getDataDir(), "mcp-auth.json");
}

function getLogPath(): string {
  return join(getDataDir(), "mcp-auto-reauth.log");
}

let logPath = getLogPath();
const authInFlight = new Set<string>();

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
  } catch {
    // Logging should never make OpenCode startup fail.
  }
}

function readAuthFile(path: string): AuthFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? (parsed as AuthFile) : null;
  } catch (err) {
    log(`${LOG_PREFIX} failed to read auth file: ${errorMessage(err)}`);
    return null;
  }
}

function writeAuthFile(path: string, auth: AuthFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Best effort on platforms that do not support POSIX modes.
  }
  renameSync(tmpPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tokenIsExpired(expiresAt: number | undefined): boolean {
  if (!expiresAt) return false;
  return Date.now() / 1000 >= expiresAt - TOKEN_REFRESH_SKEW_SECONDS;
}

function authEntryNeedsManualAuth(entry: AuthEntry): string | undefined {
  const tokens = entry.tokens;
  if (!tokens?.accessToken) return "no access token stored";
  if (!tokenIsExpired(tokens.expiresAt)) return undefined;
  if (!tokens.refreshToken) return "token expired and no refresh token is stored";
  if (!entry.clientInfo?.clientId) return "token expired and no OAuth client id is stored";
  return undefined;
}

function canStartInteractiveAuth(entry: AuthEntry): boolean {
  return !entry.tokens?.accessToken && !!entry.serverUrl;
}

function stripJsonCommentsAndTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    output += char;
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}

function readJsonc(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(readFileSync(path, "utf8")));
  } catch (err) {
    log(`${LOG_PREFIX} failed to parse config ${path}: ${errorMessage(err)}`);
    return undefined;
  }
}

function configCandidates(): string[] {
  const cwd = process.cwd();
  const global = getConfigDir();
  return [
    join(cwd, "opencode.jsonc"),
    join(cwd, "opencode.json"),
    join(cwd, ".opencode", "opencode.jsonc"),
    join(cwd, ".opencode", "opencode.json"),
    join(global, "opencode.jsonc"),
    join(global, "opencode.json"),
  ];
}

function readConfigs(): OpencodeConfig[] {
  return configCandidates()
    .map(readJsonc)
    .filter((value): value is OpencodeConfig => isRecord(value));
}

function isConfiguredOauthMcp(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (entry.enabled === false) return false;
  if (entry.oauth === false) return false;
  if (entry.type === "local") return false;
  return true;
}

function configuredMcpNames(configs: OpencodeConfig[]): string[] {
  const names = new Set<string>();
  for (const config of configs) {
    for (const [name, entry] of Object.entries(config.mcp ?? {})) {
      if (isConfiguredOauthMcp(entry)) names.add(name);
    }
  }
  return [...names];
}

function hasConfiguredMcp(configs: OpencodeConfig[], name: string): boolean {
  return configs.some((config) => isConfiguredOauthMcp(config.mcp?.[name]));
}

function configuredServerUrl(configs: OpencodeConfig[], name: string): string | undefined {
  for (const config of configs) {
    const entry = config.mcp?.[name];
    if (!isConfiguredOauthMcp(entry)) continue;
    if (isRecord(entry) && typeof entry.url === "string" && entry.url.length > 0) return entry.url;
  }
  return undefined;
}

function serverUrlFor(name: string, entry: AuthEntry, configs: OpencodeConfig[]): string | undefined {
  return entry.serverUrl || configuredServerUrl(configs, name);
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }

  const parsed = await response.json();
  if (!isRecord(parsed)) throw new Error(`GET ${url} did not return a JSON object`);
  return parsed;
}

function originFor(url: URL): string {
  return url.port ? `${url.protocol}//${url.hostname}:${url.port}` : `${url.protocol}//${url.hostname}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const parsed = new URL(serverUrl);
  const origin = originFor(parsed);
  const path = parsed.pathname.replace(/\/$/, "");
  return unique([
    `${origin}/.well-known/oauth-protected-resource${path}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ]);
}

function authorizationServerMetadataUrls(issuer: string): string[] {
  const parsed = new URL(issuer);
  const origin = originFor(parsed);
  const issuerWithoutSlash = issuer.replace(/\/$/, "");
  const path = parsed.pathname.replace(/\/$/, "");

  if (!path) {
    return unique([`${origin}/.well-known/oauth-authorization-server`, `${origin}/.well-known/openid-configuration`]);
  }

  return unique([
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${issuerWithoutSlash}/.well-known/oauth-authorization-server`,
    `${issuerWithoutSlash}/.well-known/openid-configuration`,
  ]);
}

function metadataStringValues(metadata: Record<string, unknown>, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string") values.push(value);
    if (Array.isArray(value)) {
      values.push(...value.filter((item): item is string => typeof item === "string"));
    }
  }
  return unique(values);
}

async function discoverAuthorizationServerTokenEndpoint(issuer: string): Promise<string | undefined> {
  for (const url of authorizationServerMetadataUrls(issuer)) {
    try {
      const metadata = await fetchJson(url);
      const tokenEndpoint = metadata.token_endpoint;
      if (typeof tokenEndpoint === "string") return tokenEndpoint;
    } catch (err) {
      log(`${LOG_PREFIX} OAuth authorization metadata unavailable at ${url}: ${errorMessage(err)}`);
    }
  }
  return undefined;
}

async function discoverTokenEndpoint(serverUrl: string): Promise<string> {
  for (const url of protectedResourceMetadataUrls(serverUrl)) {
    try {
      const metadata = await fetchJson(url);
      const tokenEndpoint = metadata.token_endpoint;
      if (typeof tokenEndpoint === "string") return tokenEndpoint;

      for (const issuer of metadataStringValues(metadata, [
        "authorization_servers",
        "authorization_server",
        "issuer",
      ])) {
        const discovered = await discoverAuthorizationServerTokenEndpoint(issuer);
        if (discovered) return discovered;
      }
    } catch (err) {
      log(`${LOG_PREFIX} OAuth protected-resource metadata unavailable at ${url}: ${errorMessage(err)}`);
    }
  }

  const origin = originFor(new URL(serverUrl));
  const fallback = await discoverAuthorizationServerTokenEndpoint(origin);
  if (fallback) return fallback;

  throw new Error(`could not discover OAuth token endpoint for ${serverUrl}`);
}

function formEncode(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  return params.toString();
}

async function refreshTokens(entry: AuthEntry, serverUrl: string): Promise<RefreshResult> {
  const refreshToken = entry.tokens?.refreshToken;
  const clientId = entry.clientInfo?.clientId;
  if (!refreshToken) throw new Error("missing refresh token");
  if (!clientId) throw new Error("missing OAuth client id");

  const tokenEndpoint = await discoverTokenEndpoint(serverUrl);
  const fields: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  };
  if (entry.clientInfo?.clientSecret) fields.client_secret = entry.clientInfo.clientSecret;

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: formEncode(fields),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`token endpoint returned ${response.status}`);
  }

  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || typeof parsed.access_token !== "string") {
    throw new Error("token endpoint response did not include access_token");
  }

  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : undefined;
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : refreshToken,
    expiresAt: expiresIn ? Date.now() / 1000 + expiresIn : undefined,
    scope: typeof parsed.scope === "string" ? parsed.scope : entry.tokens?.scope,
  };
}

function applyRefresh(entry: AuthEntry, serverUrl: string, refreshed: RefreshResult): void {
  entry.serverUrl = serverUrl;
  entry.tokens = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    scope: refreshed.scope,
  };
}

async function refreshExpiredAuthEntries(authPath: string, client: OpencodeClient, directory: string): Promise<void> {
  const auth = readAuthFile(authPath) ?? {};
  const configs = readConfigs();
  const entries = Object.entries(auth);
  const configuredNames = configuredMcpNames(configs);
  let changed = false;

  log(`${LOG_PREFIX} checking ${entries.length} stored auth entr${entries.length === 1 ? "y" : "ies"}`);

  for (const [name, entry] of entries) {
    const manualReason = authEntryNeedsManualAuth(entry);
    if (manualReason) {
      if (canStartInteractiveAuth(entry) || hasConfiguredMcp(configs, name)) {
        void authenticateInBackground(client, directory, name, manualReason);
      } else {
        log(`${LOG_PREFIX} ${name}: manual authentication required — ${manualReason}`);
      }
      continue;
    }

    if (!tokenIsExpired(entry.tokens?.expiresAt)) {
      log(`${LOG_PREFIX} ${name}: skip — token still valid or has no expiry`);
      continue;
    }

    const serverUrl = serverUrlFor(name, entry, configs);
    if (!serverUrl) {
      log(`${LOG_PREFIX} ${name}: manual authentication required — no server URL available for refresh`);
      continue;
    }

    try {
      log(`${LOG_PREFIX} ${name}: refreshing expired OAuth token`);
      const refreshed = await refreshTokens(entry, serverUrl);
      applyRefresh(entry, serverUrl, refreshed);
      changed = true;
      log(`${LOG_PREFIX} ${name}: refreshed successfully`);
    } catch (err) {
      log(`${LOG_PREFIX} ${name}: refresh failed — ${errorMessage(err)}`);
    }
  }

  for (const name of configuredNames) {
    if (auth[name]?.tokens?.accessToken) continue;
    if (authInFlight.has(name)) continue;
    void authenticateInBackground(
      client,
      directory,
      name,
      auth[name] ? "no access token stored" : "no auth entry stored",
    );
  }

  if (changed) writeAuthFile(authPath, auth);
  log(`${LOG_PREFIX} done${changed ? " (auth file updated)" : ""}`);
}

async function authenticateInBackground(
  client: OpencodeClient,
  directory: string,
  name: string,
  reason: string,
): Promise<void> {
  if (authInFlight.has(name)) {
    log(`${LOG_PREFIX} ${name}: interactive authentication already in flight`);
    return;
  }

  authInFlight.add(name);
  try {
    log(`${LOG_PREFIX} ${name}: starting interactive authentication — ${reason}`);
    const result = await client.mcp.auth.authenticate({
      path: { name },
      query: { directory },
    });

    if (result.error) {
      log(`${LOG_PREFIX} ${name}: interactive authentication failed — ${JSON.stringify(result.error)}`);
      return;
    }

    const status = result.data?.status ?? "unknown";
    log(`${LOG_PREFIX} ${name}: interactive authentication finished — ${status}`);

    if (status === "connected") {
      await connectMcp(client, directory, name);
    }
  } catch (err) {
    log(`${LOG_PREFIX} ${name}: interactive authentication failed — ${errorMessage(err)}`);
  } finally {
    authInFlight.delete(name);
  }
}

async function connectMcp(client: OpencodeClient, directory: string, name: string): Promise<void> {
  try {
    const result = await client.mcp.connect({
      path: { name },
      query: { directory },
    });

    if (result.error) {
      log(`${LOG_PREFIX} ${name}: connect after auth failed — ${JSON.stringify(result.error)}`);
      return;
    }

    log(`${LOG_PREFIX} ${name}: connected after auth`);
  } catch (err) {
    log(`${LOG_PREFIX} ${name}: connect after auth failed — ${errorMessage(err)}`);
  }
}

const McpAutoReauth: Plugin = async ({ client, directory }) => {
  logPath = getLogPath();

  if (process.env.OPENCODE_MCP_AUTO_REAUTH === "0") {
    log(`${LOG_PREFIX} disabled by OPENCODE_MCP_AUTO_REAUTH=0`);
    return {};
  }

  try {
    await refreshExpiredAuthEntries(getAuthPath(), client, directory);
  } catch (err) {
    log(`${LOG_PREFIX} unexpected failure — ${errorMessage(err)}`);
  }

  return {};
};

export default McpAutoReauth;
