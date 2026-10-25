import { createHash } from "node:crypto";
import {
  address, appendTransactionMessageInstructions, blockhash, createKeyPairSignerFromBytes,
  createSolanaRpc, createTransactionMessage, devnet, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, getUtf8Encoder, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Instruction, type KeyPairSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { createPaymentStore, PaymentStoreError, type PaymentRecord, type PaymentStore } from "./payment-store";

type JsonRecord = Record<string, unknown>;
type PaymentCode = "invalid_input" | "upstream_unavailable" | "upstream_timeout" | "limit_exceeded";
export class PaymentTaskError extends Error {
  constructor(public readonly status: number, public readonly code: PaymentCode, message: string) {
    super(message);
    this.name = "PaymentTaskError";
  }
}
export type PaymentTransfer = { to: string; amountMicros: number; memo: string };
export type PreparedPayment = { signature: string; wireTransaction: string; lastValidBlockHeight: string };
export type PaymentConfig = { enabled: boolean; publicKey: string; maxPaymentMicros: number; totalCapMicros: number };
export interface PaymentChain {
  prepare(transfer: PaymentTransfer, signal: AbortSignal): Promise<PreparedPayment>;
  status(signature: string, signal: AbortSignal): Promise<"pending" | "confirmed" | "failed">;
  broadcast(wireTransaction: string, signal: AbortSignal): Promise<void>;
}
export type PaymentDependencies = { config?: PaymentConfig; store?: PaymentStore; chain?: PaymentChain; signal?: AbortSignal; pollIntervalMs?: number };
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const MEMO_PROGRAM = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function invalid(message: string): never { throw new PaymentTaskError(400, "invalid_input", message); }
function unavailable(message: string): never { throw new PaymentTaskError(503, "upstream_unavailable", message); }
function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }

function decimalMicros(value: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) invalid("USDC amounts must use at most six decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros <= 0n || micros > BigInt(Number.MAX_SAFE_INTEGER)) invalid("The USDC amount is outside the supported range.");
  return Number(micros);
}

/** Accept the organiser's explicit payment instruction, preserving its exact memo. */
export function parsePaymentInstruction(input: unknown): PaymentTransfer {
  if (typeof input !== "string" || input.length > 2048) invalid("A payment requires the organiser's explicit devnet USDC instruction.");
  const match = input.match(/^Pay (\d+(?:\.\d{1,6})?) devnet USDC to ([1-9A-HJ-NP-Za-km-z]{32,44}) with the memo "([^"\r\n]{1,200})"\. Return \{\s*"signature"\s*:\s*"<transaction signature>"\s*\} in output\.data\.$/);
  if (!match) invalid("Only the organiser's explicit devnet USDC payment instruction is supported.");
  let to: string;
  try { to = address(match[2]); } catch { invalid("The payment recipient is not a valid Solana address."); }
  if (/^1+$/.test(to)) invalid("The payment recipient cannot be the system placeholder address.");
  if (new TextEncoder().encode(match[3]).byteLength > 200) invalid("The payment memo is too long.");
  return { to, amountMicros: decimalMicros(match[1]), memo: match[3] };
}

function configuration(): PaymentConfig {
  return {
    enabled: process.env.PAYMENTS_ENABLED === "true",
    publicKey: process.env.AGENT_PUBLIC_KEY?.trim() ?? "",
    maxPaymentMicros: decimalMicros(process.env.PAYMENT_MAX_USDC ?? "0.05"),
    totalCapMicros: decimalMicros(process.env.PAYMENT_TOTAL_CAP_USDC ?? "0.10"),
  };
}

/** Builds and signs locally; this function never sends a transaction. */
export async function buildDevnetTransfer(signer: KeyPairSigner, transfer: PaymentTransfer, lifetime: { blockhash: string; lastValidBlockHeight: bigint }): Promise<PreparedPayment> {
  const mint = address(USDC_DEVNET_MINT);
  const recipient = address(transfer.to);
  const [source] = await findAssociatedTokenPda({ owner: signer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ owner: recipient, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const instructions: Instruction[] = [
    getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner: recipient, mint }),
    getTransferCheckedInstruction({ source, mint, destination, authority: signer, amount: BigInt(transfer.amountMicros), decimals: 6 }),
    { programAddress: MEMO_PROGRAM, accounts: [], data: new Uint8Array(getUtf8Encoder().encode(transfer.memo)) },
  ];
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: lifetime.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  return { signature: getSignatureFromTransaction(transaction), wireTransaction: getBase64EncodedWireTransaction(transaction), lastValidBlockHeight: lifetime.lastValidBlockHeight.toString() };
}

