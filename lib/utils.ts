import { ethers } from "ethers";
import { DEFAULT_RPC_URL } from "./constants";

/**
 * Create an ethers provider using the configured RPC URL
 */
export function createProvider(): ethers.JsonRpcProvider {
  const rpcUrl = process.env.RPC_URL || DEFAULT_RPC_URL;
  return new ethers.JsonRpcProvider(rpcUrl);
}

/**
 * Create a backend wallet instance for transaction signing
 */
export function createBackendWallet(
  provider: ethers.JsonRpcProvider
): ethers.Wallet {
  const privateKey = process.env.BACKEND_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("BACKEND_PRIVATE_KEY environment variable is required");
  }

  const formattedKey = privateKey.startsWith("0x")
    ? privateKey
    : `0x${privateKey}`;
  return new ethers.Wallet(formattedKey, provider);
}

/**
 * Wait for transaction receipt with retries
 */
export async function waitForTransactionReceipt(
  provider: ethers.JsonRpcProvider,
  txHash: string,
  maxRetries = 5,
  retryDelay = 2000
): Promise<ethers.TransactionReceipt | null> {
  for (let i = 0; i < maxRetries; i++) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      return receipt;
    }
    if (i < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  return null;
}

/**
 * Find event in transaction logs
 */
export function findEventInLogs(
  logs: ethers.Log[],
  contract: ethers.Contract,
  eventName: string
): ethers.LogDescription | null {
  const event = logs.find((log) => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed?.name === eventName;
    } catch {
      return false;
    }
  });

  if (!event) return null;

  return contract.interface.parseLog(event);
}

/**
 * Validate Ethereum address
 */
export function isValidAddress(address: string): boolean {
  return ethers.isAddress(address);
}
