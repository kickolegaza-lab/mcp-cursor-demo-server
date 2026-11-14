import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

function runSession(messages, expectedReplies) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const replies = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("timeout waiting for MCP replies"));
    }, 15000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          replies.push(JSON.parse(line));
        } catch {
          // ignore non-JSON stdout noise
        }
      }
      if (replies.length >= expectedReplies) {
        clearTimeout(timeout);
        child.kill();
        resolve(replies);
      }
    });

    child.on("error", reject);
    for (const msg of messages) child.stdin.write(JSON.stringify(msg) + "\n");
  });
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1.0.0" } },
};

test("server lists tools and returns a structured page", async () => {
  const replies = await runSession([
    initialize,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_records", arguments: { limit: 5 } } },
  ], 3);

  const toolList = replies.find((r) => r.id === 2);
  const names = toolList.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["dataset_summary", "list_records"]);

  const call = replies.find((r) => r.id === 3);
  const page = JSON.parse(call.result.content[0].text);
  assert.equal(page.matched, 120);
  assert.equal(page.returned, 5);
  assert.equal(page.complete, false);
  assert.ok(page.nextCursor);
});

test("replaying a cursor against other filters returns invalid_cursor", async () => {
  const first = await runSession([
    initialize,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_records", arguments: { status: "open", limit: 5 } } },
  ], 2);
  const page = JSON.parse(first[1].result.content[0].text);
  assert.ok(page.nextCursor);

  const second = await runSession([
    initialize,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_records", arguments: { status: "closed", limit: 5, cursor: page.nextCursor } },
    },
  ], 2);
  const result = second[1].result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /invalid_cursor/);
});
