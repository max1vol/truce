import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

export type PaymentRecord = {
  id: string;
  requestHash: string;
  to: string;
  amountMicros: number;
  memo: string;
  signature: string;
  wireTransaction: string;
  lastValidBlockHeight: string;
  status: "prepared" | "confirmed" | "failed";
};

export type PaymentLedger = {
  version: 1;
  network: "devnet";
  wallet: string;
  reservedMicros: number;
  records: Record<string, PaymentRecord>;
};

type StoreCode = "unavailable" | "conflict" | "budget" | "corrupt" | "precondition";
export class PaymentStoreError extends Error {
  constructor(public readonly code: StoreCode, message: string) {
    super(message);
    this.name = "PaymentStoreError";
  }
}

export interface PaymentStore {
  find(id: string, signal: AbortSignal): Promise<PaymentRecord | null>;
  reserve(record: PaymentRecord, totalCapMicros: number, signal: AbortSignal): Promise<PaymentRecord>;
  mark(id: string, status: "confirmed" | "failed", signal: AbortSignal): Promise<void>;
}

export interface PaymentLedgerIO {
  read(signal: AbortSignal): Promise<{ ledger: PaymentLedger; etag: string }>;
  write(ledger: PaymentLedger, etag: string, signal: AbortSignal): Promise<void>;
}

export const paymentLedgerPath = (wallet: string): string => `payments/devnet/${wallet}.json`;
const MAX_LEDGER_BYTES = 512 * 1024;

function checkedLedger(value: unknown, wallet: string): PaymentLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PaymentStoreError("corrupt", "The payment journal is invalid.");
  const ledger = value as PaymentLedger;
  if (ledger.version !== 1 || ledger.network !== "devnet" || ledger.wallet !== wallet || !Number.isSafeInteger(ledger.reservedMicros) || ledger.reservedMicros < 0 || !ledger.records || typeof ledger.records !== "object" || Array.isArray(ledger.records)) {
    throw new PaymentStoreError("corrupt", "The payment journal is invalid.");
  }
  let reserved = 0;
  for (const [id, record] of Object.entries(ledger.records)) {
    if (!record || record.id !== id || !/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(record.requestHash) || !Number.isSafeInteger(record.amountMicros) || record.amountMicros <= 0 || typeof record.to !== "string" || typeof record.memo !== "string" || typeof record.wireTransaction !== "string" || record.wireTransaction.length > 4096 || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(record.signature) || !/^\d+$/.test(record.lastValidBlockHeight) || !["prepared", "confirmed", "failed"].includes(record.status)) {
      throw new PaymentStoreError("corrupt", "The payment journal is invalid.");
    }
    reserved += record.amountMicros;
  }
  if (!Number.isSafeInteger(reserved) || reserved !== ledger.reservedMicros) throw new PaymentStoreError("corrupt", "The payment journal budget is invalid.");
  return ledger;
}

function blobIO(wallet: string, token: string | undefined): PaymentLedgerIO {
  if (!token && !process.env.BLOB_STORE_ID) throw new PaymentStoreError("unavailable", "The durable payment journal is not configured.");
  // Attached stores can use Vercel's short-lived OIDC identity instead of a saved token.
  const credentials = token ? { token } : { storeId: process.env.BLOB_STORE_ID };
  const pathname = paymentLedgerPath(wallet);
  return {
    async read(signal) {
      try {
        // Compression can weaken the HTTP ETag, which cannot safely guard a Blob write.
        // The identity response binds these exact bytes to the strong version used by CAS.
        const result = await get(pathname, { access: "private", useCache: false, headers: { "accept-encoding": "identity" }, ...credentials, abortSignal: signal });
        if (!result || result.statusCode !== 200) throw new PaymentStoreError("unavailable", "The durable payment journal must be initialized before payments are enabled.");
        if (!Number.isFinite(result.blob.size) || result.blob.size < 0 || result.blob.size > MAX_LEDGER_BYTES) {
          await result.stream.cancel();
          throw new PaymentStoreError("corrupt", "The payment journal exceeded its supported size.");
        }
        const reader = result.stream.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_LEDGER_BYTES) {
              await reader.cancel();
              throw new PaymentStoreError("corrupt", "The payment journal exceeded its supported size.");
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const ledger = checkedLedger(JSON.parse(new TextDecoder().decode(bytes)), wallet);
        return { ledger, etag: result.blob.etag };
      } catch (error) {
        if (error instanceof PaymentStoreError) throw error;
        throw new PaymentStoreError("unavailable", "The durable payment journal could not be read.");
      }
    },
    async write(ledger, etag, signal) {
      const contents = JSON.stringify(ledger);
      if (new TextEncoder().encode(contents).byteLength > MAX_LEDGER_BYTES) throw new PaymentStoreError("budget", "The payment journal is full.");
      try {
        await put(pathname, contents, { access: "private", contentType: "application/json", ...credentials, allowOverwrite: true, addRandomSuffix: false, ifMatch: etag, abortSignal: signal });
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) throw new PaymentStoreError("precondition", "The payment journal changed concurrently.");
        throw new PaymentStoreError("unavailable", "The durable payment journal could not be saved. No new transaction will be sent.");
      }
    },
  };
}

