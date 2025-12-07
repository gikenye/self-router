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
  createBackendWallet,
  waitForTransactionReceipt,
  findEventInLogs,
  isValidAddress,
  formatAmountForDisplay,
} from "../../../lib/utils";
import type {
  AllocateRequest,
  AllocateResponse,
  ErrorResponse,
  VaultAsset,
} from "../../../lib/types";
import { getMetaGoalsCollection } from "../../../lib/database";

export async function POST(
  request: NextRequest
): Promise<NextResponse<AllocateResponse | ErrorResponse>> {
  try {
    console.log('💰 Allocate API called');
    console.log('🌐 Request details:', {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      timestamp: new Date().toISOString()
    });
    const body: AllocateRequest & { metaGoalId?: string; tokenSymbol?: string } = await request.json();
    console.log('📊 RAW Allocate request body:', JSON.stringify(body, null, 2));
    const { asset, tokenSymbol, userAddress, amount, txHash, targetGoalId, metaGoalId } = body;
    // Handle both asset and tokenSymbol for backward compatibility
    const finalAsset = asset || tokenSymbol;
    console.log('🔍 Extracted fields:', {
      asset,
      tokenSymbol,
      finalAsset,
      userAddress,
      amount,
      txHash,
      targetGoalId,
      targetGoalIdType: typeof targetGoalId,
      targetGoalIdValue: targetGoalId
    });

    // Validate required fields
    if (!finalAsset || !userAddress || !amount || !txHash) {
      console.error('❌ Missing required fields:', { finalAsset, userAddress, amount, txHash });
      return NextResponse.json(
        {
          error: "Missing required fields: asset/tokenSymbol, userAddress, amount, txHash",
        },
        { status: 400 }
      );
    }

    // Validate user address
    if (!isValidAddress(userAddress)) {
      console.error('❌ Invalid userAddress:', userAddress);
      return NextResponse.json(
        { error: "Invalid userAddress" },
        { status: 400 }
      );
    }
    
    console.log('✅ Processing allocation for:', { finalAsset, userAddress, amount, targetGoalId });

    // Validate asset
    const vaultConfig = VAULTS[finalAsset];
    if (!vaultConfig) {
      return NextResponse.json(
        {
          error: `Invalid asset. Supported assets: ${Object.keys(VAULTS).join(", ")}`,
        },
        { status: 400 }
      );
    }

    // Initialize provider and wallet
    const provider = createProvider();
    const backendWallet = createBackendWallet(provider);

    // Wait for transaction receipt
    const receipt = await waitForTransactionReceipt(provider, txHash);
    console.log("Transaction receipt:", receipt);
    if (!receipt || !receipt.status) {
      return NextResponse.json(
        { error: "Transaction not found or failed" },
        { status: 400 }
      );
    }

    // Verify transfer to vault
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    console.log("Looking for transfer topic:", transferTopic);
    console.log("Vault config:", vaultConfig);
    const vaultTransfer = receipt.logs.find((log: ethers.Log) => {
      console.log("Checking log:", log.address, log.topics[0]);
      if (log.topics[0] !== transferTopic) return false;
      if (log.address.toLowerCase() !== vaultConfig.asset.toLowerCase())
        return false;
      const to = ethers.getAddress("0x" + log.topics[2].slice(26));
      console.log("Parsed to address:", to);
      return to.toLowerCase() === vaultConfig.address.toLowerCase();
    });
    console.log("Vault transfer found:", !!vaultTransfer);

    if (!vaultTransfer) {
      return NextResponse.json(
        { error: "No transfer to vault found in transaction" },
        { status: 400 }
      );
    }

    // Parse deposit event from the original transaction
    const vault = new ethers.Contract(
      vaultConfig.address,
      VAULT_ABI,
      backendWallet
    );
    const depositEvent = findEventInLogs(receipt.logs, vault, "Deposited");
    if (!depositEvent) {
      return NextResponse.json(
        { error: "Failed to parse deposit event" },
        { status: 500 }
      );
    }

    const depositId = depositEvent.args.depositId.toString();
    const shares = depositEvent.args.shares.toString();

    // Handle goal attachment
    let attachedGoalId: bigint = BigInt(0);
    try {
      const goalManagerRead = new ethers.Contract(
        CONTRACTS.GOAL_MANAGER,
        GOAL_MANAGER_ABI,
        provider
      );
      const goalManagerWrite = new ethers.Contract(
        CONTRACTS.GOAL_MANAGER,
        GOAL_MANAGER_ABI,
        backendWallet
      );

      // Use target goal if specified, otherwise default to quicksave
      console.log('🎯 Goal selection logic:', {
        hasTargetGoalId: !!targetGoalId,
        hasMetaGoalId: !!metaGoalId,
        targetGoalIdValue: targetGoalId,
        targetGoalIdType: typeof targetGoalId,
        willUseTargetGoal: !!targetGoalId || !!metaGoalId
      });
      
      // Handle meta-goal routing first
      if (metaGoalId && !targetGoalId) {
        try {
          const collection = await getMetaGoalsCollection();
          const metaGoal = await collection.findOne({ metaGoalId });
          
          if (metaGoal) {
            const onChainGoalId = metaGoal.onChainGoals[finalAsset as VaultAsset];
            if (onChainGoalId) {
              console.log(`🎯 Meta-goal ${metaGoalId} resolved to on-chain goal ${onChainGoalId} for ${finalAsset}`);
              // Validate the resolved goal exists and matches vault
              const resolvedGoal = await goalManagerRead.goals(onChainGoalId);
              if (resolvedGoal.id.toString() !== "0" && 
                  resolvedGoal.vault.toLowerCase() === vaultConfig.address.toLowerCase()) {
                attachedGoalId = BigInt(onChainGoalId);
                console.log(`✅ Using meta-goal resolved target: ${onChainGoalId}`);
              } else {
                console.log(`❌ Meta-goal resolved goal ${onChainGoalId} invalid, falling back to quicksave`);
              }
            } else {
              console.log(`❌ Meta-goal ${metaGoalId} has no on-chain goal for ${finalAsset}, falling back to quicksave`);
            }
          } else {
            console.log(`❌ Meta-goal ${metaGoalId} not found, falling back to quicksave`);
          }
        } catch (error) {
          console.log(`❌ Error resolving meta-goal ${metaGoalId}:`, error instanceof Error ? error.message : String(error));
        }
      }
      
      if (targetGoalId && attachedGoalId === BigInt(0)) {
        // Validate that target goal exists and matches the current vault
        try {
          const targetGoal = await goalManagerRead.goals(targetGoalId);
          if (targetGoal.id.toString() === "0") {
            console.log(`❌ Target goal ${targetGoalId} does not exist, falling back to quicksave`);
          } else if (targetGoal.vault.toLowerCase() !== vaultConfig.address.toLowerCase()) {
            console.log(`❌ Target goal ${targetGoalId} vault mismatch: expected ${vaultConfig.address}, got ${targetGoal.vault}. Falling back to quicksave`);
          } else {
            attachedGoalId = BigInt(targetGoalId);
            console.log(`✅ Using target goal: ${targetGoalId} (converted to BigInt: ${attachedGoalId})`);
          }
        } catch (error) {
          console.log(`❌ Error validating target goal ${targetGoalId}:`, error instanceof Error ? error.message : String(error));
        }
      }
      
      if (attachedGoalId === BigInt(0)) {
        // Check if user has existing goals in other vaults that could be expanded
        try {
          const collection = await getMetaGoalsCollection();
          const userMetaGoals = await collection.find({ creatorAddress: userAddress }).toArray();
          if (userMetaGoals.length > 0) {
            // Find a meta-goal that doesn't have this asset yet
            const expandableGoal = userMetaGoals.find((mg: { onChainGoals: Record<string, string> }) => !mg.onChainGoals[finalAsset as VaultAsset]);
            if (expandableGoal) {
              // Auto-expand the goal to include this asset
              const targetAmountWei = ethers.parseUnits(expandableGoal.targetAmountUSD.toString(), vaultConfig.decimals);
              const { getContractCompliantTargetDate } = await import("../../../lib/goal-duration-calculator");
              const parsedTargetDate = getContractCompliantTargetDate();
              
              const createTx = await goalManagerWrite.createGoalFor(
                userAddress,
                vaultConfig.address,
                targetAmountWei,
                parsedTargetDate,
                expandableGoal.name
              );
              
              const createReceipt = await createTx.wait();
              const goalEvent = findEventInLogs(createReceipt.logs, goalManagerWrite, "GoalCreated");
              
              if (goalEvent) {
                attachedGoalId = goalEvent.args.goalId;
                // Update meta-goal in database
                expandableGoal.onChainGoals[finalAsset as VaultAsset] = attachedGoalId.toString();
                await collection.updateOne(
                  { metaGoalId: expandableGoal.metaGoalId },
                  { $set: { onChainGoals: expandableGoal.onChainGoals, updatedAt: new Date().toISOString() } }
                );
                console.log(`✅ Auto-expanded meta-goal ${expandableGoal.metaGoalId} to include ${finalAsset}`);
              }
            }
          }
        } catch (error) {
          console.log('Auto-expansion failed, falling back to quicksave:', error);
        }
        
        if (attachedGoalId === BigInt(0)) {
          // Get quicksave goal directly from contract
          attachedGoalId = await goalManagerRead.getQuicksaveGoal(
            vaultConfig.address,
            userAddress
          );

          if (attachedGoalId.toString() === "0") {
            // Create quicksave goal
            const createTx = await goalManagerWrite.createQuicksaveGoalFor(
              userAddress,
              vaultConfig.address
            );
            const createReceipt = await createTx.wait();

            const goalEvent = findEventInLogs(
              createReceipt.logs,
              goalManagerWrite,
              "GoalCreated"
            );
            if (goalEvent) {
              attachedGoalId = goalEvent.args.goalId;
            }
          }
          console.log(`✅ Using quicksave goal: ${attachedGoalId}`);
        }
      }
      
      console.log('🔗 Final goal attachment decision:', {
        selectedGoalId: attachedGoalId.toString(),
        wasTargetGoalProvided: !!targetGoalId,
        originalTargetGoalId: targetGoalId
      });

      if (attachedGoalId !== BigInt(0)) {
        // Verify goal exists before attaching
        try {
          const goal = await goalManagerRead.goals(attachedGoalId);
          if (goal.id.toString() !== "0") {
            // Try to attach deposit
            try {
              const attachTx = await goalManagerWrite.attachDepositsOnBehalf(
                attachedGoalId,
                userAddress,
                [depositId]
              );
              await attachTx.wait();
              console.log(`✅ Successfully attached deposit ${depositId} to goal ${attachedGoalId}`);
              console.log('📋 Attachment summary:', {
                depositId,
                goalId: attachedGoalId.toString(),
                userAddress,
                wasTargetGoal: !!targetGoalId,
                originalTargetGoalId: targetGoalId
              });
            } catch (attachError) {
              const errorMsg = attachError instanceof Error ? attachError.message : String(attachError);
              if (errorMsg.includes("already unlocked") || errorMsg.includes("Not found")) {
                console.log(`Cannot attach deposit ${depositId}: ${errorMsg}`);
              } else {
                throw attachError;
              }
            }
          } else {
            console.log(`Goal ${attachedGoalId} not found, skipping attachment`);
            attachedGoalId = BigInt(0);
          }
        } catch (goalError) {
          console.log(`Goal ${attachedGoalId} validation failed:`, goalError instanceof Error ? goalError.message : String(goalError));
          attachedGoalId = BigInt(0);
        }
      }
    } catch (error) {
      console.log(
        "Failed to handle goal attachment, skipping:",
        error instanceof Error ? error.message : String(error)
      );
      attachedGoalId = BigInt(0);
    }

    // Record score on leaderboard
    const leaderboard = new ethers.Contract(
      CONTRACTS.LEADERBOARD,
      LEADERBOARD_ABI,
      backendWallet
    );
    const scoreTx = await leaderboard.recordDepositOnBehalf(
      userAddress,
      amount
    );
    await scoreTx.wait();

    // Return successful response
    const response = {
      success: true,
      depositId,
      goalId: attachedGoalId.toString(),
      shares,
      formattedShares: formatAmountForDisplay(shares, vaultConfig.decimals, 4),
      allocationTxHash: txHash,
    };
    
    console.log('📤 Allocate response data:', JSON.stringify(response, null, 2));
    return NextResponse.json(response);
  } catch (error) {
    console.error('❌ Allocation error:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      requestBody: request.body
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}

// Handle unsupported methods
export async function GET(): Promise<NextResponse<ErrorResponse>> {
  return NextResponse.json(
    { error: "Method not allowed. Use POST." },
    { status: 405 }
  );
}
