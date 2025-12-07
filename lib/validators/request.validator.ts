import { isValidAddress } from "../utils";

export class RequestValidator {
  static validateUserAddress(userAddress: string | null): { valid: boolean; error?: string } {
    if (!userAddress) {
      return { valid: false, error: "Missing required parameter: userAddress" };
    }

    if (!isValidAddress(userAddress)) {
      return { valid: false, error: "Invalid userAddress" };
    }

    return { valid: true };
  }

  static validateVaultAddress(vaultAddress: string | null): { valid: boolean; error?: string } {
    if (!vaultAddress) {
      return { valid: false, error: "Missing required parameter: vaultAddress" };
    }

    if (!isValidAddress(vaultAddress)) {
      return { valid: false, error: "Invalid vaultAddress" };
    }

    return { valid: true };
  }
}
