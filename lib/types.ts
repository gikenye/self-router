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
  formattedShares: string;
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
  formattedScore: string;
  rank: number | null; // null if user not in top list
  totalUsers: string;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  score: string;
  formattedScore: string;
}

export interface LeaderboardResponse {
  total: string;
  start: number;
  limit: number;
  data: LeaderboardEntry[];
}

export interface JoinGoalRequest {
  goalId: string;
  userAddress: string;
  depositTxHash: string;
  asset: keyof typeof import("./constants").VAULTS;
}

export interface JoinGoalResponse {
  success: boolean;
  goalId: string;
  depositId: string;
  amount: string;
  formattedAmount: string;
  attachTxHash: string;
}

export interface CreateGoalRequest {
  vaultAddress: string;
  targetAmount: string;
  targetDate?: string;
  name: string;
  creatorAddress: string;
}

export interface CreateGoalResponse {
  success: boolean;
  goalId: string;
  creator: string;
  txHash: string;
  shareLink: string;
}

export interface ErrorResponse {
  error: string;
}

// Utility types
export type ApiResponse<T> = T | ErrorResponse;

export type VaultAsset = keyof typeof import("./constants").VAULTS;
