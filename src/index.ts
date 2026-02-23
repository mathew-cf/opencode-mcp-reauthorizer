import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"

const LOG_PREFIX = "[mcp-auto-reauth]"

interface AuthTokens {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

interface AuthEntry {
  clientInfo?: unknown
  serverUrl?: string
  tokens?: AuthTokens
  oauthState?: unknown
  codeVerifier?: string
}

type AuthFile = Record<string, AuthEntry>

function getDataDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    return join(appData, "opencode")
  }
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode")
}

function getAuthPath(): string {
  return join(getDataDir(), "mcp-auth.json")
}

function getLogPath(): string {
  return join(getDataDir(), "mcp-auto-reauth.log")
}

function readAuthFile(path: string): AuthFile | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function isExpired(expiresAt: number): boolean {
  // Add 30s buffer so we don't race with startup
  return Date.now() / 1000 >= expiresAt - 30
}

function needsReauth(entry: AuthEntry): { needed: boolean; reason: string } {
  const tokens = entry?.tokens

  // No tokens at all — incomplete or failed auth (e.g. only
  // oauthState/codeVerifier from a previous interrupted flow)
  if (!tokens || !tokens.accessToken) {
    return { needed: true, reason: "no tokens (incomplete auth)" }
  }

  // Has refresh token — MCP SDK will handle token refresh during normal init
  if (tokens.refreshToken) {
    return { needed: false, reason: "refresh token present (SDK will handle)" }
  }

  // No expiresAt and no refresh token — can't determine validity, re-auth to be safe
  if (!tokens.expiresAt) {
    return { needed: true, reason: "no expiry info and no refresh token" }
  }


  if (!isExpired(tokens.expiresAt)) {
    return { needed: false, reason: "token still valid" }
  }


  return { needed: true, reason: "token expired, no refresh token" }
}

let logPath: string

function log(message: string): void {
  const timestamp = new Date().toISOString()
  const line = `${timestamp} ${message}\n`
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, line)
  } catch {
    // If we can't write logs, don't crash the plugin
  }
}

const McpAutoReauth: Plugin = async ({ $ }) => {
  const authPath = getAuthPath()
  logPath = getLogPath()
  const auth = readAuthFile(authPath)

  if (!auth) {
    log(`${LOG_PREFIX} no auth file found, skipping`)
    return {}
  }

  const entries = Object.entries(auth)
  log(`${LOG_PREFIX} checking ${entries.length} server(s)`)

  for (const [name, entry] of entries) {
    const { needed, reason } = needsReauth(entry)

    if (!needed) {
      log(`${LOG_PREFIX} ${name}: skip — ${reason}`)
      continue
    }

    log(`${LOG_PREFIX} ${name}: re-authenticating — ${reason}`)
    try {
      await $`opencode mcp auth ${name}`.quiet()
      log(`${LOG_PREFIX} ${name}: re-authenticated successfully`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`${LOG_PREFIX} ${name}: re-auth failed — ${msg}`)
    }
  }

  log(`${LOG_PREFIX} done`)
  return {}
}

export default McpAutoReauth
