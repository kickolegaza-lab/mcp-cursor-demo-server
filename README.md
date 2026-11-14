# mcp-cursor-demo-server

A runnable MCP server that demonstrates one specific bug: **offset pagination silently returns the wrong page when an agent replays a cursor against different filters.**

```
list_records(status="open", limit=5)   -> nextCursor: "..."
list_records(status="closed", cursor)  -> offset 5 of a different result set
```

Same response shape, different rows, no error. The model summarises it and the answer is wrong.

This server returns `invalid_cursor` instead.

## Run

```bash
npx mcp-cursor-demo-server
```

No build step, no database, no API keys. 120 in-memory records.

### Claude Desktop / Cursor / any MCP client

```json
{
  "mcpServers": {
    "cursor-demo": {
      "command": "npx",
      "args": ["-y", "mcp-cursor-demo-server"],
      "env": { "CURSOR_SECRET": "pick-a-long-random-string" }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `list_records` | One page of records filtered by `status` / `owner`. Returns `matched`, `returned`, `complete`, `nextCursor`. |
| `dataset_summary` | Total count plus counts by status and owner. |

## Try the bug

1. `list_records({ status: "open", limit: 5 })` → returns 5 rows and a `nextCursor`.
2. `list_records({ status: "closed", limit: 5, cursor: "<that cursor>" })` → `invalid_cursor`: *"Cursor was issued for different filters. Start again from the first page."*

With a plain offset cursor, step 2 would have returned rows 6–10 of the *closed* set as if they were a continuation. No error anywhere.

## What the cursor carries

```
payload = { v: 1, f: filterFingerprint(filters), o: offset, exp: expiresAt }
cursor  = base64url(payload) + "." + hmacSha256(payload, secret)
```

`filterFingerprint` is order-insensitive, so `{a:1,b:2}` and `{b:2,a:1}` hash the same. Signature comparison uses `timingSafeEqual`. Expired cursors are rejected.

## Scope

This is the demo: two tools, in-memory data, stdio only.

The production starter kit adds scoped bearer auth, per-token rate limiting, stdio **and** Streamable HTTP transport, a read-only tool guard, structured logs, and the full test suite: **https://legaza.gumroad.com/l/mcp-kit** (79 EUR, one payment).

If you only want the cursor logic, the standalone library is `mcp-cursor-guard` (MIT).

## License

MIT
