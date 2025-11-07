// Type definitions for API requests and responses

export interface AllocateRequest {
  asset: keyof typeof import("./constants").VAULTS;
  userAddress: string;
  amount: string;
  txHash: string;
}

export interface AllocateResponse {
  success: boolean;
  depositId: string;
  quicksaveGoalId: string;
  shares: string;
  allocationTxHash: string;
}

export interface GoalAttachment {
  owner: string;
  depositId: string;
  attachedAt: string;
  pledged: boolean;
}

export interface Goal {
  id: string;
  creator: string;
  vault: string;
  targetAmount: string;
  targetDate: string;
  metadataURI: string;
  createdAt: string;
  cancelled: boolean;
  completed: boolean;
  totalValue: string;
  percentBps: string;
  attachments: GoalAttachment[];
}

export interface QuicksaveGoalResponse {
  quicksaveGoalId: string;
}

export interface UserScore {
  userAddress: string;
  score: string;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  score: string;
}

export interface LeaderboardResponse {
  total: string;
  start: number;
  limit: number;
  data: LeaderboardEntry[];
}

export interface ErrorResponse {
  error: string;
}

// Utility types
export type ApiResponse<T> = T | ErrorResponse;

export type VaultAsset = keyof typeof import("./constants").VAULTS;
