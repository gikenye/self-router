import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { CONTRACTS, GOAL_MANAGER_ABI } from "../../../lib/constants";
import {
  createProvider,
  createBackendWallet,
  findEventInLogs,
  isValidAddress,
} from "../../../lib/utils";
import type {
  CreateGoalRequest,
  CreateGoalResponse,
  ErrorResponse,
} from "../../../lib/types";

export async function POST(
  request: NextRequest
): Promise<NextResponse<CreateGoalResponse | ErrorResponse>> {
  try {
    const body: CreateGoalRequest = await request.json();
    const { vaultAddress, targetAmount, targetDate, name, creatorAddress } =
      body;

    // Validate required fields
    if (!vaultAddress || !targetAmount || !name || !creatorAddress) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: vaultAddress, targetAmount, name, creatorAddress",
        },
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

    // Initialize provider and wallet
    const provider = createProvider();
    const backendWallet = createBackendWallet(provider);

    // Create goal with specified creator using createGoalFor
    const goalManager = new ethers.Contract(
      CONTRACTS.GOAL_MANAGER,
      GOAL_MANAGER_ABI,
      backendWallet
    );
    const tx = await goalManager.createGoalFor(
      creatorAddress,
      vaultAddress,
      targetAmount,
      parsedTargetDate,
      name.trim()
    );
    const receipt = await tx.wait();

    // Parse goal creation event
    const goalEvent = findEventInLogs(receipt.logs, goalManager, "GoalCreated");
    if (!goalEvent) {
      return NextResponse.json(
        { error: "Failed to parse goal creation event" },
        { status: 500 }
      );
    }

    const goalId = goalEvent.args.goalId.toString();

    // Generate share link (you can customize this URL based on your frontend)
    const shareLink = `${process.env.NEXT_PUBLIC_APP_URL || "https://app.example.com"}/goals/${goalId}`;

    return NextResponse.json({
      success: true,
      goalId,
      creator: creatorAddress,
      txHash: tx.hash,
      shareLink,
    });
  } catch (error) {
    console.error("Create goal error:", error);
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
