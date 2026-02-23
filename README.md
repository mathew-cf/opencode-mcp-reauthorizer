# opencode-mcp-auto-reauth

An [OpenCode](https://opencode.ai) plugin that automatically re-authenticates expired MCP OAuth tokens at startup.

## Why

MCP servers that use OAuth (without refresh tokens) require manual re-authentication every time the access token expires. This plugin runs at OpenCode startup, checks each server's token status, and re-authenticates any that need it — so you don't have to.

## How it works

1. Reads `mcp-auth.json` from the OpenCode data directory
2. For each server entry, checks whether re-authentication is needed:
   - **No tokens / incomplete auth** — re-authenticates
   - **Refresh token present** — skips (the MCP SDK handles refresh automatically)
   - **Token expired, no refresh token** — re-authenticates
   - **Token still valid** — skips
3. Runs `opencode mcp auth <server>` for any server that needs it

A 30-second buffer is applied before expiry to avoid racing with startup.

## Install

```bash
npm install @mathew-cf/opencode-mcp-auto-reauth
```

Then add it to your OpenCode config (`opencode.json` or `opencode.jsonc`):

```jsonc
{
  "plugins": {
    "mcp-auto-reauth": {
      "package": "@mathew-cf/opencode-mcp-auto-reauth"
    }
  }
}
```

## Platform support

| Platform | Data directory |
|----------|---------------|
| Linux | `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode` |
| macOS | `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode` |
| Windows | `%LOCALAPPDATA%\opencode` or `~/AppData/Local/opencode` |

## Logs

Activity is logged to `mcp-auto-reauth.log` in the same data directory:

```
2025-02-23T14:30:01.000Z [mcp-auto-reauth] checking 3 server(s)
2025-02-23T14:30:01.001Z [mcp-auto-reauth] my-server: skip — token still valid
2025-02-23T14:30:01.002Z [mcp-auto-reauth] other-server: re-authenticating — token expired, no refresh token
2025-02-23T14:30:02.500Z [mcp-auto-reauth] other-server: re-authenticated successfully
2025-02-23T14:30:02.501Z [mcp-auto-reauth] done
```

## Development

```bash
bun install
bun run build
bun run typecheck
```

## License

Apache-2.0