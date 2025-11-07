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
    const { asset, userAddress, amount, txHash } = body;

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
    if (!receipt || !receipt.status) {
      return NextResponse.json(
        { error: "Transaction not found or failed" },
        { status: 400 }
      );
    }

    // Verify transfer to vault
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const vaultTransfer = receipt.logs.find((log: ethers.Log) => {
      if (log.topics[0] !== transferTopic) return false;
      if (log.address.toLowerCase() !== vaultConfig.asset.toLowerCase())
        return false;
      const to = ethers.getAddress("0x" + log.topics[2].slice(26));
      return to.toLowerCase() === vaultConfig.address.toLowerCase();
    });

    if (!vaultTransfer) {
      return NextResponse.json(
        { error: "No transfer to vault found in transaction" },
        { status: 400 }
      );
    }

    // Allocate deposit in vault
    const vault = new ethers.Contract(
      vaultConfig.address,
      VAULT_ABI,
      backendWallet
    );
    const txHashBytes32 = ethers.keccak256(txHash);

    const allocateTx = await vault.allocateOnrampDeposit(
      userAddress,
      amount,
      txHashBytes32
    );
    const allocateReceipt = await allocateTx.wait();

    // Parse deposit event
    const depositEvent = findEventInLogs(
      allocateReceipt.logs,
      vault,
      "OnrampDeposit"
    );
    if (!depositEvent) {
      return NextResponse.json(
        { error: "Failed to parse deposit event" },
        { status: 500 }
      );
    }

    const depositId = depositEvent.args.depositId.toString();
    const shares = depositEvent.args.shares.toString();

    // Handle quicksave goal
    const goalManager = new ethers.Contract(
      CONTRACTS.GOAL_MANAGER,
      GOAL_MANAGER_ABI,
      backendWallet
    );
    let quicksaveId = await goalManager.getQuicksaveGoal(
      vaultConfig.address,
      userAddress
    );

    if (quicksaveId.toString() === "0") {
      // Create new quicksave goal
      const createTx = await goalManager.createGoal(
        vaultConfig.address,
        0,
        0,
        "quicksave"
      );
      const createReceipt = await createTx.wait();

      const goalEvent = findEventInLogs(
        createReceipt.logs,
        goalManager,
        "GoalCreated"
      );
      if (!goalEvent) {
        return NextResponse.json(
          { error: "Failed to create quicksave goal" },
          { status: 500 }
        );
      }

      quicksaveId = goalEvent.args.goalId;
    }

    // Attach deposit to goal
    const attachTx = await goalManager.attachDeposits(quicksaveId, [depositId]);
    await attachTx.wait();

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
      quicksaveGoalId: quicksaveId.toString(),
      shares,
      formattedShares: formatAmountForDisplay(shares, vaultConfig.decimals, 4),
      allocationTxHash: allocateTx.hash,
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
