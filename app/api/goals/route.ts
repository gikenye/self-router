import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { CONTRACTS, GOAL_MANAGER_ABI } from "../../../lib/constants";
import { createProvider, isValidAddress } from "../../../lib/utils";
import type {
  Goal,
  QuicksaveGoalResponse,
  ErrorResponse,
  GoalAttachment,
} from "../../../lib/types";

export async function GET(
  request: NextRequest
): Promise<NextResponse<Goal | QuicksaveGoalResponse | ErrorResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const goalId = searchParams.get("goalId");
    const userAddress = searchParams.get("userAddress");
    const vaultAddress = searchParams.get("vaultAddress");

    const provider = createProvider();
    const goalManager = new ethers.Contract(
      CONTRACTS.GOAL_MANAGER,
      GOAL_MANAGER_ABI,
      provider
    );

    // Handle quicksave goal query
    if (userAddress && vaultAddress) {
      if (!isValidAddress(userAddress)) {
        return NextResponse.json(
          { error: "Invalid userAddress" },
          { status: 400 }
        );
      }

      if (!isValidAddress(vaultAddress)) {
        return NextResponse.json(
          { error: "Invalid vaultAddress" },
          { status: 400 }
        );
      }

      const quicksaveId = await goalManager.getQuicksaveGoal(
        vaultAddress,
        userAddress
      );
      return NextResponse.json({
        quicksaveGoalId: quicksaveId.toString(),
      });
    }

    // Handle specific goal query
    if (!goalId) {
      return NextResponse.json(
        {
          error:
            "Missing required parameter: goalId or (userAddress + vaultAddress)",
        },
        { status: 400 }
      );
    }

    // Validate goalId is a number
    if (!/^\d+$/.test(goalId)) {
      return NextResponse.json(
        { error: "Invalid goalId format. Must be a positive integer." },
        { status: 400 }
      );
    }

    // Fetch goal details
    const goal = await goalManager.goals(goalId);
    const [totalValue, percentBps] =
      await goalManager.getGoalProgressFull(goalId);
    const attachmentCount = await goalManager.attachmentCount(goalId);

    // Fetch attachments (limit to 100 for performance)
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

    const response: Goal = {
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

    return NextResponse.json(response);
  } catch (error) {
    console.error("Goals API error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}

// Handle unsupported methods
export async function POST(): Promise<NextResponse<ErrorResponse>> {
  return NextResponse.json(
    { error: "Method not allowed. Use GET." },
    { status: 405 }
  );
}
