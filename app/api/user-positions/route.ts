import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  VAULTS,
  CONTRACTS,
  VAULT_ABI,
  GOAL_MANAGER_ABI,
  LEADERBOARD_ABI,
} from "../../../lib/constants";
import {
  createProvider,
  isValidAddress,
  formatAmountForDisplay,
} from "../../../lib/utils";
import type {
  ErrorResponse,
  UserDeposit,
  UserGoal,
  AssetBalance,
  UserPositionsResponse,
} from "../../../lib/types";

export async function GET(
  request: NextRequest
): Promise<NextResponse<UserPositionsResponse | ErrorResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get("userAddress");

    if (!userAddress) {
      return NextResponse.json(
        { error: "Missing required parameter: userAddress" },
        { status: 400 }
      );
    }

    if (!isValidAddress(userAddress)) {
      return NextResponse.json(
        { error: "Invalid userAddress" },
        { status: 400 }
      );
    }

    const provider = createProvider();
    const goalManager = new ethers.Contract(
      CONTRACTS.GOAL_MANAGER,
      GOAL_MANAGER_ABI,
      provider
    );
    const leaderboard = new ethers.Contract(
      CONTRACTS.LEADERBOARD,
      LEADERBOARD_ABI,
      provider
    );

    // Get leaderboard data
    const score = await leaderboard.getUserScore(userAddress);
    const topLength = await leaderboard.getTopListLength();
    let rank: number | null = null;

    if (score > BigInt(0)) {
      for (let i = 0; i < Number(topLength) && i < 1000; i++) {
        try {
          const topUser = await leaderboard.topList(i);
          if (topUser.toLowerCase() === userAddress.toLowerCase()) {
            rank = i + 1;
            break;
          }
        } catch {
          break;
        }
      }
    }

    // Initialize collections
    const deposits: UserDeposit[] = [];
    const goals: UserGoal[] = [];
    const assetBalances: { [key: string]: AssetBalance } = {};

    // Process each vault
    for (const [assetName, vaultConfig] of Object.entries(VAULTS)) {
      const vault = new ethers.Contract(
        vaultConfig.address,
        VAULT_ABI,
        provider
      );

      // Get quicksave goal for this vault
      const quicksaveId = await goalManager.getQuicksaveGoal(
        vaultConfig.address,
        userAddress
      );

      if (quicksaveId.toString() !== "0") {
        try {
          const goal = await goalManager.goals(quicksaveId);
          const [totalValue, percentBps] = await goalManager.getGoalProgressFull(quicksaveId);
          const attachmentCount = await goalManager.attachmentCount(quicksaveId);

          goals.push({
            goalId: quicksaveId.toString(),
            vault: vaultConfig.address,
            asset: assetName,
            targetAmountWei: goal.targetAmount.toString(),
            targetAmountUSD: formatAmountForDisplay(
              goal.targetAmount.toString(),
              vaultConfig.decimals
            ),
            targetDate: goal.targetDate.toString(),
            totalValueWei: totalValue.toString(),
            totalValueUSD: formatAmountForDisplay(
              totalValue.toString(),
              vaultConfig.decimals
            ),
            percentBps: percentBps.toString(),
            progressPercent: (Number(percentBps) / 100).toFixed(2),
            isQuicksave: true,
            attachmentCount: attachmentCount.toString(),
          });

          // Get deposits attached to this goal
          const maxAttachments = Math.min(Number(attachmentCount), 100);
          for (let i = 0; i < maxAttachments; i++) {
            try {
              const attachment = await goalManager.attachmentAt(quicksaveId, i);
              if (attachment.owner.toLowerCase() === userAddress.toLowerCase()) {
                try {
                  const deposit = await vault.deposits(attachment.depositId);
                  const currentTime = Math.floor(Date.now() / 1000);
                  const timeRemaining = deposit.unlocked ? null : 
                    Math.max(0, Number(deposit.lockedUntil) - currentTime);

                const userDeposit: UserDeposit = {
                  depositId: attachment.depositId.toString(),
                  vault: vaultConfig.address,
                  asset: assetName,
                  amountWei: deposit.amount.toString(),
                  amountUSD: formatAmountForDisplay(
                    deposit.amount.toString(),
                    vaultConfig.decimals
                  ),
                  sharesWei: deposit.shares.toString(),
                  sharesUSD: formatAmountForDisplay(
                    deposit.shares.toString(),
                    vaultConfig.decimals
                  ),
                  lockTier: deposit.lockTier.toString(),
                  lockedUntil: deposit.lockedUntil.toString(),
                  unlocked: deposit.unlocked,
                  timeRemaining,
                };

                  deposits.push(userDeposit);

                  // Aggregate asset balances
                  if (!assetBalances[assetName]) {
                    assetBalances[assetName] = {
                      asset: assetName,
                      vault: vaultConfig.address,
                      totalAmountWei: "0",
                      totalAmountUSD: "0",
                      totalSharesWei: "0",
                      totalSharesUSD: "0",
                      depositCount: 0,
                    };
                  }

                  const balance = assetBalances[assetName];
                  balance.totalAmountWei = (BigInt(balance.totalAmountWei) + BigInt(deposit.amount)).toString();
                  balance.totalSharesWei = (BigInt(balance.totalSharesWei) + BigInt(deposit.shares)).toString();
                  balance.depositCount++;
                } catch (depositError) {
                  console.error(`Deposit ${attachment.depositId} not found, skipping`);
                }
              }
            } catch (error) {
              console.error(`Error processing attachment ${i} for goal ${quicksaveId}:`, error);
            }
          }
        } catch (error) {
          console.error(`Error processing quicksave goal ${quicksaveId}:`, error);
        }
      }
    }

    // Add goal values to asset balances for goals without processed deposits
    goals.forEach(goal => {
      if (goal.totalValueWei !== "0" && !assetBalances[goal.asset]) {
        assetBalances[goal.asset] = {
          asset: goal.asset,
          vault: goal.vault,
          totalAmountWei: goal.totalValueWei,
          totalAmountUSD: goal.totalValueUSD,
          totalSharesWei: "0",
          totalSharesUSD: "0",
          depositCount: parseInt(goal.attachmentCount),
        };
      }
    });

    // Format asset balances
    Object.values(assetBalances).forEach(balance => {
      const vaultConfig = VAULTS[balance.asset as keyof typeof VAULTS];
      balance.totalAmountUSD = formatAmountForDisplay(
        balance.totalAmountWei,
        vaultConfig.decimals
      );
      balance.totalSharesUSD = formatAmountForDisplay(
        balance.totalSharesWei,
        vaultConfig.decimals
      );
    });

    // Calculate total value from goals and asset balances
    const goalTotalUSD = goals.reduce((sum, goal) => {
      return sum + parseFloat(goal.totalValueUSD);
    }, 0);
    
    const totalValueUSD = goalTotalUSD.toFixed(2);

    const response: UserPositionsResponse = {
      userAddress,
      totalValueUSD,
      leaderboardScore: score.toString(),
      formattedLeaderboardScore: formatAmountForDisplay(score.toString(), 18, 2),
      leaderboardRank: rank,
      assetBalances: Object.values(assetBalances),
      deposits,
      goals,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("User positions API error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}

export async function POST(): Promise<NextResponse<ErrorResponse>> {
  return NextResponse.json(
    { error: "Method not allowed. Use GET." },
    { status: 405 }
  );
}