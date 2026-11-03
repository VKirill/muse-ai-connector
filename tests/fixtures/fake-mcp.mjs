// Minimal MCP stdio server: one tool "echo" that returns "echo:<text>".
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
rl.on("line", (l) => {
  if (!l.trim()) return; const m = JSON.parse(l);
  if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list") out({ id: m.id, result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  else if (m.method === "tools/call") out({ id: m.id, result: { content: [{ type: "text", text: "echo:" + m.params.arguments.text }] } });
  else if (m.id != null) out({ id: m.id, result: {} });
});
