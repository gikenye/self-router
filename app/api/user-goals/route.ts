import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  VAULTS,
  CONTRACTS,
  VAULT_ABI,
  GOAL_MANAGER_ABI,
} from "../../../lib/constants";
import {
  createProvider,
  isValidAddress,
  formatAmountForDisplay,
} from "../../../lib/utils";
import type { ErrorResponse } from "../../../lib/types";

interface UserGoalDetails {
  goalId: string;
  vault: string;
  asset: string;
  name: string;
  creator: string;
  targetAmountWei: string;
  targetAmountUSD: string;
  targetDate: string;
  totalValueWei: string;
  totalValueUSD: string;
  percentBps: string;
  progressPercent: string;
  isQuicksave: boolean;
  attachmentCount: string;
  userBalance: string;
  userBalanceUSD: string;
  createdAt: string;
  completed: boolean;
  cancelled: boolean;
}

interface UserGoalsResponse {
  userAddress: string;
  totalGoals: number;
  totalValueUSD: string;
  goals: UserGoalDetails[];
}

export async function GET(
  request: NextRequest
): Promise<NextResponse<UserGoalsResponse | ErrorResponse>> {
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

    const goals: UserGoalDetails[] = [];
    let totalValueUSD = 0;
    const processedGoals = new Set<string>();

    // Helper function to process a goal
    const processGoal = async (goalId: string, isQuicksave: boolean, goalName?: string) => {
      if (processedGoals.has(goalId)) return;
      processedGoals.add(goalId);

      try {
        const goal = await goalManager.goals(goalId);
        const [totalValue, percentBps] = await goalManager.getGoalProgressFull(goalId);
        const attachmentCount = await goalManager.attachmentCount(goalId);

        // Find vault config for this goal
        const vaultConfig = Object.entries(VAULTS).find(([, config]) => 
          config.address.toLowerCase() === goal.vault.toLowerCase()
        );
        if (!vaultConfig) return;

        const [assetName, config] = vaultConfig;
        const vault = new ethers.Contract(config.address, VAULT_ABI, provider);

        // Calculate user's balance in this goal
        let userBalance = BigInt(0);
        const maxAttachments = Math.min(Number(attachmentCount), 100);
        
        for (let i = 0; i < maxAttachments; i++) {
          try {
            const attachment = await goalManager.attachmentAt(goalId, i);
            if (attachment.owner.toLowerCase() === userAddress.toLowerCase()) {
              try {
                const deposit = await vault.deposits(attachment.depositId);
                userBalance += BigInt(deposit.amount);
              } catch (depositError) {
                console.error(`Deposit ${attachment.depositId} not found, skipping`);
              }
            }
          } catch (error) {
            console.error(`Error processing attachment ${i}:`, error);
          }
        }

        const goalDetails: UserGoalDetails = {
          goalId,
          vault: config.address,
          asset: assetName,
          name: goalName || (isQuicksave ? "Quicksave" : goal.metadataURI || `Goal ${goalId}`),
          creator: goal.creator,
          targetAmountWei: goal.targetAmount.toString(),
          targetAmountUSD: formatAmountForDisplay(
            goal.targetAmount.toString(),
            config.decimals
          ),
          targetDate: goal.targetDate.toString(),
          totalValueWei: totalValue.toString(),
          totalValueUSD: formatAmountForDisplay(
            totalValue.toString(),
            config.decimals
          ),
          percentBps: percentBps.toString(),
          progressPercent: (Number(percentBps) / 100).toFixed(2),
          isQuicksave,
          attachmentCount: attachmentCount.toString(),
          userBalance: userBalance.toString(),
          userBalanceUSD: formatAmountForDisplay(
            userBalance.toString(),
            config.decimals
          ),
          createdAt: goal.createdAt.toString(),
          completed: goal.completed,
          cancelled: goal.cancelled,
        };

        goals.push(goalDetails);
        totalValueUSD += parseFloat(goalDetails.userBalanceUSD);
      } catch (error) {
        console.error(`Error processing goal ${goalId}:`, error);
      }
    };

    // Check quicksave goals for each vault
    for (const [, vaultConfig] of Object.entries(VAULTS)) {
      const quicksaveId = await goalManager.getQuicksaveGoal(
        vaultConfig.address,
        userAddress
      );
      if (quicksaveId.toString() !== "0") {
        await processGoal(quicksaveId.toString(), true);
      }
    }

    // Check for regular goals (scan recent goal IDs)
    try {
      for (let goalId = 95; goalId >= 80; goalId--) {
        try {
          const goal = await goalManager.goals(goalId);
          
          // Include goal if:
          // 1. User is the creator
          // 2. User has attachments to this goal
          let isUserGoal = goal.creator.toLowerCase() === userAddress.toLowerCase();
          
          if (!isUserGoal) {
            // Check if user has attachments to this goal
            const attachmentCount = await goalManager.attachmentCount(goalId);
            if (Number(attachmentCount) > 0) {
              const maxCheck = Math.min(Number(attachmentCount), 10);
              for (let i = 0; i < maxCheck; i++) {
                try {
                  const attachment = await goalManager.attachmentAt(goalId, i);
                  if (attachment.owner.toLowerCase() === userAddress.toLowerCase()) {
                    isUserGoal = true;
                    break;
                  }
                } catch (error) {
                  break;
                }
              }
            }
          }
          
          if (isUserGoal) {
            await processGoal(goalId.toString(), false, goal.metadataURI);
          }
        } catch (error) {
          // Goal doesn't exist, continue
        }
      }
    } catch (error) {
      console.error("Error scanning for user goals:", error);
    }



    const response: UserGoalsResponse = {
      userAddress,
      totalGoals: goals.length,
      totalValueUSD: totalValueUSD.toFixed(2),
      goals,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("User goals API error:", error);
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