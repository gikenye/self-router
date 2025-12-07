import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { CONTRACTS, GOAL_MANAGER_ABI } from "../../../../lib/constants";
import { createProvider } from "../../../../lib/utils";
import { getMetaGoalsCollection } from "../../../../lib/database";
import type { ErrorResponse, MetaGoalWithProgress, VaultAsset } from "../../../../lib/types";

export async function GET(request: NextRequest): Promise<NextResponse<MetaGoalWithProgress[] | ErrorResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "50");
    const skip = parseInt(searchParams.get("skip") || "0");

    const collection = await getMetaGoalsCollection();
    const metaGoals = await collection
      .find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const provider = createProvider();
    const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, provider);

    const goalsWithProgress: MetaGoalWithProgress[] = await Promise.all(
      metaGoals.map(async (metaGoal) => {
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

        let totalProgressUSD = 0;

        const progressPromises = Object.entries(metaGoal.onChainGoals).map(
          async ([asset, goalIdStr]: [string, unknown]) => {
            try {
              const goalId = BigInt(goalIdStr as string);
              const [, percentBps] = await goalManager.getGoalProgressFull(goalId);
              const progressUSD = (Number(percentBps) / 10000) * metaGoal.targetAmountUSD;
              const progressPercent = Number(percentBps) / 100;
              const attachmentCount = Number(await goalManager.attachmentCount(goalId));

              return {
                asset: asset as VaultAsset,
                data: { goalId: goalIdStr as string, progressUSD, progressPercent, attachmentCount },
              };
            } catch {
              return {
                asset: asset as VaultAsset,
                data: { goalId: goalIdStr as string, progressUSD: 0, progressPercent: 0, attachmentCount: 0 },
              };
            }
          }
        );

        const progressResults = await Promise.all(progressPromises);
        
        const participantsSet = new Set<string>();
        
        for (const { asset, data } of progressResults) {
          vaultProgress[asset] = data;
          totalProgressUSD += data.progressUSD;
          
          if (data.attachmentCount > 0) {
            try {
              const goalId = BigInt(data.goalId);
              for (let i = 0; i < data.attachmentCount; i++) {
                const attachment = await goalManager.attachmentAt(goalId, i);
                participantsSet.add(attachment.owner);
              }
            } catch (error) {
              console.error(`Error fetching attachments for goal ${data.goalId}:`, error);
            }
          }
        }

        const progressPercent =
          metaGoal.targetAmountUSD > 0
            ? (totalProgressUSD / metaGoal.targetAmountUSD) * 100
            : 0;

        return {
          ...metaGoal,
          totalProgressUSD,
          progressPercent,
          vaultProgress,
          participants: Array.from(participantsSet),
          userBalance: "0",
          userBalanceUSD: "0.00",
        };
      })
    );

    return NextResponse.json(goalsWithProgress);
  } catch (error) {
    console.error("Get all meta-goals error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
