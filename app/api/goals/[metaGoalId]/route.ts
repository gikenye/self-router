import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { VAULTS, CONTRACTS, GOAL_MANAGER_ABI } from "../../../../lib/constants";
import { createProvider, formatAmountForDisplay, isValidAddress } from "../../../../lib/utils";
import { getMetaGoalsCollection } from "../../../../lib/database";
import { GoalSyncService } from "../../../../lib/services/goal-sync.service";
import type { ErrorResponse, VaultAsset, MetaGoalWithProgress } from "../../../../lib/types";

export async function GET(
  request: NextRequest,
  { params }: { params: { metaGoalId: string } }
): Promise<NextResponse<Partial<MetaGoalWithProgress> | ErrorResponse>> {
  try {
    const { metaGoalId } = params;
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get("userAddress");
    const invitedBy = searchParams.get("invitedBy");

    if (!metaGoalId || typeof metaGoalId !== 'string' || metaGoalId.length > 100) {
      return NextResponse.json({ error: "Invalid metaGoalId" }, { status: 400 });
    }

    const collection = await getMetaGoalsCollection();
    let metaGoal = await collection.findOne({ metaGoalId });

    if (!metaGoal) {
      // Try to find by on-chain goal ID (if metaGoalId is actually a goalId)
      const syncService = new GoalSyncService();
      const result = await syncService.getGoalWithFallback(metaGoalId);
      
      if (!result.metaGoal) {
        return NextResponse.json({ error: "Meta-goal not found" }, { status: 404 });
      }
      
      metaGoal = await collection.findOne({ metaGoalId: result.metaGoal.metaGoalId });
      if (!metaGoal) {
        return NextResponse.json({ error: "Meta-goal not found" }, { status: 404 });
      }
    }

    // Access control for private goals
    if (metaGoal.isPublic === false) {
      if (!userAddress) {
        return NextResponse.json({ error: "Authentication required for private goals." }, { status: 401 });
      }
      const normalizedUser = userAddress.toLowerCase();
      const isCreator = metaGoal.creatorAddress.toLowerCase() === normalizedUser;
      const isParticipant = metaGoal.participants?.includes(normalizedUser);
      const isInvited = metaGoal.invitedUsers?.includes(normalizedUser);
      
      if (invitedBy && !isInvited && !isCreator && !isParticipant) {
        if (!isValidAddress(invitedBy) || invitedBy.toLowerCase() !== metaGoal.creatorAddress.toLowerCase()) {
          return NextResponse.json({ error: "Invalid invitation" }, { status: 403 });
        }
        await collection.updateOne(
          { metaGoalId },
          { $addToSet: { invitedUsers: normalizedUser }, $set: { updatedAt: new Date().toISOString() } }
        );
      } else if (!isCreator && !isParticipant && !isInvited) {
        return NextResponse.json({ error: "Access denied. This is a private goal." }, { status: 403 });
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

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const inviteLink = `${baseUrl}/goals/${metaGoalId}`;

    return NextResponse.json({
      metaGoalId,
      name: metaGoal.name,
      targetAmountUSD: metaGoal.targetAmountUSD,
      targetDate: metaGoal.targetDate,
      creatorAddress: metaGoal.creatorAddress,
      totalProgressUSD,
      progressPercent: Math.min(overallProgressPercent, 100),
      vaultProgress,
      inviteLink,
    });
  } catch (error) {
    console.error("Get meta-goal progress error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}