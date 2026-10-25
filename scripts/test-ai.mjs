import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Keep the tests offline while exercising the same TypeScript used by the route.
const source = await readFile(new URL("../lib/ai.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { executeAiTask, AiTaskError } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const apiUrl = "https://api.openai.com/v1/responses";
const toolBase = "https://superteam-agent-studio.vercel.app/api/race/challenge/tools/";
const apiKey = "fake-openai-test-key";
const challengeToken = "fake-challenge-test-token";
const model = "test-model";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...headers },
});
const message = (text) => ({
  type: "message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const response = (...output) => json({ id: "resp_test", status: "completed", output });
const call = (name, args, id = name) => ({
  type: "function_call", name, call_id: `call_${id}`, arguments: JSON.stringify(args),
});
const tools = [
  { name: "lookup_record", description: "Read a record by id", url: `${toolBase}lookup_record`, inputSchema: {
    type: "object", properties: { id: { type: "string" } }, required: ["id"],
  } },
  { name: "exchange_rate", description: "Read a currency exchange rate", url: `${toolBase}exchange_rate`, inputSchema: {
    type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"],
  } },
];
const task = (overrides = {}) => ({
  type: "use_tools", input: "Read records A and B, convert their total to GBP, and return totalGbp.",
  tools, challengeToken,
  schema: { type: "object", properties: { totalGbp: { type: "number" } }, required: ["totalGbp"], additionalProperties: false },
  limits: { maxToolCalls: 8, timeoutMs: 2000 }, ...overrides,
});

async function rejects(run, code, status) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof AiTaskError, "error has the adapter's typed failure");
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.ok(!error.message.includes(apiKey));
    assert.ok(!error.message.includes(challengeToken));
    return true;
  });
}

let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log(`PASS ${name}`);
}

await test("respond sends the input to the model and reads its answer", async () => {
  let calls = 0;
  const result = await executeAiTask({ type: "respond", input: "What is 17 + 26?" }, {
    apiKey, model,
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), apiUrl);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
      const body = JSON.parse(init.body);
      assert.equal(body.model, model);
      assert.equal(body.store, false);
      assert.match(JSON.stringify(body.input), /17 \+ 26/);
      assert.ok(!JSON.stringify(body).includes(apiKey));
      return response(message("43"));
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.text, "43");
});

await test("model chooses tools and receives actual results with isolated credentials", async () => {
  const toolCalls = [];
  const modelBodies = [];
  const reasoning = { type: "reasoning", id: "rs_test", summary: [], encrypted_content: "opaque-reasoning" };
  const result = await executeAiTask(task(), {
    apiKey, model,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(init.body);
      assert.equal(init.method, "POST");
      if (String(url) === apiUrl) {
        assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
        assert.ok(!init.body.includes(challengeToken), "challenge token stays out of model prompts");
        assert.ok(!init.body.includes(toolBase), "tool service URLs stay out of model prompts");
        modelBodies.push(body);
        if (modelBodies.length === 1) return response(reasoning, call("lookup_record", { id: "A" }, "A"), call("lookup_record", { id: "B" }, "B"));
        if (modelBodies.length === 2) {
          const inputs = JSON.stringify(body.input);
          assert.match(inputs, /opaque-reasoning/);
          assert.match(inputs, /function_call_output/);
          assert.match(inputs, /call_A/);
          assert.match(inputs, /call_B/);
          assert.match(inputs, /19/);
          assert.match(inputs, /22/);
          return response(call("exchange_rate", { from: "USD", to: "GBP" }, "rate"));
        }
        assert.match(JSON.stringify(body.input), /0\.79/);
        return response(message('{"totalGbp":32.39}'));
      }
      assert.equal(headers.get("authorization"), `Bearer ${challengeToken}`);
      assert.ok(!init.body.includes(apiKey));
      assert.equal(init.redirect, "error", "tool redirects must not be followed");
      toolCalls.push({ url: String(url), body });
      if (String(url) === `${toolBase}lookup_record`) return json({ id: body.id, amount: body.id === "A" ? 19 : 22, currency: "USD" });
      assert.equal(String(url), `${toolBase}exchange_rate`);
      assert.deepEqual(body, { from: "USD", to: "GBP" });
      return json({ from: "USD", to: "GBP", rate: 0.79 });
    },
  });
  assert.equal(modelBodies.length, 3);
  assert.equal(toolCalls.length, 3);
  assert.deepEqual(toolCalls.slice(0, 2).map((x) => x.body.id).sort(), ["A", "B"]);
  assert.deepEqual(result.data, { totalGbp: 32.39 });
  assert.equal(result.toolResults.length, 3);
  assert.equal(result.toolResults[0].tool, "lookup_record");
  assert.equal(result.toolResults[0].result.amount, 19);
});

