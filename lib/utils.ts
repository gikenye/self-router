import { ethers } from "ethers";
import { DEFAULT_RPC_URL, VAULTS } from "./constants";

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
  logs: readonly ethers.Log[],
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

/**
 * Format token amount from wei to human-readable format
 */
export function formatTokenAmount(amountWei: string, decimals: number): string {
  try {
    const formatted = ethers.formatUnits(amountWei, decimals);
    // Remove unnecessary trailing zeros and decimal point if needed
    const cleaned = parseFloat(formatted).toString();
    return cleaned;
  } catch (error) {
    console.error("Error formatting amount:", error);
    return amountWei; // Return original if formatting fails
  }
}

/**
 * Format amount with proper decimal places for display
 */
export function formatAmountForDisplay(
  amountWei: string,
  decimals: number,
  displayDecimals = 2
): string {
  try {
    const formatted = ethers.formatUnits(amountWei, decimals);
    const number = parseFloat(formatted);

    // For very small amounts, show more decimal places
    if (number < 0.01 && number > 0) {
      return number.toFixed(6);
    }

    // For normal amounts, use specified decimal places
    return number.toFixed(displayDecimals);
  } catch (error) {
    console.error("Error formatting amount for display:", error);
    return amountWei;
  }
}

/**
 * Detect asset type from vault address and return decimals
 */
export function getAssetDecimalsFromVault(vaultAddress: string): number {
  for (const config of Object.values(VAULTS)) {
    if (config.address.toLowerCase() === vaultAddress.toLowerCase()) {
      return config.decimals;
    }
  }

  // Default to 18 decimals if vault not found
  return 18;
}

/**
 * Get contract-compliant target date (30 days from now)
 */
export function getContractCompliantTargetDate(): number {
  return Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
}
