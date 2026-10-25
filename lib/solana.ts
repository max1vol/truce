import "server-only";

import { address, createKeyPairSignerFromBytes, createSolanaRpc, devnet } from "@solana/kit";

const DEVNET_RPC_URL = devnet("https://api.devnet.solana.com");

export type SolanaConfig = {
  network: "devnet";
  rpcUrl: string;
  publicKey: string | null;
  explorerUrl: string | null;
};

export type AgentWalletStatus = SolanaConfig & {
  configured: boolean;
  balanceSol: number | null;
  balanceStatus: "available" | "unavailable" | "not-configured";
};

/** Returns only the public address. Secret bytes never leave this server module. */
export async function getAgentWalletAddress(): Promise<string | null> {
  const configuredAddress = process.env.AGENT_PUBLIC_KEY?.trim();
  const secret = process.env.AGENT_PRIVATE_KEY?.trim();
  let derivedAddress: string | undefined;

  if (secret) {
    try {
      const bytes: unknown = JSON.parse(secret);
      if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        throw new Error("Invalid bytes");
      }
      derivedAddress = (await createKeyPairSignerFromBytes(Uint8Array.from(bytes))).address;
    } catch {
      throw new Error("Agent wallet secret configuration is invalid.");
    }
  }

  if (configuredAddress) {
    let normalizedAddress: string;
    try {
      normalizedAddress = address(configuredAddress);
    } catch {
      throw new Error("Agent public address configuration is invalid.");
    }
    if (derivedAddress && derivedAddress !== normalizedAddress) {
      throw new Error("Agent public address does not match its configured key.");
    }
    return normalizedAddress;
  }

  return derivedAddress ?? null;
}

/** Safe to serialize to the browser: it contains no credentials or private RPC URLs. */
export async function getSolanaConfig(): Promise<SolanaConfig> {
  const publicKey = await getAgentWalletAddress();
  return {
    network: "devnet",
    rpcUrl: DEVNET_RPC_URL,
    publicKey,
    explorerUrl: publicKey ? `https://explorer.solana.com/address/${publicKey}?cluster=devnet` : null,
  };
}

/** Read-only devnet balance lookup; no funding, signing, or spending operations. */
export async function getAgentWalletStatus(): Promise<AgentWalletStatus> {
  const config = await getSolanaConfig();
  if (!config.publicKey) {
    return { ...config, configured: false, balanceSol: null, balanceStatus: "not-configured" };
  }

  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  try {
    const balance = await rpc.getBalance(address(config.publicKey), { commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(5_000) });
    return { ...config, configured: true, balanceSol: Number(balance.value) / 1_000_000_000, balanceStatus: "available" };
  } catch {
    return { ...config, configured: true, balanceSol: null, balanceStatus: "unavailable" };
  }
}
