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
} from "../../../lib/types";

export async function POST(
  request: NextRequest
): Promise<NextResponse<AllocateResponse | ErrorResponse>> {
  try {
    const body: AllocateRequest = await request.json();
    console.log("Allocate request body:", body);
    const { asset, userAddress, amount, txHash, targetGoalId } = body;

    // Validate required fields
    if (!asset || !userAddress || !amount || !txHash) {
      return NextResponse.json(
        {
          error: "Missing required fields: asset, userAddress, amount, txHash",
        },
        { status: 400 }
      );
    }

    // Validate user address
    if (!isValidAddress(userAddress)) {
      return NextResponse.json(
        { error: "Invalid userAddress" },
        { status: 400 }
      );
    }

    // Validate asset
    const vaultConfig = VAULTS[asset];
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
      if (targetGoalId) {
        attachedGoalId = BigInt(targetGoalId);
        console.log(`Using target goal: ${targetGoalId}`);
      } else {
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
        console.log(`Using quicksave goal: ${attachedGoalId}`);
      }

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
              console.log(`Successfully attached deposit ${depositId} to goal ${attachedGoalId}`);
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
    return NextResponse.json({
      success: true,
      depositId,
      goalId: attachedGoalId.toString(),
      shares,
      formattedShares: formatAmountForDisplay(shares, vaultConfig.decimals, 4),
      allocationTxHash: txHash,
    });
  } catch (error) {
    console.error("Allocation error:", error);
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
