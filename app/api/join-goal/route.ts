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
  JoinGoalRequest,
  JoinGoalResponse,
  ErrorResponse,
} from "../../../lib/types";

export async function POST(
  request: NextRequest
): Promise<NextResponse<JoinGoalResponse | ErrorResponse>> {
  try {
    const body: JoinGoalRequest = await request.json();
    const { goalId, userAddress, depositTxHash, asset } = body;

    // Validate required fields
    if (!goalId || !userAddress || !depositTxHash || !asset) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: goalId, userAddress, depositTxHash, asset",
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

    // Validate goal ID format
    if (!/^\d+$/.test(goalId)) {
      return NextResponse.json(
        { error: "Invalid goalId format. Must be a positive integer." },
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

    // Wait for deposit transaction receipt
    const receipt = await waitForTransactionReceipt(provider, depositTxHash);
    if (!receipt || !receipt.status) {
      return NextResponse.json(
        { error: "Deposit transaction not found or failed" },
        { status: 400 }
      );
    }

    // Parse deposit event from transaction
    const vault = new ethers.Contract(vaultConfig.address, VAULT_ABI, provider);
    const depositEvent = findEventInLogs(receipt.logs, vault, "Deposited");

    if (!depositEvent) {
      return NextResponse.json(
        { error: "Deposit event not found in transaction" },
        { status: 400 }
      );
    }

    const depositId = depositEvent.args.depositId.toString();
    const amount = depositEvent.args.amount.toString();

    // Verify the deposit belongs to the user
    const depositUser = depositEvent.args.user;
    if (depositUser.toLowerCase() !== userAddress.toLowerCase()) {
      return NextResponse.json(
        { error: "Deposit does not belong to the specified user" },
        { status: 400 }
      );
    }

    // Attach deposit to goal on behalf of user
    const goalManager = new ethers.Contract(
      CONTRACTS.GOAL_MANAGER,
      GOAL_MANAGER_ABI,
      backendWallet
    );
    const attachTx = await goalManager.attachDepositsOnBehalf(
      goalId,
      userAddress,
      [depositId]
    );
    await attachTx.wait();

    // Record deposit on leaderboard
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
      goalId,
      depositId,
      amount,
      formattedAmount: formatAmountForDisplay(amount, vaultConfig.decimals, 4),
      attachTxHash: attachTx.hash,
    });
  } catch (error) {
    console.error("Join goal error:", error);
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
