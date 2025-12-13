import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { VAULTS, CONTRACTS, GOAL_MANAGER_ABI } from "../../../../lib/constants";
import { createProvider, formatAmountForDisplay } from "../../../../lib/utils";
import { getMetaGoalsCollection } from "../../../../lib/database";
import { GoalSyncService } from "../../../../lib/services/goal-sync.service";
import type { ErrorResponse, VaultAsset, MetaGoalWithProgress } from "../../../../lib/types";

export async function GET(
  request: NextRequest,
  { params }: { params: { metaGoalId: string } }
): Promise<NextResponse<Partial<MetaGoalWithProgress> | ErrorResponse>> {
  try {
    const { metaGoalId } = params;

    if (!metaGoalId || typeof metaGoalId !== 'string' || metaGoalId.length > 100) {
      return NextResponse.json({ error: "Invalid metaGoalId" }, { status: 400 });
    }

    const collection = await getMetaGoalsCollection();
    let metaGoal = await collection.findOne({ metaGoalId });

    if (!metaGoal) {
      // Try to find by on-chain goal ID (if metaGoalId is actually a goalId)
      const syncService = new GoalSyncService();
      const result = await syncService.getGoalWithFallback(metaGoalId);
      metaGoal = result.metaGoal;
      
      if (!metaGoal) {
        return NextResponse.json({ error: "Meta-goal not found" }, { status: 404 });
      }
    }

    const provider = createProvider();
    const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, provider);

    let totalProgressUSD = 0;
    const vaultProgress: Record<VaultAsset, {
      goalId: string;
      progressUSD: number;
      progressPercent: number;
      attachmentCount: number;
    }> = {} as Record<VaultAsset, {
      goalId: string;
      progressUSD: number;
      progressPercent: number;
      attachmentCount: number;
    }>;

    const progressPromises = Object.entries(metaGoal.onChainGoals).map(
      async ([asset, goalId]) => {
        try {
          const [totalValue] = await goalManager.getGoalProgressFull(goalId);
          const attachmentCount = await goalManager.attachmentCount(goalId);
          const vaultConfig = VAULTS[asset as VaultAsset];
          const progressUSD = parseFloat(formatAmountForDisplay(totalValue.toString(), vaultConfig.decimals));
          return { asset, goalId, progressUSD, attachmentCount: Number(attachmentCount) };
        } catch (error) {
          console.error(`Error getting progress for goal ${goalId}:`, error);
          return { asset, goalId, progressUSD: 0, attachmentCount: 0 };
        }
      }
    );

    const results = await Promise.all(progressPromises);
    results.forEach(({ asset, goalId, progressUSD, attachmentCount }) => {
      totalProgressUSD += progressUSD;
      vaultProgress[asset as VaultAsset] = {
        goalId,
        progressUSD,
        progressPercent: metaGoal.targetAmountUSD > 0 ? (progressUSD / metaGoal.targetAmountUSD) * 100 : 0,
        attachmentCount,
      };
    });

    const overallProgressPercent = metaGoal.targetAmountUSD > 0 ? 
      (totalProgressUSD / metaGoal.targetAmountUSD) * 100 : 0;

    return NextResponse.json({
      metaGoalId,
      name: metaGoal.name,
      targetAmountUSD: metaGoal.targetAmountUSD,
      targetDate: metaGoal.targetDate,
      creatorAddress: metaGoal.creatorAddress,
      totalProgressUSD,
      progressPercent: Math.min(overallProgressPercent, 100),
      vaultProgress,
    });
  } catch (error) {
    console.error("Get meta-goal progress error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}