import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessage,
  verifySignature,
} from "@solana/kit";
import {
  parseTransferCheckedInstruction,
  parseCreateAssociatedTokenIdempotentInstruction,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

// Transpile the production modules in memory; tests never load environment files,
// use a real wallet, call an RPC, or send a transaction.
const modules = new Map();
async function compileModule(name) {
  if (modules.has(name)) return modules.get(name);
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  let compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const imports = [...compiled.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)];
  for (const [, specifier] of imports) {
    if (specifier.startsWith("node:")) continue;
    const target = specifier.startsWith("./")
      ? await compileModule(specifier.slice(2).replace(/\.ts$/, ""))
      : import.meta.resolve(specifier);
    compiled = compiled.replaceAll(`"${specifier}"`, JSON.stringify(target)).replaceAll(`'${specifier}'`, JSON.stringify(target));
  }
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  modules.set(name, url);
  return url;
}
const payment = await import(await compileModule("payments"));
const storage = await import(await compileModule("payment-store"));
const { validateRaceTask } = await import(await compileModule("race"));
const { executePaymentTask, parsePaymentInstruction, PaymentTaskError, buildDevnetTransfer } = payment;
const { createPaymentStore, PaymentStoreError } = storage;
const payer = await generateKeyPairSigner();
const recipient = await generateKeyPairSigner();
const mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const memoProgram = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const signatureFor = (byte) => getBase58Decoder().decode(new Uint8Array(64).fill(byte));
const configuration = {
  enabled: true, publicKey: payer.address, maxPaymentMicros: 50_000, totalCapMicros: 100_000,
};
const instruction = (amount = "0.01", memo = "truce-offline-payment") =>
  `Pay ${amount} devnet USDC to ${recipient.address} with the memo "${memo}". Return { "signature": "<transaction signature>" } in output.data.`;