/** A single-wallet CAS journal atomically binds signed bytes and cumulative budget. */
export function createPaymentStore(wallet: string, options: { io?: PaymentLedgerIO; token?: string } = {}): PaymentStore {
  const io = options.io ?? blobIO(wallet, options.token ?? process.env.BLOB_READ_WRITE_TOKEN);
  async function read(signal: AbortSignal) {
    const result = await io.read(signal);
    if (typeof result.etag !== "string" || !result.etag.trim() || result.etag.trim() !== result.etag || result.etag === "*" || /^w\//i.test(result.etag) || /[\r\n]/.test(result.etag)) {
      throw new PaymentStoreError("corrupt", "The payment journal is missing its conditional-write version.");
    }
    return { ledger: checkedLedger(result.ledger, wallet), etag: result.etag };
  }
  return {
    async find(id, signal) {
      const { ledger } = await read(signal);
      return Object.hasOwn(ledger.records, id) ? ledger.records[id] : null;
    },
    async reserve(record, totalCapMicros, signal) {
      for (let retry = 0; retry < 8; retry++) {
        const { ledger, etag } = await read(signal);
        const existing = Object.hasOwn(ledger.records, record.id) ? ledger.records[record.id] : null;
        if (existing) {
          if (existing.requestHash !== record.requestHash) throw new PaymentStoreError("conflict", "This payment attempt is already bound to different instructions.");
          return existing;
        }
        if (Object.keys(ledger.records).length >= 100 || ledger.reservedMicros + record.amountMicros > totalCapMicros) throw new PaymentStoreError("budget", "The cumulative devnet payment budget would be exceeded.");
        const next: PaymentLedger = { ...ledger, records: { ...ledger.records, [record.id]: record }, reservedMicros: ledger.reservedMicros + record.amountMicros };
        try { await io.write(next, etag, signal); return record; }
        catch (error) { if (error instanceof PaymentStoreError && error.code === "precondition") continue; throw error; }
      }
      throw new PaymentStoreError("unavailable", "The payment journal is busy. Retry this same attempt.");
    },
    async mark(id, status, signal) {
      for (let retry = 0; retry < 8; retry++) {
        const { ledger, etag } = await read(signal);
        const record = Object.hasOwn(ledger.records, id) ? ledger.records[id] : null;
        if (!record) throw new PaymentStoreError("corrupt", "The payment journal record is missing.");
        if (record.status === status) return;
        if (record.status !== "prepared") throw new PaymentStoreError("conflict", "The payment already has a final result.");
        const next: PaymentLedger = { ...ledger, records: { ...ledger.records, [id]: { ...record, status } } };
        try { await io.write(next, etag, signal); return; }
        catch (error) { if (error instanceof PaymentStoreError && error.code === "precondition") continue; throw error; }
      }
      throw new PaymentStoreError("unavailable", "The payment journal is busy. Retry this same attempt.");
    },
  };
}
