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
              console.error(`Error processing attachment ${i} for goal ${quicksaveId}:`, error);
            }
          }
        } catch (error) {
          console.error(`Error processing quicksave goal ${quicksaveId}:`, error);
        }
      }

      // Check for unattached deposits and auto-attach them to quicksave goal
      try {
        // Get user's deposit count directly from vault
        const depositCount = await vault.depositCount(userAddress);
        console.log(`User has ${depositCount} deposits in ${assetName} vault`);
        
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
          
          // If we have unattached deposits and a quicksave goal, try to attach them
          if (unattachedDepositIndices.length > 0 && quicksaveId.toString() !== "0") {
            try {
              console.log(`Attempting to attach ${unattachedDepositIndices.length} deposits to goal ${quicksaveId}`);
              
              const privateKey = process.env.BACKEND_PRIVATE_KEY;
              if (privateKey) {
                const signer = new ethers.Wallet(privateKey, provider);
                const goalManagerWithSigner = goalManager.connect(signer);
                
                try {
                  // Try to attach all unattached deposits
                  const tx = await (goalManagerWithSigner as ethers.Contract & { attachDepositsOnBehalf: (goalId: bigint, owner: string, depositIds: number[]) => Promise<ethers.ContractTransactionResponse> }).attachDepositsOnBehalf(
                    quicksaveId,
                    userAddress,
                    unattachedDepositIndices
                  );
                  
                  console.log(`Attachment transaction sent: ${tx.hash}`);
                  await tx.wait();
                  console.log(`Successfully attached ${unattachedDepositIndices.length} deposits to goal ${quicksaveId}`);
                  
                  // Refresh goal data after attachment
                  const [updatedTotalValue, updatedPercentBps] = await goalManager.getGoalProgressFull(quicksaveId);
                  const updatedAttachmentCount = await goalManager.attachmentCount(quicksaveId);
                  
                  // Update the goal in our response
                  const goalIndex = goals.findIndex(g => g.goalId === quicksaveId.toString());
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
                  console.error(`Error attaching deposits to goal ${quicksaveId}:`, attachError instanceof Error ? attachError.message : attachError);
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
        
        // Add all user deposits to response (both attached and unattached)
        for (let i = 0; i < Number(depositCount); i++) {
          try {
            const deposit = await vault.deposits(userAddress, i);
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
              lockTier: "0", // Not available in this contract version
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
          } catch (error) {
            console.error(`Error processing deposit ${i}:`, error);
          }
        }
      } catch (error) {
        console.error(`Error processing deposits in ${assetName} vault:`, error);
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

    // Calculate total value from deposits and asset balances
    const depositTotalUSD = deposits.reduce((sum, deposit) => {
      return sum + parseFloat(deposit.amountUSD);
    }, 0);
    
    const goalTotalUSD = goals.reduce((sum, goal) => {
      return sum + parseFloat(goal.totalValueUSD);
    }, 0);
    
    // Use the higher of deposit total or goal total (to avoid double counting)
    const totalValueUSD = Math.max(depositTotalUSD, goalTotalUSD).toFixed(2);

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