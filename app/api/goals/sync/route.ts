import { NextRequest, NextResponse } from "next/server";
import { GoalSyncService } from "../../../../lib/services/goal-sync.service";
import { isValidAddress } from "../../../../lib/utils";
import type { ErrorResponse } from "../../../../lib/types";

export async function POST(request: NextRequest): Promise<NextResponse<{ success: boolean; synced: number; goalIds?: string[] } | ErrorResponse>> {
  try {
    const body = await request.json();
    const { userAddress, goalId, fromBlock } = body;

    if (goalId) {
      const syncService = new GoalSyncService();
      const result = await syncService.syncGoalFromChain(goalId);
      
      return NextResponse.json({
        success: !!result,
        synced: result ? 1 : 0
      });
    }

    if (userAddress) {
      if (!isValidAddress(userAddress)) {
        return NextResponse.json({ error: "Invalid user address" }, { status: 400 });
      }

      const syncService = new GoalSyncService();
      const discoveredGoalIds = await syncService.discoverUserGoalsFromEvents(userAddress, fromBlock);
      await syncService.syncUserGoals(userAddress);
      
      return NextResponse.json({ 
        success: true, 
        synced: discoveredGoalIds.length,
        goalIds: discoveredGoalIds
      });
    }

    return NextResponse.json({ error: "Provide goalId or userAddress" }, { status: 400 });
  } catch (error) {
    console.error("Sync error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 }
    );
  }
}
