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
  Goal,
  GoalAttachment,
} from "../../../lib/types";

interface UserGoalDetails extends UserGoal {
  name: string;
  creator: string;
  userBalance: string;
  userBalanceUSD: string;
  createdAt: string;
  completed: boolean;
  cancelled: boolean;
}

interface ConsolidatedUserResponse extends UserPositionsResponse {
  goals: UserGoalDetails[];
  leaderboardData?: {
    rank: number | null;
    score: string;
    formattedScore: string;
    totalUsers: string;
  };
  goalDetails?: Goal;
  quicksaveGoalId?: string;
}

export async function GET(
  request: NextRequest
): Promise<NextResponse<ConsolidatedUserResponse | ErrorResponse>> {
  try {
    console.log('📊 Consolidated user API called:', request.url);
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get("userAddress");
    const targetGoalId = searchParams.get("targetGoalId");
    const goalId = searchParams.get("goalId");
    const vaultAddress = searchParams.get("vaultAddress");
    const includeLeaderboard = searchParams.get("includeLeaderboard") === "true";
    
    console.log('🎯 Consolidated API parameters:', {
      userAddress,
      targetGoalId,
      goalId,
      vaultAddress,
      includeLeaderboard
    });

    if (!userAddress) {
      console.error('❌ Missing userAddress parameter');
      return NextResponse.json(
        { error: "Missing required parameter: userAddress" },
        { status: 400 }
      );
    }

    if (!isValidAddress(userAddress)) {
      console.error('❌ Invalid userAddress:', userAddress);
      return NextResponse.json(
        { error: "Invalid userAddress" },
        { status: 400 }
      );
    }
    
    console.log('✅ Processing user positions for:', userAddress);

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
    const goals: UserGoalDetails[] = [];
    const assetBalances: { [key: string]: AssetBalance } = {};
    let goalDetails: Goal | undefined;
    let quicksaveGoalId: string | undefined;
    let leaderboardData: { rank: number | null; score: string; formattedScore: string; totalUsers: string; } | undefined;

    // Handle specific goal query if goalId is provided
    if (goalId) {
      try {
        const goal = await goalManager.goals(goalId);
        const [totalValue, percentBps] = await goalManager.getGoalProgressFull(goalId);
        const attachmentCount = await goalManager.attachmentCount(goalId);

        const attachments: GoalAttachment[] = [];
        const maxAttachments = Math.min(Number(attachmentCount), 100);

        for (let i = 0; i < maxAttachments; i++) {
          const attachment = await goalManager.attachmentAt(goalId, i);
          attachments.push({
            owner: attachment.owner,
            depositId: attachment.depositId.toString(),
            attachedAt: attachment.attachedAt.toString(),
            pledged: attachment.pledged,
          });
        }

        goalDetails = {
          id: goal.id.toString(),
          creator: goal.creator,
          vault: goal.vault,
          targetAmount: goal.targetAmount.toString(),
          targetDate: goal.targetDate.toString(),
          metadataURI: goal.metadataURI,
          createdAt: goal.createdAt.toString(),
          cancelled: goal.cancelled,
          completed: goal.completed,
          totalValue: totalValue.toString(),
          percentBps: percentBps.toString(),
          attachments,
        };
      } catch (error) {
        console.error(`Error fetching goal ${goalId}:`, error);
      }
    }

    // Handle quicksave goal query if userAddress and vaultAddress are provided
    if (userAddress && vaultAddress && isValidAddress(vaultAddress)) {
      try {
        let quicksaveId = await goalManager.getQuicksaveGoal(vaultAddress, userAddress);
        
        if (quicksaveId.toString() === "0") {
          try {
            const { createBackendWallet, findEventInLogs } = await import("../../../lib/utils");
            const backendWallet = createBackendWallet(provider);
            const goalManagerWithSigner = new ethers.Contract(
              CONTRACTS.GOAL_MANAGER,
              GOAL_MANAGER_ABI,
              backendWallet
            );
            
            const createTx = await goalManagerWithSigner.createQuicksaveGoalFor(
              userAddress,
              vaultAddress
            );
            const createReceipt = await createTx.wait();

            const goalEvent = findEventInLogs(
              createReceipt.logs,
              goalManagerWithSigner,
              "GoalCreated"
            );
            
            if (goalEvent) {
              quicksaveId = goalEvent.args.goalId;
            }
          } catch (error) {
            console.error("Failed to auto-create quicksave goal:", error);
          }
        }
        
        quicksaveGoalId = quicksaveId.toString();
      } catch (error) {
        console.error("Error handling quicksave goal:", error);
      }
    }

    // Handle leaderboard data if requested
    if (includeLeaderboard && userAddress) {
      try {
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

        // Determine primary asset for formatting (use the asset with highest balance)
        let primaryAssetDecimals = 6; // Default to USDC
        if (Object.keys(assetBalances).length > 0) {
          const primaryAsset = Object.keys(assetBalances).reduce((a, b) => 
            parseFloat(assetBalances[a].totalAmountUSD) > parseFloat(assetBalances[b].totalAmountUSD) ? a : b
          );
          primaryAssetDecimals = VAULTS[primaryAsset as keyof typeof VAULTS]?.decimals || 6;
        }

        leaderboardData = {
          rank,
          score: score.toString(),
          formattedScore: formatAmountForDisplay(score.toString(), primaryAssetDecimals, 2),
          totalUsers: topLength.toString(),
        };
      } catch (error) {
        console.error("Error fetching leaderboard data:", error);
      }
    }

    // Process each vault for user positions (parallel processing)
    const vaultPromises = Object.entries(VAULTS).map(async ([assetName, vaultConfig]) => {
      const vault = new ethers.Contract(
        vaultConfig.address,
        VAULT_ABI,
        provider
      );

      // Check if user has any deposits first
      const depositCount = await vault.depositCount(userAddress);
      if (Number(depositCount) === 0) {
        console.log(`User has 0 deposits in ${assetName} vault`);
        return { assetName, deposits: [], goals: [], assetBalance: null };
      }
      
      console.log(`User has ${depositCount} deposits in ${assetName} vault`);

      // Initialize vault-specific collections
      const vaultDeposits: UserDeposit[] = [];
      const vaultGoals: UserGoalDetails[] = [];
      const vaultAssetBalance = {
        asset: assetName,
        vault: vaultConfig.address,
        totalAmountWei: "0",
        totalAmountUSD: "0",
        totalSharesWei: "0",
        totalSharesUSD: "0",
        depositCount: 0,
      };

      // Get quicksave goal for this vault
      const quicksaveId = await goalManager.getQuicksaveGoal(
        vaultConfig.address,
        userAddress
      );

      // Get all user goals for this vault (quicksave + custom)
      const allGoalIds: string[] = [];
      
      if (quicksaveId.toString() !== "0") {
        allGoalIds.push(quicksaveId.toString());
      }
      
      // Use events to find user goals (production scalable)
      try {
        const filter = goalManager.filters.GoalCreated(null, userAddress, vaultConfig.address);
        const events = await goalManager.queryFilter(filter, -50000); // Last 50k blocks
        
        for (const event of events) {
          if ('args' in event) {
            const goalId = event.args.goalId.toString();
            if (!allGoalIds.includes(goalId)) {
              try {
                const goal = await goalManager.goals(goalId);
                if (goal.id.toString() !== "0" && !goal.cancelled && !goal.completed) {
                  allGoalIds.push(goalId);
                }
              } catch {
                // Goal might not exist
              }
            }
          }
        }
      } catch (eventError) {
        console.error('Event query failed, using limited fallback:', eventError);
        // Emergency fallback - scan only recent 5 goals
        const recentGoals = Array.from({ length: 5 }, (_, i) => 120 - i);
        for (const goalId of recentGoals) {
          try {
            const goal = await goalManager.goals(goalId);
            if (goal.id.toString() !== "0" && 
                goal.creator.toLowerCase() === userAddress.toLowerCase() && 
                goal.vault.toLowerCase() === vaultConfig.address.toLowerCase() &&
                !goal.cancelled && !goal.completed &&
                !allGoalIds.includes(goalId.toString())) {
              allGoalIds.push(goalId.toString());
            }
          } catch {
            // Skip non-existent goals
          }
        }
      }
      
      console.log(`Total goals found for ${assetName}:`, allGoalIds);
      
      // Process all goals
      for (const goalId of allGoalIds) {
        const isQuicksave = goalId === quicksaveId.toString();
        
        try {
          const goal = await goalManager.goals(goalId);
          // Skip if goal doesn't exist (id will be 0)
          if (goal.id.toString() === "0") {
            continue;
          }
          
          let totalValue, percentBps, attachmentCount;
          try {
            [totalValue, percentBps] = await goalManager.getGoalProgressFull(goalId);
            attachmentCount = await goalManager.attachmentCount(goalId);
          } catch (progressError) {
            // Goal exists but progress call failed, skip this goal
            console.error(`Error getting progress for goal ${goalId}:`, progressError instanceof Error ? progressError.message : String(progressError));
            continue;
          }

          vaultGoals.push({
            goalId: goalId.toString(),
            vault: vaultConfig.address,
            asset: assetName,
            name: isQuicksave ? "Quicksave" : goal.metadataURI || `Goal ${goalId}`,
            creator: goal.creator,
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
            isQuicksave,
            attachmentCount: attachmentCount.toString(),
            userBalance: "0",
            userBalanceUSD: "0.00",
            createdAt: goal.createdAt.toString(),
            completed: goal.completed,
            cancelled: goal.cancelled,
          });

          // Get deposits attached to this goal
          const maxAttachments = Math.min(Number(attachmentCount), 100);
          for (let i = 0; i < maxAttachments; i++) {
            try {
              const attachment = await goalManager.attachmentAt(goalId, i);
              if (attachment.owner.toLowerCase() === userAddress.toLowerCase()) {
                try {
                  const deposit = await vault.deposits(userAddress, attachment.depositId);
                  const currentTime = Math.floor(Date.now() / 1000);
                  const timeRemaining = Number(deposit.lockEnd) > currentTime ? 
                    Number(deposit.lockEnd) - currentTime : null;

                const userDeposit: UserDeposit = {
                  depositId: attachment.depositId.toString(),
                  vault: vaultConfig.address,
                  asset: assetName,
                  amountWei: deposit.principal.toString(),
                  amountUSD: formatAmountForDisplay(
                    deposit.principal.toString(),
                    vaultConfig.decimals
                  ),
                  sharesWei: deposit.shares.toString(),
                  sharesUSD: formatAmountForDisplay(
                    deposit.shares.toString(),
                    vaultConfig.decimals
                  ),
                  lockTier: "0",
                  lockedUntil: deposit.lockEnd.toString(),
                  unlocked: Number(deposit.lockEnd) <= currentTime,
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
                  balance.totalAmountWei = (BigInt(balance.totalAmountWei) + BigInt(deposit.principal)).toString();
                  balance.totalSharesWei = (BigInt(balance.totalSharesWei) + BigInt(deposit.shares)).toString();
                  balance.depositCount++;
                } catch (depositError) {
                  console.error(`Deposit ${attachment.depositId} not found, skipping`);
                }
              }
            } catch (error) {
              console.error(`Error processing attachment ${i} for goal ${goalId}:`, error);
            }
          }
        } catch (error) {
          console.error(`Error processing goal ${goalId}:`, error);
        }
      }

      // Check for unattached deposits and auto-attach them to quicksave goal
      try {
        if (Number(depositCount) > 0) {
          const unattachedDepositIndices: number[] = [];
          
          // Check each deposit to see if it's attached to a goal
          for (let i = 0; i < Number(depositCount); i++) {
            try {
              // Calculate the deposit key as done in the contract
              const key = ethers.solidityPackedKeccak256(
                ["address", "address", "uint256"],
                [vaultConfig.address, userAddress, i]
              );
              
              // Check if this deposit is attached to any goal
              const attachedGoalId = await goalManager.depositToGoal(key);
              
              if (attachedGoalId.toString() === "0") {
                // Deposit is not attached to any goal
                unattachedDepositIndices.push(i);
              }
            } catch (error) {
              console.error(`Error checking deposit ${i} attachment:`, error);
            }
          }
          
          console.log(`Found ${unattachedDepositIndices.length} unattached deposits`);
          
          // Determine which goal to attach to
          let attachmentGoalId = quicksaveId;
          if (targetGoalId && targetGoalId !== "0") {
            attachmentGoalId = BigInt(targetGoalId);
            console.log(`🎯 Using target goal ${targetGoalId} instead of quicksave goal ${quicksaveId}`);
          }
          
          // If we have unattached deposits and a goal to attach to, try to attach them
          if (unattachedDepositIndices.length > 0 && attachmentGoalId.toString() !== "0") {
            try {
              console.log(`Attempting to attach ${unattachedDepositIndices.length} deposits to goal ${attachmentGoalId}`);
              
              const privateKey = process.env.BACKEND_PRIVATE_KEY;
              if (privateKey) {
                const signer = new ethers.Wallet(privateKey, provider);
                const goalManagerWithSigner = goalManager.connect(signer);
                
                try {
                  // Try to attach all unattached deposits
                  const tx = await (goalManagerWithSigner as ethers.Contract & { attachDepositsOnBehalf: (goalId: bigint, owner: string, depositIds: number[]) => Promise<ethers.ContractTransactionResponse> }).attachDepositsOnBehalf(
                    attachmentGoalId,
                    userAddress,
                    unattachedDepositIndices
                  );
                  
                  console.log(`Attachment transaction sent: ${tx.hash}`);
                  await tx.wait();
                  console.log(`Successfully attached ${unattachedDepositIndices.length} deposits to goal ${attachmentGoalId}`);
                  
                  // Refresh goal data after attachment
                  const [updatedTotalValue, updatedPercentBps] = await goalManager.getGoalProgressFull(attachmentGoalId);
                  const updatedAttachmentCount = await goalManager.attachmentCount(attachmentGoalId);
                  
                  // Update the goal in our response
                  const goalIndex = goals.findIndex(g => g.goalId === attachmentGoalId.toString());
                  if (goalIndex !== -1) {
                    goals[goalIndex].totalValueWei = updatedTotalValue.toString();
                    goals[goalIndex].totalValueUSD = formatAmountForDisplay(
                      updatedTotalValue.toString(),
                      vaultConfig.decimals
                    );
                    goals[goalIndex].percentBps = updatedPercentBps.toString();
                    goals[goalIndex].progressPercent = (Number(updatedPercentBps) / 100).toFixed(2);
                    goals[goalIndex].attachmentCount = updatedAttachmentCount.toString();
                  }
                } catch (attachError) {
                  console.error(`Error attaching deposits to goal ${attachmentGoalId}:`, attachError instanceof Error ? attachError.message : attachError);
                  // Continue to show deposits even if attachment fails
                }
              } else {
                console.warn('BACKEND_PRIVATE_KEY not set, cannot auto-attach deposits');
              }
            } catch (error) {
              console.error(`Error in attachment process:`, error);
            }
          }
        }
        
        // Add all user deposits to response (both attached and unattached) - parallel processing
        const depositPromises = Array.from({ length: Number(depositCount) }, (_, i) => 
          vault.deposits(userAddress, i).catch(() => null)
        );
        const depositResults = await Promise.all(depositPromises);
        
        depositResults.forEach((deposit, i) => {
          if (!deposit) return;
          try {
            const currentTime = Math.floor(Date.now() / 1000);
            const timeRemaining = Number(deposit.lockEnd) > currentTime ? 
              Number(deposit.lockEnd) - currentTime : null;

            const userDeposit: UserDeposit = {
              depositId: i.toString(),
              vault: vaultConfig.address,
              asset: assetName,
              amountWei: deposit.principal.toString(),
              amountUSD: formatAmountForDisplay(
                deposit.principal.toString(),
                vaultConfig.decimals
              ),
              sharesWei: deposit.shares.toString(),
              sharesUSD: formatAmountForDisplay(
                deposit.shares.toString(),
                vaultConfig.decimals
              ),
              lockTier: "0",
              lockedUntil: deposit.lockEnd.toString(),
              unlocked: Number(deposit.lockEnd) <= currentTime,
              timeRemaining,
            };

            vaultDeposits.push(userDeposit);
            vaultAssetBalance.totalAmountWei = (BigInt(vaultAssetBalance.totalAmountWei) + BigInt(deposit.principal)).toString();
            vaultAssetBalance.totalSharesWei = (BigInt(vaultAssetBalance.totalSharesWei) + BigInt(deposit.shares)).toString();
            vaultAssetBalance.depositCount++;
          } catch (error) {
            console.error(`Error processing deposit ${i}:`, error);
          }
        });
      } catch (error) {
        console.error(`Error processing deposits in ${assetName} vault:`, error);
      }
      
      return { assetName, deposits: vaultDeposits || [], goals: vaultGoals, assetBalance: vaultAssetBalance };
    });
    
    // Wait for all vault processing to complete
    const vaultResults = await Promise.all(vaultPromises);
    
    // Aggregate results
    vaultResults.forEach(({ assetName, deposits: resultDeposits, goals: resultGoals, assetBalance }) => {
      deposits.push(...(resultDeposits || []));
      goals.push(...(resultGoals || []));
      if (assetBalance && assetBalance.depositCount > 0) {
        assetBalances[assetName] = assetBalance;
      }
    });

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

    // Calculate total value from deposits and asset balances
    const depositTotalUSD = deposits.reduce((sum, deposit) => {
      return sum + parseFloat(deposit.amountUSD);
    }, 0);
    
    const goalTotalUSD = goals.reduce((sum, goal) => {
      return sum + parseFloat(goal.totalValueUSD);
    }, 0);
    
    // Use the higher of deposit total or goal total (to avoid double counting)
    const totalValueUSD = Math.max(depositTotalUSD, goalTotalUSD).toFixed(2);

    // Calculate user balance for each goal
    goals.forEach(goal => {
      let userBalance = BigInt(0);
      deposits.forEach(deposit => {
        if (deposit.vault === goal.vault) {
          userBalance += BigInt(deposit.amountWei);
        }
      });
      goal.userBalance = userBalance.toString();
      const vaultConfig = VAULTS[goal.asset as keyof typeof VAULTS];
      goal.userBalanceUSD = formatAmountForDisplay(userBalance.toString(), vaultConfig.decimals);
    });

    const response: ConsolidatedUserResponse = {
      userAddress,
      totalValueUSD,
      leaderboardScore: score.toString(),
      formattedLeaderboardScore: formatAmountForDisplay(score.toString(), 6, 2), // Default USDC decimals
      leaderboardRank: rank,
      assetBalances: Object.values(assetBalances),
      deposits,
      goals,
      ...(leaderboardData && { leaderboardData }),
      ...(goalDetails && { goalDetails }),
      ...(quicksaveGoalId && { quicksaveGoalId }),
    };

    // console.log('📤 Consolidated user response data:', JSON.stringify(response, null, 2));
    return NextResponse.json(response);
  } catch (error) {
    console.error('❌ Consolidated user API error:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      url: request.url
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<unknown | ErrorResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    
    if (action === "create-goal") {
      return await handleCreateGoal(request);
    } else if (action === "join-goal") {
      return await handleJoinGoal(request);
    } else if (action === "allocate") {
      return await handleAllocate(request);
    }
    
    return NextResponse.json(
      { error: "Invalid action. Supported actions: create-goal, join-goal, allocate" },
      { status: 400 }
    );
  } catch (error) {
    console.error('❌ POST method error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

async function handleCreateGoal(request: NextRequest) {
  const { createBackendWallet, findEventInLogs } = await import("../../../lib/utils");
  const body = await request.json();
  const { vaultAddress, targetAmount, targetDate, name, creatorAddress } = body;

  // Validate required fields
  if (!vaultAddress || !targetAmount || !name || !creatorAddress) {
    return NextResponse.json(
      { error: "Missing required fields: vaultAddress, targetAmount, name, creatorAddress" },
      { status: 400 }
    );
  }

  // Validate addresses
  if (!isValidAddress(vaultAddress)) {
    return NextResponse.json(
      { error: "Invalid vaultAddress" },
      { status: 400 }
    );
  }

  if (!isValidAddress(creatorAddress)) {
    return NextResponse.json(
      { error: "Invalid creatorAddress" },
      { status: 400 }
    );
  }

  // Validate target amount
  if (!/^\d+$/.test(targetAmount) || targetAmount === "0") {
    return NextResponse.json(
      { error: "Invalid targetAmount. Must be a positive integer." },
      { status: 400 }
    );
  }

  // Validate target date if provided
  let parsedTargetDate = 0;
  if (targetDate) {
    parsedTargetDate = parseInt(targetDate, 10);
    if (isNaN(parsedTargetDate) || parsedTargetDate < 0) {
      return NextResponse.json(
        { error: "Invalid targetDate. Must be a positive timestamp or 0." },
        { status: 400 }
      );
    }
  }

  // Validate goal name
  if (name.trim().length === 0) {
    return NextResponse.json(
      { error: "Goal name cannot be empty" },
      { status: 400 }
    );
  }

  if (name.length > 100) {
    return NextResponse.json(
      { error: "Goal name cannot exceed 100 characters" },
      { status: 400 }
    );
  }

  const provider = createProvider();
  const backendWallet = createBackendWallet(provider);
  const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, backendWallet);
  
  const tx = await goalManager.createGoalFor(
    creatorAddress,
    vaultAddress,
    targetAmount,
    parsedTargetDate,
    name.trim()
  );
  const receipt = await tx.wait();

  const goalEvent = findEventInLogs(receipt.logs, goalManager, "GoalCreated");
  if (!goalEvent) {
    return NextResponse.json(
      { error: "Failed to parse goal creation event" },
      { status: 500 }
    );
  }

  const goalId = goalEvent.args.goalId.toString();
  const shareLink = `${process.env.NEXT_PUBLIC_APP_URL || "https://app.example.com"}/goals/${goalId}`;

  return NextResponse.json({
    success: true,
    goalId,
    creator: creatorAddress,
    txHash: tx.hash,
    shareLink,
  });
}

async function handleJoinGoal(request: NextRequest) {
  const { createBackendWallet, waitForTransactionReceipt, findEventInLogs } = await import("../../../lib/utils");
  const body = await request.json();
  const { goalId, userAddress, depositTxHash, asset } = body;

  if (!goalId || !userAddress || !depositTxHash || !asset) {
    return NextResponse.json(
      { error: "Missing required fields: goalId, userAddress, depositTxHash, asset" },
      { status: 400 }
    );
  }

  const vaultConfig = VAULTS[asset as keyof typeof VAULTS];
  if (!vaultConfig) {
    return NextResponse.json(
      { error: `Invalid asset. Supported assets: ${Object.keys(VAULTS).join(", ")}` },
      { status: 400 }
    );
  }

  const provider = createProvider();
  const backendWallet = createBackendWallet(provider);
  
  const receipt = await waitForTransactionReceipt(provider, depositTxHash);
  if (!receipt || !receipt.status) {
    return NextResponse.json(
      { error: "Deposit transaction not found or failed" },
      { status: 400 }
    );
  }

  const vault = new ethers.Contract(vaultConfig.address, VAULT_ABI, provider);
  const depositEvent = findEventInLogs(receipt.logs, vault, "Deposited");
  
  if (!depositEvent || depositEvent.args.user.toLowerCase() !== userAddress.toLowerCase()) {
    return NextResponse.json(
      { error: "Invalid deposit transaction" },
      { status: 400 }
    );
  }

  const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, backendWallet);
  const leaderboardContract = new ethers.Contract(CONTRACTS.LEADERBOARD, LEADERBOARD_ABI, backendWallet);
  
  const attachTx = await goalManager.attachDepositsOnBehalf(
    goalId,
    userAddress,
    [depositEvent.args.depositId.toString()]
  );
  await attachTx.wait();

  const scoreTx = await leaderboardContract.recordDepositOnBehalf(
    userAddress,
    depositEvent.args.amount.toString()
  );
  await scoreTx.wait();

  return NextResponse.json({
    success: true,
    goalId,
    depositId: depositEvent.args.depositId.toString(),
    amount: depositEvent.args.amount.toString(),
    formattedAmount: formatAmountForDisplay(depositEvent.args.amount.toString(), vaultConfig.decimals, 4),
    attachTxHash: attachTx.hash,
  });
}

async function handleAllocate(request: NextRequest) {
  const { createBackendWallet, waitForTransactionReceipt, findEventInLogs } = await import("../../../lib/utils");
  const body = await request.json();
  const { asset, userAddress, amount, txHash, targetGoalId } = body;

  if (!asset || !userAddress || !amount || !txHash) {
    return NextResponse.json(
      { error: "Missing required fields: asset, userAddress, amount, txHash" },
      { status: 400 }
    );
  }

  const vaultConfig = VAULTS[asset as keyof typeof VAULTS];
  if (!vaultConfig) {
    return NextResponse.json(
      { error: `Invalid asset. Supported assets: ${Object.keys(VAULTS).join(", ")}` },
      { status: 400 }
    );
  }

  const provider = createProvider();
  const backendWallet = createBackendWallet(provider);
  
  const receipt = await waitForTransactionReceipt(provider, txHash);
  if (!receipt || !receipt.status) {
    return NextResponse.json(
      { error: "Transaction not found or failed" },
      { status: 400 }
    );
  }

  const vault = new ethers.Contract(vaultConfig.address, VAULT_ABI, backendWallet);
  const depositEvent = findEventInLogs(receipt.logs, vault, "Deposited");
  
  if (!depositEvent) {
    return NextResponse.json(
      { error: "Failed to parse deposit event" },
      { status: 500 }
    );
  }

  const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, provider);
  const goalManagerWrite = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, backendWallet);
  const leaderboardContract = new ethers.Contract(CONTRACTS.LEADERBOARD, LEADERBOARD_ABI, backendWallet);
  
  let attachedGoalId = BigInt(0);
  
  if (targetGoalId) {
    attachedGoalId = BigInt(targetGoalId);
  } else {
    attachedGoalId = await goalManager.getQuicksaveGoal(vaultConfig.address, userAddress);
    
    if (attachedGoalId.toString() === "0") {
      const createTx = await goalManagerWrite.createQuicksaveGoalFor(userAddress, vaultConfig.address);
      const createReceipt = await createTx.wait();
      const goalEvent = findEventInLogs(createReceipt.logs, goalManagerWrite, "GoalCreated");
      if (goalEvent) {
        attachedGoalId = goalEvent.args.goalId;
      }
    }
  }

  if (attachedGoalId !== BigInt(0)) {
    try {
      const attachTx = await goalManagerWrite.attachDepositsOnBehalf(
        attachedGoalId,
        userAddress,
        [depositEvent.args.depositId.toString()]
      );
      await attachTx.wait();
    } catch (error) {
      console.log("Attachment failed:", error instanceof Error ? error.message : String(error));
    }
  }

  const scoreTx = await leaderboardContract.recordDepositOnBehalf(userAddress, amount);
  await scoreTx.wait();

  return NextResponse.json({
    success: true,
    depositId: depositEvent.args.depositId.toString(),
    goalId: attachedGoalId.toString(),
    shares: depositEvent.args.shares.toString(),
    formattedShares: formatAmountForDisplay(depositEvent.args.shares.toString(), vaultConfig.decimals, 4),
    allocationTxHash: txHash,
  });
}