async function chainFor(config: PaymentConfig): Promise<PaymentChain> {
  let signer: KeyPairSigner;
  try {
    const bytes: unknown = JSON.parse(process.env.AGENT_PRIVATE_KEY ?? "null");
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error();
    signer = await createKeyPairSignerFromBytes(Uint8Array.from(bytes));
    if (signer.address !== config.publicKey) throw new Error();
  } catch { unavailable("The dedicated devnet signing wallet is not configured correctly."); }
  const rpc = createSolanaRpc(devnet(DEVNET_RPC_URL));
  return {
    async prepare(transfer, signal) {
      const { value } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: signal });
      return buildDevnetTransfer(signer, transfer, value);
    },
    async status(signature, signal) {
      const { value } = await rpc.getSignatureStatuses([signature as Parameters<typeof rpc.getSignatureStatuses>[0][number]], { searchTransactionHistory: true }).send({ abortSignal: signal });
      const status = value[0];
      if (status?.err) return "failed";
      return status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized" ? "confirmed" : "pending";
    },
    async broadcast(wireTransaction, signal) {
      await rpc.sendTransaction(wireTransaction as Parameters<typeof rpc.sendTransaction>[0], { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 2n }).send({ abortSignal: signal });
    },
  };
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new PaymentTaskError(504, "upstream_timeout", "Payment confirmation timed out. Retry the same attempt; it will reuse its transaction.");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new PaymentTaskError(504, "upstream_timeout", "Payment confirmation timed out. Retry the same attempt; it will reuse its transaction.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Persist the signed transaction and budget before any broadcast; retries reuse those bytes. */
export async function executePaymentTask(body: JsonRecord, dependencies: PaymentDependencies = {}): Promise<{ data: { signature: string } }> {
  if (!isRecord(body.task) || body.task.type !== "run_workflow") invalid("A payment workflow task is required.");
  const task = body.task;
  const transfer = parsePaymentInstruction(task.input);
  const config = dependencies.config ?? configuration();
  if (!config.enabled) unavailable("Devnet payments are disabled on this deployment.");
  try { address(config.publicKey); } catch { unavailable("The dedicated devnet wallet public address is not configured."); }
  if (!Number.isSafeInteger(config.maxPaymentMicros) || config.maxPaymentMicros <= 0 || !Number.isSafeInteger(config.totalCapMicros) || config.totalCapMicros <= 0) unavailable("Devnet payment limits are not configured correctly.");
  const limits = isRecord(task.limits) ? task.limits : {};
  const spendLimit = limits.maxSpendUsd;
  if (typeof spendLimit !== "number" || !Number.isFinite(spendLimit) || spendLimit < 0) invalid("A payment requires an explicit non-negative spending limit.");
  const callerMicros = Math.floor(spendLimit * 1_000_000 + 1e-8);
  if (transfer.amountMicros > config.maxPaymentMicros || transfer.amountMicros > callerMicros) throw new PaymentTaskError(422, "limit_exceeded", "The requested payment exceeds its devnet USDC limit.");
  if (typeof body.nonce !== "string" || !body.nonce.trim() || body.nonce.length > 512) invalid("A payment requires a bounded request nonce.");
  const attemptId = isRecord(body.attempt) && typeof body.attempt.id === "string" ? body.attempt.id : body.nonce;
  if (!attemptId.trim() || attemptId.length > 512) invalid("A payment requires a bounded attempt identity.");
  const id = createHash("sha256").update(`${config.publicKey}\n${attemptId}`).digest("hex");
  const requestHash = createHash("sha256").update(JSON.stringify({ wallet: config.publicKey, ...transfer })).digest("hex");
  const requestedTimeout = typeof limits.timeoutMs === "number" ? limits.timeoutMs : 55_000;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new PaymentTaskError(504, "upstream_timeout", "The payment time limit was exhausted.");
  const localSignal = AbortSignal.timeout(Math.max(1, Math.min(Math.floor(requestedTimeout), 55_000)));
  const signal = dependencies.signal ? AbortSignal.any([localSignal, dependencies.signal]) : localSignal;
  try {
    const store = dependencies.store ?? createPaymentStore(config.publicKey);
    const chain = dependencies.chain ?? await chainFor(config);
    let record = await store.find(id, signal);
    if (record && record.requestHash !== requestHash) throw new PaymentTaskError(400, "invalid_input", "This attempt is already bound to a different payment.");
    if (!record) {
      const candidate = await chain.prepare(transfer, signal);
      const proposed: PaymentRecord = { id, requestHash, ...transfer, ...candidate, status: "prepared" };
      record = await store.reserve(proposed, config.totalCapMicros, signal);
    }
    if (record.status === "confirmed") return { data: { signature: record.signature } };
    if (record.status === "failed") unavailable("This payment transaction failed. No replacement transfer will be created automatically.");
    let lastBroadcast = 0;
    for (;;) {
      if (signal.aborted) throw new PaymentTaskError(504, "upstream_timeout", "Payment confirmation timed out. Retry this same attempt to check its existing transaction.");
      const status = await chain.status(record.signature, signal);
      if (status === "confirmed") {
        await store.mark(id, "confirmed", signal);
        return { data: { signature: record.signature } };
      }
      if (status === "failed") {
        await store.mark(id, "failed", signal);
        unavailable("The devnet payment failed on chain. No replacement transfer will be created automatically.");
      }
      if (Date.now() - lastBroadcast >= 5_000) {
        lastBroadcast = Date.now();
        // A lost RPC response does not prove a lost transaction. Poll/retry only these same signed bytes.
        try { await chain.broadcast(record.wireTransaction, signal); } catch { if (signal.aborted) throw new PaymentTaskError(504, "upstream_timeout", "Payment submission timed out. Retry this same attempt to check its existing transaction."); }
      }
      await pause(Math.max(1, dependencies.pollIntervalMs ?? 500), signal);
    }
  } catch (error) {
    if (error instanceof PaymentTaskError) throw error;
    if (signal.aborted) throw new PaymentTaskError(504, "upstream_timeout", "Payment processing timed out. Retry this same attempt to check its existing transaction.");
    if (error instanceof PaymentStoreError) {
      if (error.code === "budget") throw new PaymentTaskError(422, "limit_exceeded", error.message);
      if (error.code === "conflict") throw new PaymentTaskError(400, "invalid_input", error.message);
      unavailable(error.message);
    }
    unavailable("The devnet payment service is unavailable. No replacement transaction has been created.");
  }
}
