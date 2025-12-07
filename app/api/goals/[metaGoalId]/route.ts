import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { VAULTS, CONTRACTS, GOAL_MANAGER_ABI } from "../../../../lib/constants";
import { createProvider, formatAmountForDisplay } from "../../../../lib/utils";
import { getMetaGoalsCollection } from "../../../../lib/database";
import type { ErrorResponse, VaultAsset } from "../../../../lib/types";

interface MetaGoalProgress {
  metaGoalId: string;
  name: string;
  targetAmountUSD: number;
  targetDate: string;
  creatorAddress: string;
  totalProgressUSD: number;
  progressPercent: number;
  vaultProgress: Record<VaultAsset, {
    goalId: string;
    progressUSD: number;
    progressPercent: number;
    attachmentCount: number;
  }>;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { metaGoalId: string } }
): Promise<NextResponse<MetaGoalProgress | ErrorResponse>> {
  try {
    const { metaGoalId } = params;

    const collection = await getMetaGoalsCollection();
    const metaGoal = await collection.findOne({ metaGoalId });

    if (!metaGoal) {
      return NextResponse.json({ error: "Meta-goal not found" }, { status: 404 });
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

    // Get progress for each vault's on-chain goal
    for (const [asset, goalId] of Object.entries(metaGoal.onChainGoals)) {
      try {
        const [totalValue] = await goalManager.getGoalProgressFull(goalId);
        const attachmentCount = await goalManager.attachmentCount(goalId);
        const vaultConfig = VAULTS[asset as VaultAsset];
        
        const progressUSD = parseFloat(formatAmountForDisplay(totalValue.toString(), vaultConfig.decimals));
        totalProgressUSD += progressUSD;

        vaultProgress[asset as VaultAsset] = {
          goalId,
          progressUSD,
          progressPercent: metaGoal.targetAmountUSD > 0 ? (progressUSD / metaGoal.targetAmountUSD) * 100 : 0,
          attachmentCount: Number(attachmentCount),
        };
      } catch (error) {
        console.error(`Error getting progress for goal ${goalId}:`, error);
        vaultProgress[asset as VaultAsset] = {
          goalId,
          progressUSD: 0,
          progressPercent: 0,
          attachmentCount: 0,
        };
      }
    }

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