import { NextRequest, NextResponse } from "next/server";
import { getMetaGoalsCollection } from "../../../../lib/database";
import { isValidAddress } from "../../../../lib/utils";
import type { ErrorResponse } from "../../../../lib/types";

export async function POST(
  request: NextRequest
): Promise<NextResponse<{ success: boolean } | ErrorResponse>> {
  try {
    const { metaGoalId, invitedAddress, inviterAddress } = await request.json();

    if (!metaGoalId || !invitedAddress || !inviterAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (!isValidAddress(invitedAddress) || !isValidAddress(inviterAddress)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }

    const collection = await getMetaGoalsCollection();
    const metaGoal = await collection.findOne({ metaGoalId });

    if (!metaGoal) {
      return NextResponse.json({ error: "Goal not found" }, { status: 404 });
    }

    if (metaGoal.creatorAddress.toLowerCase() !== inviterAddress.toLowerCase()) {
      return NextResponse.json({ error: "Only creator can invite users" }, { status: 403 });
    }

    const normalizedInvited = invitedAddress.toLowerCase();
    const invitedUsers = metaGoal.invitedUsers || [];

    if (invitedUsers.includes(normalizedInvited)) {
      return NextResponse.json({ success: true });
    }

    await collection.updateOne(
      { metaGoalId },
      {
        $addToSet: { invitedUsers: normalizedInvited },
        $set: { updatedAt: new Date().toISOString() },
      }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Invite user error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