await test("unsafe tool URLs and duplicate names fail before network access", async () => {
  for (const url of [
    "http://127.0.0.1/api/race/challenge/tools/lookup_record",
    "https://example.com/api/race/challenge/tools/lookup_record",
    "https://superteam-agent-studio.vercel.app.evil.test/api/race/challenge/tools/lookup_record",
    "https://user@superteam-agent-studio.vercel.app/api/race/challenge/tools/lookup_record",
    "https://superteam-agent-studio.vercel.app:444/api/race/challenge/tools/lookup_record",
    `${toolBase}exchange_rate`,
    `${toolBase}lookup_record?redirect=evil`,
    `${toolBase}lookup_record#fragment`,
  ]) {
    let calls = 0;
    await rejects(() => executeAiTask(task({ tools: [{ ...tools[0], url }] }), {
      apiKey, model, fetch: async () => { calls++; throw new Error("unexpected network request"); },
    }), "invalid_input", 400);
    assert.equal(calls, 0);
  }
  let calls = 0;
  await rejects(() => executeAiTask(task({ tools: [tools[0], tools[0]] }), {
    apiKey, model, fetch: async () => { calls++; throw new Error("unexpected network request"); },
  }), "invalid_input", 400);
  assert.equal(calls, 0);
});

await test("supplied mutation tools are refused before model or tool requests", async () => {
  for (const name of ["place_order", "create_quote", "pay_usdc"]) {
    let calls = 0;
    await rejects(() => executeAiTask(task({
      tools: [{ name, url: `${toolBase}${name}`, inputSchema: { type: "object" } }],
      limits: { maxToolCalls: 8, maxSpendUsd: 0, timeoutMs: 2000 },
    }), { apiKey, model, fetch: async () => { calls++; throw new Error("unexpected network request"); } }), "invalid_input", 400);
    assert.equal(calls, 0);
  }
});

await test("zero tool budget fails without a model call", async () => {
  let calls = 0;
  await rejects(() => executeAiTask(task({ limits: { maxToolCalls: 0, timeoutMs: 2000 } }), {
    apiKey, model, fetch: async () => { calls++; throw new Error("unexpected network request"); },
  }), "limit_exceeded");
  assert.equal(calls, 0);
});

await test("tool calls cannot exceed the supplied budget", async () => {
  let toolCalls = 0;
  await rejects(() => executeAiTask(task({ limits: { maxToolCalls: 1, timeoutMs: 2000 } }), {
    apiKey, model,
    fetch: async (url) => {
      if (String(url) === apiUrl) return response(call("lookup_record", { id: "A" }, "A"), call("lookup_record", { id: "B" }, "B"));
      toolCalls++;
      return json({ amount: 19, currency: "USD" });
    },
  }), "limit_exceeded");
  assert.ok(toolCalls <= 1);
});

await test("two transient tool failures recover with backoff and real results", async () => {
  let toolCalls = 0;
  let modelCalls = 0;
  const attempts = [];
  const result = await executeAiTask(task(), {
    apiKey, model,
    fetch: async (url, init) => {
      if (String(url) === apiUrl) {
        modelCalls++;
        if (modelCalls === 1) return response(call("lookup_record", { id: "A" }));
        assert.match(init.body, /"amount"|\\"amount\\"/);
        return response(message('{"totalGbp":5}'));
      }
      toolCalls++;
      attempts.push(performance.now());
      return toolCalls <= 2 ? json({ error: "temporary" }, 503) : json({ id: "A", amount: 5, currency: "GBP" });
    },
  });
  assert.equal(toolCalls, 3);
  assert.ok(attempts[1] - attempts[0] >= 50, "first retry backs off");
  assert.ok(attempts[2] - attempts[1] >= 100, "second retry backs off");
  assert.deepEqual(result.data, { totalGbp: 5 });
  assert.equal(result.toolResults.length, 1, "failed attempts are not claimed as successful results");
});

await test("network failures recover within the call budget and retries consume it", async () => {
  for (const budget of [1, 2]) {
    let toolCalls = 0;
    let modelCalls = 0;
    const run = () => executeAiTask(task({ limits: { maxToolCalls: budget, timeoutMs: 2000 } }), {
      apiKey, model,
      fetch: async (url) => {
        if (String(url) === apiUrl) {
          modelCalls++;
          return modelCalls === 1 ? response(call("lookup_record", { id: "A" })) : response(message('{"totalGbp":5}'));
        }
        toolCalls++;
        if (toolCalls === 1) throw new TypeError("fetch failed");
        return json({ id: "A", amount: 5, currency: "GBP" });
      },
    });
    if (budget === 1) {
      await rejects(run, "limit_exceeded", 422);
      assert.equal(toolCalls, 1, "a retry cannot escape the tool call budget");
    } else {
      const result = await run();
      assert.equal(toolCalls, 2);
      assert.equal(result.toolResults.length, 1);
      assert.deepEqual(result.data, { totalGbp: 5 });
    }
  }
});

