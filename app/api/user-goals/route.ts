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
        // Fetch goal data concurrently
        const [goal, [totalValue, percentBps], attachmentCount] = await Promise.all([
          goalManager.goals(goalId),
          goalManager.getGoalProgressFull(goalId),
          goalManager.attachmentCount(goalId)
        ]);

        // Find vault config for this goal
        const vaultConfig = Object.entries(VAULTS).find(([, config]) => 
          config.address.toLowerCase() === goal.vault.toLowerCase()
        );
        if (!vaultConfig) return;

        const [assetName, config] = vaultConfig;
        const vault = new ethers.Contract(config.address, VAULT_ABI, provider);

        // Calculate user's balance in this goal
        let userBalance = BigInt(0);
        const maxAttachments = Math.min(Number(attachmentCount), 50); // Reduced from 100
        
        if (maxAttachments > 0) {
          // Fetch all attachments concurrently
          const attachmentPromises = Array.from({ length: maxAttachments }, (_, i) => 
            goalManager.attachmentAt(goalId, i).catch(() => null)
          );
          const attachments = await Promise.all(attachmentPromises);
          
          // Filter user attachments and fetch deposits concurrently
          const userAttachments = attachments.filter(attachment => 
            attachment && attachment.owner.toLowerCase() === userAddress.toLowerCase()
          );
          
          if (userAttachments.length > 0) {
            const depositPromises = userAttachments.map(attachment => 
              vault.deposits(attachment.depositId).catch(() => null)
            );
            const deposits = await Promise.all(depositPromises);
            
            userBalance = deposits.reduce((sum, deposit) => 
              deposit ? sum + BigInt(deposit.amount) : sum, BigInt(0)
            );
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

    // Check quicksave goals for each vault concurrently
    const quicksavePromises = Object.entries(VAULTS).map(async ([, vaultConfig]) => {
      const quicksaveId = await goalManager.getQuicksaveGoal(vaultConfig.address, userAddress);
      return quicksaveId.toString() !== "0" ? quicksaveId.toString() : null;
    });
    
    const quicksaveIds = (await Promise.all(quicksavePromises)).filter(Boolean);
    await Promise.all(quicksaveIds.map(id => processGoal(id, true)));

    // Check for regular goals (scan recent goal IDs) concurrently
    try {
      const goalIds = Array.from({ length: 41 }, (_, i) => 120 - i); // 120 down to 80
      
      // Batch process goals in chunks to avoid overwhelming the RPC
      const chunkSize = 10;
      for (let i = 0; i < goalIds.length; i += chunkSize) {
        const chunk = goalIds.slice(i, i + chunkSize);
        
        const goalPromises = chunk.map(async (goalId) => {
          try {
            const [goal, attachmentCount] = await Promise.all([
              goalManager.goals(goalId),
              goalManager.attachmentCount(goalId)
            ]);
            
            let isUserGoal = goal.creator.toLowerCase() === userAddress.toLowerCase();
            
            if (!isUserGoal && Number(attachmentCount) > 0) {
              const maxCheck = Math.min(Number(attachmentCount), 5); // Reduced from 10
              const attachmentPromises = Array.from({ length: maxCheck }, (_, j) => 
                goalManager.attachmentAt(goalId, j).catch(() => null)
              );
              const attachments = await Promise.all(attachmentPromises);
              
              isUserGoal = attachments.some(attachment => 
                attachment && attachment.owner.toLowerCase() === userAddress.toLowerCase()
              );
            }
            
            return isUserGoal ? { goalId, goal } : null;
          } catch (error) {
            return null;
          }
        });
        
        const results = await Promise.all(goalPromises);
        const userGoals = results.filter((result): result is { goalId: number; goal: { metadataURI: string } } => result !== null);
        
        // Process found goals concurrently
        await Promise.all(userGoals.map(({ goalId, goal }) => 
          processGoal(goalId.toString(), false, goal.metadataURI)
        ));
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