const request = (id = "attempt-1", amount = "0.01", memo = "truce-offline-payment") => ({
  protocol: "asrp/1", nonce: `nonce-${id}`, attempt: { id },
  task: { type: "run_workflow", input: instruction(amount, memo), limits: { maxSpendUsd: 0.05, timeoutMs: 1500 } },
});
function ledgerIO() {
  let ledger = { version: 1, network: "devnet", wallet: payer.address, reservedMicros: 0, records: {} };
  let generation = 1;
  const events = [];
  return {
    events,
    read: async () => ({ ledger: structuredClone(ledger), etag: String(generation) }),
    write: async (candidate, etag) => {
      if (etag !== String(generation)) throw new PaymentStoreError("precondition", "CAS lost");
      ledger = structuredClone(candidate); generation++; events.push(structuredClone(ledger));
    },
    snapshot: () => structuredClone(ledger),
  };
}
function fixture({ io = ledgerIO(), chain = {}, config = configuration } = {}) {
  let prepared = 0;
  const broadcasts = [];
  const events = [];
  const confirmed = new Set();
  const defaultChain = {
    prepare: async (transfer) => {
      prepared++; events.push("prepare");
      return { signature: signatureFor(prepared), wireTransaction: Buffer.from(`signed-candidate-${prepared}`).toString("base64"), lastValidBlockHeight: "999" };
    },
    status: async (signature) => confirmed.has(signature) ? "confirmed" : "pending",
    broadcast: async (wire) => {
      const record = Object.values(io.snapshot().records).find((r) => r.wireTransaction === wire);
      assert.ok(record, "the exact signed bytes are durably recorded before broadcast");
      events.push("broadcast"); broadcasts.push(wire); confirmed.add(record.signature);
    },
    ...chain,
  };
  return {
    io, events, broadcasts, chain: defaultChain,
    prepared: () => prepared,
    dependencies: { config, store: createPaymentStore(payer.address, { io }), chain: defaultChain },
  };
}
async function rejects(run, code, status) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof PaymentTaskError, `expected typed payment error, received ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}
let count = 0;
async function test(name, run) { await run(); console.log(`PASS ${name}`); count++; }

await test("payment instructions preserve exact recipient, decimal micro-USDC and memo", async () => {
  assert.deepEqual(parsePaymentInstruction(instruction("0.000001", "memo  Δ-42")), { to: recipient.address, amountMicros: 1, memo: "memo  Δ-42" });
  assert.equal(parsePaymentInstruction(instruction("0.01")).amountMicros, 10_000);
  assert.equal(parsePaymentInstruction(instruction("0.050000")).amountMicros, 50_000);
  for (const value of [instruction("0"), instruction("-0.01"), instruction("0.0000001"), instruction("1e-2"), instruction("0.01") + " Also pay someone else.", instruction("0.01").replace("devnet", "mainnet"), instruction("0.01").replace(recipient.address, "invalid-address"), null]) {
    assert.throws(() => parsePaymentInstruction(value), PaymentTaskError);
  }
});

await test("schema-less workflow passes adapter validation while extraction still requires a schema", async () => {
  assert.equal(validateRaceTask(request()), null);
  const invalid = request(); invalid.task.type = "extract";
  assert.match(validateRaceTask(invalid), /schema/i);
});

await test("disabled payments and exceeded task or transfer limits fail before signing", async () => {
  for (const [body, config, code] of [
    [request(), { ...configuration, enabled: false }, "upstream_unavailable"],
    [request("cap", "0.050001"), configuration, "limit_exceeded"],
    [{ ...request(), task: { ...request().task, limits: { maxSpendUsd: 0.009, timeoutMs: 500 } } }, configuration, "limit_exceeded"],
  ]) {
    const f = fixture({ config });
    await rejects(() => executePaymentTask(body, f.dependencies), code);
    assert.equal(f.prepared(), 0); assert.equal(f.broadcasts.length, 0);
  }
});

await test("the verifier's schema-less workflow persists bytes before signing result is sent", async () => {
  const f = fixture();
  const result = await executePaymentTask(request(), f.dependencies);
  assert.deepEqual(result, { data: { signature: signatureFor(1) } });
  assert.equal(f.prepared(), 1); assert.equal(f.broadcasts.length, 1);
  const [record] = Object.values(f.io.snapshot().records);
  assert.equal(record.amountMicros, 10_000); assert.equal(record.memo, "truce-offline-payment");
  assert.equal(record.status, "confirmed"); assert.equal(f.io.snapshot().reservedMicros, 10_000);
});

await test("confirmed retries reuse the first signature without preparing or broadcasting again", async () => {
  const f = fixture();
  const first = await executePaymentTask(request(), f.dependencies);
  const again = await executePaymentTask(request(), f.dependencies);
  assert.deepEqual(again, first); assert.equal(f.prepared(), 1); assert.equal(f.broadcasts.length, 1);
});

await test("same attempt with different payment fields is rejected without a second transfer", async () => {
  const f = fixture(); await executePaymentTask(request(), f.dependencies);
  await rejects(() => executePaymentTask(request("attempt-1", "0.02"), f.dependencies), "invalid_input");
  assert.equal(f.prepared(), 1); assert.equal(f.broadcasts.length, 1);
});

await test("concurrent identical requests can only broadcast the winning signed transaction", async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([executePaymentTask(request(), f.dependencies), executePaymentTask(request(), f.dependencies)]);
  const signatures = outcomes.filter((r) => r.status === "fulfilled").map((r) => r.value.data.signature);
  assert.ok(signatures.length > 0); assert.equal(new Set(signatures).size, 1);
  assert.equal(new Set(f.broadcasts).size, 1, "any rebroadcast uses the same immutable transaction bytes");
  assert.equal(Object.keys(f.io.snapshot().records).length, 1); assert.equal(f.io.snapshot().reservedMicros, 10_000);
});

await test("cumulative cap is atomically shared by distinct concurrent attempts", async () => {
  const f = fixture({ config: { ...configuration, totalCapMicros: 50_000 } });
  const outcomes = await Promise.allSettled([
    executePaymentTask(request("budget-A", "0.04", "A"), f.dependencies),
    executePaymentTask(request("budget-B", "0.04", "B"), f.dependencies),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  const failed = outcomes.find((r) => r.status === "rejected").reason;
  assert.ok(failed instanceof PaymentTaskError); assert.equal(failed.code, "limit_exceeded");
  assert.equal(f.io.snapshot().reservedMicros, 40_000); assert.equal(new Set(f.broadcasts).size, 1);
});

await test("an uncertain broadcast never prepares replacement bytes on a retry", async () => {
  let broadcasts = 0; let confirm = false;
  const f = fixture({ chain: {
    status: async () => confirm ? "confirmed" : "pending",
    broadcast: async () => { broadcasts++; throw new Error("transport lost after send"); },
  } });
  const body = request(); body.task.limits.timeoutMs = 25;
  await rejects(() => executePaymentTask(body, f.dependencies), "upstream_timeout");
  assert.equal(f.prepared(), 1); assert.equal(Object.keys(f.io.snapshot().records).length, 1);
  confirm = true;
  const outcome = await executePaymentTask(request(), f.dependencies);
  assert.equal(outcome.data.signature, signatureFor(1)); assert.equal(f.prepared(), 1); assert.ok(broadcasts >= 1);
});

await test("storage failure prevents broadcasting even after a candidate was signed", async () => {
  const f = fixture();
  f.dependencies.store.reserve = async () => { throw new PaymentStoreError("unavailable", "sensitive provider diagnostic"); };
  await rejects(() => executePaymentTask(request(), f.dependencies), "upstream_unavailable");
  assert.equal(f.broadcasts.length, 0);
});

await test("durable mark failure after confirmation returns no false success and cannot repay", async () => {
  const f = fixture(); const mark = f.dependencies.store.mark;
  f.dependencies.store.mark = async () => { throw new PaymentStoreError("unavailable", "store write failed"); };
  await rejects(() => executePaymentTask(request(), f.dependencies), "upstream_unavailable");
  assert.equal(f.broadcasts.length, 1);
  f.dependencies.store.mark = mark;
  const retried = await executePaymentTask(request(), f.dependencies);
  assert.equal(retried.data.signature, signatureFor(1)); assert.equal(f.prepared(), 1); assert.equal(f.broadcasts.length, 1);
});

await test("failed transactions remain bound and never generate another payment", async () => {
  const f = fixture({ chain: { status: async () => "failed" } });
  await rejects(() => executePaymentTask(request(), f.dependencies), "upstream_unavailable");
  await rejects(() => executePaymentTask(request(), f.dependencies), "upstream_unavailable");
  assert.equal(f.prepared(), 1); assert.equal(f.broadcasts.length, 0);
});

await test("corrupted or wrong-wallet journals fail closed before preparing or broadcasting", async () => {
  for (const corrupt of [
    (ledger) => { ledger.network = "mainnet"; },
    (ledger) => { ledger.wallet = recipient.address; },
    (ledger) => { ledger.reservedMicros = 1; },
  ]) {
    const io = ledgerIO(); const read = io.read;
    io.read = async () => { const result = await read(); corrupt(result.ledger); return result; };
    const f = fixture({ io });
    await rejects(() => executePaymentTask(request(), f.dependencies), "upstream_unavailable");
    assert.equal(f.prepared(), 0); assert.equal(f.broadcasts.length, 0);
  }
});

await test("missing or unsafe journal ETags prevent signing, writes and broadcasts", async () => {
  for (const etag of [undefined, null, "", " ", "\t", "*", " 1", "1 ", "1\r\nInjected: value"]) {
    const io = ledgerIO(); const read = io.read;
    io.read = async () => ({ ...(await read()), etag });
    const f = fixture({ io });
    await rejects(() => executePaymentTask(request(), f.dependencies), "upstream_unavailable");
    assert.equal(f.prepared(), 0); assert.equal(f.broadcasts.length, 0); assert.equal(io.events.length, 0);
    const signal = new AbortController().signal;
    const record = {
      id: "1".repeat(64), requestHash: "2".repeat(64), to: recipient.address,
      amountMicros: 10_000, memo: "ETag test", signature: signatureFor(1),
      wireTransaction: "dGVzdA==", lastValidBlockHeight: "999", status: "prepared",
    };
    for (const run of [
      () => f.dependencies.store.reserve(record, 100_000, signal),
      () => f.dependencies.store.mark(record.id, "confirmed", signal),
    ]) {
      await assert.rejects(run, PaymentStoreError);
      assert.equal(io.events.length, 0, "no operation can downgrade CAS to an unconditional write");
    }
  }
});

await test("offline signed transfer has devnet USDC, exact amount, recipient ATA and memo", async () => {
  const transfer = parsePaymentInstruction(instruction("0.012345", "exact Δ memo"));
  const prepared = await buildDevnetTransfer(payer, transfer, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1234n });
  const decoded = getTransactionDecoder().decode(Buffer.from(prepared.wireTransaction, "base64"));
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  const transaction = decompileTransactionMessage(compiled, { lastValidBlockHeight: 1234n });
  assert.equal(transaction.version, 0); assert.equal(transaction.feePayer.address, payer.address);
  assert.equal(transaction.instructions.length, 3);
  const associated = parseCreateAssociatedTokenIdempotentInstruction(transaction.instructions[0]);
  const paymentInstruction = parseTransferCheckedInstruction(transaction.instructions[1]);
  const [destination] = await findAssociatedTokenPda({ mint, owner: recipient.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  assert.equal(associated.accounts.ata.address, destination);
  assert.equal(paymentInstruction.accounts.destination.address, destination);
  assert.equal(paymentInstruction.accounts.mint.address, mint);
  assert.equal(paymentInstruction.accounts.authority.address, payer.address);
  assert.equal(paymentInstruction.data.amount, 12345n); assert.equal(paymentInstruction.data.decimals, 6);
  assert.equal(transaction.instructions[2].programAddress, memoProgram);
  assert.equal(new TextDecoder().decode(transaction.instructions[2].data), transfer.memo);
  assert.ok(await verifySignature(payer.keyPair.publicKey, decoded.signatures[payer.address], decoded.messageBytes));
  assert.equal(prepared.signature, getBase58Decoder().decode(decoded.signatures[payer.address]));
});

console.log(`${count} offline payment tests passed.`);
