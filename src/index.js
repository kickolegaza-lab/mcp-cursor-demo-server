#!/usr/bin/env node
import { createHmac, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CURSOR_SECRET = process.env.CURSOR_SECRET ?? "demo-secret-change-me-0123456789";
const CURSOR_TTL_MS = 5 * 60 * 1000;
const PAGE_LIMIT = 25;

// ---------------------------------------------------------------------------
// In-memory dataset: deterministic, no database needed for the demo.
// ---------------------------------------------------------------------------
const STATUSES = ["open", "closed", "pending"];
const OWNERS = ["ana", "bruno", "carla"];

const RECORDS = Array.from({ length: 120 }, (_, i) => ({
  id: `rec_${String(i + 1).padStart(3, "0")}`,
  status: STATUSES[i % STATUSES.length],
  owner: OWNERS[i % OWNERS.length],
  title: `Record ${i + 1}`,
}));

function filterRecords({ status, owner }) {
  return RECORDS.filter(
    (r) => (status === undefined || r.status === status) && (owner === undefined || r.owner === owner),
  );
}

// ---------------------------------------------------------------------------
// Cursor: payload carries the filters that produced it, signed with HMAC.
// ---------------------------------------------------------------------------
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  );
}

function filterFingerprint(filters) {
  return createHmac("sha256", "fingerprint")
    .update(stableStringify(filters === undefined ? null : filters))
    .digest("base64url")
    .slice(0, 22);
}

function sign(payloadB64) {
  return createHmac("sha256", CURSOR_SECRET).update(payloadB64).digest("base64url");
}

function encodeCursor({ filters, offset }) {
  const payload = { v: 1, f: filterFingerprint(filters), o: offset, exp: Date.now() + CURSOR_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return payloadB64 + "." + sign(payloadB64);
}

class InvalidCursorError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid_cursor";
  }
}

function decodeCursor(cursor, filters) {
  const parts = String(cursor).split(".");
  if (parts.length !== 2) throw new InvalidCursorError("Cursor is malformed. Start again from the first page.");
  const [payloadB64, signature] = parts;

  const expected = Buffer.from(sign(payloadB64));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new InvalidCursorError("Cursor signature does not verify. Start again from the first page.");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError("Cursor payload is unreadable. Start again from the first page.");
  }

  if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
    throw new InvalidCursorError("Cursor expired. Start again from the first page.");
  }
  if (payload.f !== filterFingerprint(filters)) {
    throw new InvalidCursorError("Cursor was issued for different filters. Start again from the first page.");
  }
  return { offset: payload.o };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "cursor-demo-records", version: "1.0.0" });

function json(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(code, message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: code, message }, null, 2) }], isError: true };
}

server.registerTool(
  "list_records",
  {
    title: "List records",
    description:
      "Returns one page of records matching the filters. A non-null nextCursor means more records match: pass it back to continue. Never treat one page as the complete result set.",
    inputSchema: {
      status: z.string().trim().min(1).max(20).optional(),
      owner: z.string().trim().min(1).max(20).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(1024).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ status, owner, limit, cursor }) => {
    const filters = {};
    if (status !== undefined) filters.status = status;
    if (owner !== undefined) filters.owner = owner;
    const pageLimit = limit ?? PAGE_LIMIT;

    let offset = 0;
    if (cursor !== undefined) {
      try {
        offset = decodeCursor(cursor, filters).offset;
      } catch (error) {
        return errorResult("invalid_cursor", error.message);
      }
    }

    const matched = filterRecords(filters);
    const items = matched.slice(offset, offset + pageLimit);
    const nextOffset = offset + items.length;
    const complete = nextOffset >= matched.length;

    return json({
      matched: matched.length,
      returned: items.length,
      complete,
      nextCursor: complete ? null : encodeCursor({ filters, offset: nextOffset }),
      items,
      note: complete
        ? "This page is the complete result set for these filters."
        : `${matched.length - nextOffset} records match but were not returned. Call list_records again with nextCursor.`,
    });
  },
);

server.registerTool(
  "dataset_summary",
  {
    title: "Dataset summary",
    description: "Returns total record count plus counts by status and owner.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const byStatus = {};
    const byOwner = {};
    for (const r of RECORDS) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byOwner[r.owner] = (byOwner[r.owner] ?? 0) + 1;
    }
    return json({ total: RECORDS.length, byStatus, byOwner });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
