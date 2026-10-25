import assert from "node:assert/strict";

const baseUrl = process.env.ADAPTER_BASE_URL ?? "http://localhost:3000";
const token = process.env.AGENT_STUDIO_VERIFIER_TOKEN;
if (!token) throw new Error("Set AGENT_STUDIO_VERIFIER_TOKEN to the local server's token.");

const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const endpoint = (path) => new URL(`/agent-studio/v1/${path}`, baseUrl);
const nonce = "adapter-smoke-test";
const request = { protocol: "asrp/1", nonce, task: { type: "respond", input: "What is 2 + 2?" } };

async function check(name, response, status, code, expectedNonce) {
  assert.equal(response.status, status, `${name}: status`);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/, `${name}: cache policy`);
  const body = await response.json();
  assert.equal(body.protocol, "asrp/1", `${name}: protocol`);
  if (code) {
    assert.equal(body.status, "error", `${name}: error status`);
    assert.equal(body.error.code, code, `${name}: error code`);
    assert.equal(body.nonce, expectedNonce, `${name}: nonce`);
  }
  console.log(`PASS ${name}`);
  return body;
}

const health = await check("health", await fetch(endpoint("health"), { headers: auth }), 200);
assert.deepEqual(health, { protocol: "asrp/1", status: "ready", name: "Truce" });
await check("health auth", await fetch(endpoint("health")), 401, "unauthorized", null);
await check("task auth", await fetch(endpoint("tasks"), {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
}), 401, "unauthorized", null);

async function post(body) {
  return fetch(endpoint("tasks"), { method: "POST", headers: auth, body: typeof body === "string" ? body : JSON.stringify(body) });
}

await check("malformed JSON", await post("{"), 400, "invalid_input", null);
await check("missing nonce", await post({ protocol: "asrp/1", task: request.task }), 400, "invalid_input", null);
await check("wrong protocol echoes nonce", await post({ ...request, protocol: "asrp/2" }), 400, "invalid_input", nonce);
await check("unknown task echoes nonce", await post({ ...request, task: { type: "invented", input: "test" } }), 400, "invalid_input", nonce);
await check("missing task input", await post({ ...request, task: { type: "respond" } }), 400, "invalid_input", nonce);
await check("missing extraction schema", await post({ ...request, task: { type: "extract", input: "test" } }), 400, "invalid_input", nonce);
await check("missing tools", await post({ ...request, task: { type: "use_tools", input: "test" } }), 400, "invalid_input", nonce);
await check("AI honestly unavailable", await post(request), 503, "upstream_unavailable", nonce);
await check("bounded request body", await post({ ...request, task: { type: "respond", input: "x".repeat(70_000) } }), 400, "invalid_input", null);
