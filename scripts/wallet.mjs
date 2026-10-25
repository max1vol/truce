#!/usr/bin/env node

import { randomUUID, webcrypto } from "node:crypto";
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { address as solanaAddress, createKeyPairSignerFromBytes, createSignerFromKeyPair, createSolanaRpc, devnet } from "@solana/kit";

const envPath = resolve(process.cwd(), ".env.local");
const command = process.argv[2] ?? "create";
const rpcUrl = devnet("https://api.devnet.solana.com");

function readEntry(contents, name) {
  const entries = contents.split(/\r?\n/);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const match = entries[index].match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`));
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    return value;
  }
  return undefined;
}

async function parseKeypair(value) {
  try {
    const bytes = JSON.parse(value);
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error("Invalid bytes");
    }
    return await createKeyPairSignerFromBytes(Uint8Array.from(bytes));
  } catch {
    throw new Error("AGENT_PRIVATE_KEY must be a JSON array of 64 valid secret-key bytes. Existing key was not changed.");
  }
}

function parsePublicKey(value) {
  try {
    return solanaAddress(value);
  } catch {
    throw new Error("AGENT_PUBLIC_KEY is not a valid Solana address.");
  }
}

async function exportSecretBytes(signer) {
  const privateJwk = await webcrypto.subtle.exportKey("jwk", signer.keyPair.privateKey);
  if (typeof privateJwk.d !== "string") throw new Error("Private key export failed");
  const privateBytes = Buffer.from(privateJwk.d, "base64url");
  const publicBytes = new Uint8Array(await webcrypto.subtle.exportKey("raw", signer.keyPair.publicKey));
  if (privateBytes.length !== 32 || publicBytes.length !== 32) throw new Error("Invalid key export length");
  const secretBytes = new Uint8Array(64);
  secretBytes.set(privateBytes);
  secretBytes.set(publicBytes, 32);
  privateBytes.fill(0);
  return secretBytes;
}

function setEntry(contents, name, value) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const lines = contents.split(/\r?\n/);
  const remaining = lines.filter((line) => !pattern.test(line));
  while (remaining.at(-1) === "") remaining.pop();
  return `${remaining.length ? `${remaining.join("\n")}\n` : ""}${name}=${value}\n`;
}

async function saveEnv(contents) {
  const temporaryPath = `${envPath}.wallet-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, envPath);
    await chmod(envPath, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function main() {
  if (!["create", "address", "status"].includes(command) || process.argv.length > 3) {
    throw new Error("Usage: node scripts/wallet.mjs [create|address|status]");
  }

  let contents = "";
  try {
    const info = await lstat(envPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(".env.local must be a regular file, not a symlink.");
    }
    contents = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const secret = process.env.AGENT_PRIVATE_KEY || readEntry(contents, "AGENT_PRIVATE_KEY");
  const configuredAddress = process.env.AGENT_PUBLIC_KEY || readEntry(contents, "AGENT_PUBLIC_KEY");
  let wallet = secret ? await parseKeypair(secret) : undefined;
  let created = false;

  if (command === "create" && !wallet) {
    const keyPair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    wallet = await createSignerFromKeyPair(keyPair);
    const secretBytes = await exportSecretBytes(wallet);
    contents = setEntry(contents, "AGENT_PRIVATE_KEY", JSON.stringify(Array.from(secretBytes)));
    secretBytes.fill(0);
    contents = setEntry(contents, "AGENT_PUBLIC_KEY", wallet.address);
    await saveEnv(contents);
    created = true;
  } else if (wallet && configuredAddress && wallet.address !== parsePublicKey(configuredAddress)) {
    throw new Error("AGENT_PUBLIC_KEY does not match AGENT_PRIVATE_KEY. Existing configuration was not changed.");
  }

  const address = wallet?.address ?? (configuredAddress ? parsePublicKey(configuredAddress) : undefined);
  if (!address) throw new Error("No agent wallet configured. Run node scripts/wallet.mjs create first.");

  // An externally supplied environment secret stays external; do not create a
  // misleading local file containing only its public address.
  if (command === "create" && !created && !process.env.AGENT_PRIVATE_KEY && readEntry(contents, "AGENT_PRIVATE_KEY")) {
    contents = setEntry(contents, "AGENT_PUBLIC_KEY", address);
    await saveEnv(contents);
  }

  if (command === "address") {
    console.log(address);
    return;
  }

  console.log(created ? "Created a throwaway devnet agent wallet." : "Agent wallet is configured.");
  console.log(`Public address: ${address}`);
  console.log("Network: Solana devnet");
  console.log(`Explorer: https://explorer.solana.com/address/${address}?cluster=devnet`);

  if (command === "status") {
    const rpc = createSolanaRpc(rpcUrl);
    try {
      const balance = await rpc.getBalance(address, { commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(5_000) });
      console.log(`Devnet balance: ${Number(balance.value) / 1_000_000_000} SOL`);
    } catch {
      console.log("Devnet balance: unavailable (public RPC request failed).");
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  // Never print SDK exceptions, parsed values, or stack traces that could contain secrets.
  const safeMessages = ["AGENT_PRIVATE_KEY must", "AGENT_PUBLIC_KEY", ".env.local must", "Usage:", "No agent wallet configured"];
  const message = error instanceof Error && safeMessages.some((prefix) => error.message.startsWith(prefix))
    ? error.message
    : "Wallet operation failed. No secret values were printed.";
  console.error(message);
  process.exitCode = 1;
});
