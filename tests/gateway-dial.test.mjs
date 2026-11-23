import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connectGateway, defaultSocketFactory } from "../bridge/protocol/gateway.mjs";

const flightHtml = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "muse-flight.html"),
  "utf8",
);

async function fakeFetch(url) {
  return String(url).replace(/\/$/, "") === "https://muse.ai"
    ? new Response(flightHtml, { status: 200, headers: { "content-type": "text/html" } })
    : new Response('{"status":"ok"}', { status: 200, headers: { "content-type": "application/json" } });
}

async function statusServer(statuses) {
  let i = 0;
  const srv = http.createServer((req, res) => {
    const [code, reason] = statuses[Math.min(i++, statuses.length - 1)];
    res.writeHead(code, reason);
    res.end();
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return { srv, url: `ws://127.0.0.1:${srv.address().port}/v1/noise` };
}

test("connectGateway retries a 502 dial and survives the failed socket", async () => {
  const { srv, url } = await statusServer([
    [502, "Bad Gateway"],
    [502, "Bad Gateway"],
    [401, "Unauthorized"],
  ]);
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on("uncaughtException", onUncaught);
  let dials = 0;
  try {
    await assert.rejects(
      connectGateway({
        cookies: [],
        fetchImpl: fakeFetch,
        socketFactory: () => {
          dials += 1;
          return defaultSocketFactory(url);
        },
      }),
      /gateway dial failed: 401/,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(dials, 3);
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    srv.close();
  }
});

test("connectGateway does not retry a 401 dial", async () => {
  const { srv, url } = await statusServer([[401, "Unauthorized"]]);
  let dials = 0;
  try {
    await assert.rejects(
      connectGateway({
        cookies: [],
        fetchImpl: fakeFetch,
        socketFactory: () => {
          dials += 1;
          return defaultSocketFactory(url);
        },
      }),
      /gateway dial failed: 401/,
    );
    assert.equal(dials, 1);
  } finally {
    srv.close();
  }
});