await test("provider and tool failures expose only sanitized errors", async () => {
  await rejects(() => executeAiTask({ type: "respond", input: "Hello" }, {
    apiKey, model, fetch: async () => json({ error: { message: `${apiKey} ${challengeToken}` } }, 401),
  }), "upstream_unavailable", 503);
  let toolCalls = 0;
  await rejects(() => executeAiTask(task(), {
    apiKey, model,
    fetch: async (url) => {
      if (String(url) === apiUrl) return response(call("lookup_record", { id: "A" }));
      toolCalls++;
      return json({ error: `${apiKey} ${challengeToken}` }, 503);
    },
  }), "upstream_unavailable", 503);
  assert.equal(toolCalls, 3, "persistent failure stops after three total attempts");
});

await test("malformed or incomplete model output is not accepted as an answer", async () => {
  for (const body of [
    "not JSON",
    JSON.stringify({ status: "completed", output: [] }),
    JSON.stringify({ status: "incomplete", output: [message("partial answer")] }),
  ]) {
    await rejects(() => executeAiTask({ type: "respond", input: "Hello" }, {
      apiKey, model, fetch: async () => new Response(body, { status: 200 }),
    }), "upstream_unavailable", 503);
  }
  for (const finalText of ["This is not a JSON object", '{"totalGbp":"5"}', '{"unrelated":5}']) {
    let modelCalls = 0;
    await rejects(() => executeAiTask(task(), {
      apiKey, model,
      fetch: async (url) => {
        if (String(url) !== apiUrl) return json({ id: "A", amount: 5, currency: "GBP" });
        modelCalls++;
        return modelCalls === 1 ? response(call("lookup_record", { id: "A" })) : response(message(finalText));
      },
    }), "upstream_unavailable", 503);
    assert.equal(modelCalls, 2);
  }
});

await test("tool redirects are refused and successful results stay size bounded", async () => {
  for (const reply of [
    () => new Response(null, { status: 302, headers: { Location: "https://example.com/private" } }),
    () => json({ payload: "x".repeat(66_000) }),
  ]) {
    let toolCalls = 0;
    await rejects(() => executeAiTask(task(), {
      apiKey, model,
      fetch: async (url, init) => {
        if (String(url) === apiUrl) return response(call("lookup_record", { id: "A" }));
        assert.equal(String(url), `${toolBase}lookup_record`);
        assert.equal(init.redirect, "error");
        toolCalls++;
        return reply();
      },
    }), "upstream_unavailable", 503);
    assert.equal(toolCalls, 1);
  }
});

await test("individually bounded tool results cannot exceed the aggregate response budget", async () => {
  let toolCalls = 0;
  await rejects(() => executeAiTask(task(), {
    apiKey, model,
    fetch: async (url) => {
      if (String(url) === apiUrl) return response(...Array.from({ length: 5 }, (_, i) => call("lookup_record", { id: String(i) }, String(i))));
      toolCalls++;
      return json({ id: String(toolCalls), payload: "x".repeat(55_000) });
    },
  }), "limit_exceeded", 422);
  assert.equal(toolCalls, 5, "each result fits individually but accumulated results are rejected");
});

await test("unknown model-selected tool cannot trigger a request", async () => {
  let calls = 0;
  await rejects(() => executeAiTask(task(), {
    apiKey, model,
    fetch: async () => { calls++; return response(call("read_private_file", { path: "/etc/passwd" })); },
  }), "upstream_unavailable", 503);
  assert.equal(calls, 1);
});

await test("task deadline cancels a stalled upstream request", async () => {
  const start = performance.now();
  await rejects(() => executeAiTask({ type: "respond", input: "Hello", limits: { timeoutMs: 25 } }, {
    apiKey, model,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      // A real in-flight socket keeps Node alive; reproduce that for this mock.
      const keepAlive = setTimeout(() => reject(new Error("test fetch was not cancelled")), 2000);
      const abort = () => { clearTimeout(keepAlive); reject(init.signal.reason); };
      if (init.signal.aborted) abort();
      else init.signal.addEventListener("abort", abort, { once: true });
    }),
  }), "upstream_timeout", 504);
  assert.ok(performance.now() - start < 1000);
});

console.log(`${passed} offline AI adapter tests passed.`);
