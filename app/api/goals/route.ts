import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { VAULTS, CONTRACTS, GOAL_MANAGER_ABI } from "../../../lib/constants";
import { createProvider, createBackendWallet, findEventInLogs, isValidAddress, getContractCompliantTargetDate } from "../../../lib/utils";
import { getMetaGoalsCollection } from "../../../lib/database";
import { GoalSyncService } from "../../../lib/services/goal-sync.service";
import type {
  CreateMultiVaultGoalRequest,
  CreateMultiVaultGoalResponse,
  ErrorResponse,
  VaultAsset,
  MetaGoal,
  MetaGoalWithProgress,
} from "../../../lib/types";

export const dynamic = 'force-dynamic';

async function syncUserGoalsFromBlockchain(userAddress: string, goalManager: ethers.Contract, collection: Collection<MetaGoal>) {
  const onChainGoals: Record<VaultAsset, string> = {} as Record<VaultAsset, string>;
  let earliestCreatedAt = Date.now();
  let hasAnyGoal = false;

  for (const [asset, vaultConfig] of Object.entries(VAULTS)) {
    try {
      const goalId = await goalManager.getQuicksaveGoal(vaultConfig.address, userAddress);
      
      if (goalId > BigInt(0)) {
        hasAnyGoal = true;
        const goal = await goalManager.goals(goalId);
        if (goal.creator.toLowerCase() === userAddress.toLowerCase()) {
          onChainGoals[asset as VaultAsset] = goalId.toString();
          const createdAt = Number(goal.createdAt) * 1000;
          if (createdAt < earliestCreatedAt) earliestCreatedAt = createdAt;
        }
      }
    } catch (error) {
      console.error(`Error syncing ${asset} goal:`, error);
    }
  }

  if (hasAnyGoal) {
    const provider = createProvider();
    const backendWallet = createBackendWallet(provider);
    const goalManagerWrite = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, backendWallet);

    for (const [asset, vaultConfig] of Object.entries(VAULTS)) {
      if (!onChainGoals[asset as VaultAsset]) {
        try {
          const tx = await goalManagerWrite.createQuicksaveGoalFor(userAddress, vaultConfig.address);
          const receipt = await tx.wait();
          const goalEvent = findEventInLogs(receipt.logs, goalManagerWrite, "GoalCreated");
          if (goalEvent) {
            onChainGoals[asset as VaultAsset] = goalEvent.args.goalId.toString();
          }
        } catch (error) {
          console.error(`Error creating ${asset} quicksave goal:`, error);
        }
      }
    }

    const existing = await collection.findOne({ 
      creatorAddress: userAddress,
      targetAmountUSD: 0,
      name: "quicksave"
    });

    if (!existing) {
      const metaGoalId = uuidv4();
      const metaGoal: MetaGoal & { participants?: string[] } = {
        metaGoalId,
        name: "quicksave",
        targetAmountUSD: 0,
        targetDate: "",
        creatorAddress: userAddress,
        onChainGoals,
        participants: [userAddress.toLowerCase()],
        createdAt: new Date(earliestCreatedAt).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await collection.insertOne(metaGoal as MetaGoal);
    } else {
      await collection.updateOne(
        { metaGoalId: existing.metaGoalId },
        { $set: { onChainGoals, updatedAt: new Date().toISOString() } }
      );
    }
  }
}

export async function GET(request: NextRequest): Promise<NextResponse<MetaGoalWithProgress[] | ErrorResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const creatorAddress = searchParams.get("creatorAddress");
    const participantAddress = searchParams.get("participantAddress");

    if (creatorAddress && !isValidAddress(creatorAddress)) {
      return NextResponse.json({ error: "Invalid creator address" }, { status: 400 });
    }

    if (participantAddress && !isValidAddress(participantAddress)) {
      return NextResponse.json({ error: "Invalid participant address" }, { status: 400 });
    }

    if (!creatorAddress && !participantAddress) {
      return NextResponse.json({ error: "Either creatorAddress or participantAddress required" }, { status: 400 });
    }

    const provider = createProvider();
    const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, provider);
    const collection = await getMetaGoalsCollection();

    if (creatorAddress) {
      const syncService = new GoalSyncService(provider);
      await syncService.discoverUserGoalsFromEvents(creatorAddress);
      await syncService.syncUserGoals(creatorAddress);
    }

    let metaGoals: MetaGoal[];
    
    if (participantAddress) {
      const syncService = new GoalSyncService(provider);
      await syncService.discoverUserGoalsFromEvents(participantAddress);
      
      metaGoals = await collection.find({ 
        participants: { $in: [participantAddress.toLowerCase()] } 
      }).toArray();
    } else if (creatorAddress) {
      metaGoals = await collection.find({ creatorAddress: creatorAddress.toLowerCase() }).toArray();
    } else {
      metaGoals = [];
    }

    const goalsWithProgress: (MetaGoalWithProgress | null)[] = await Promise.all(
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
            } catch (error) {
              console.error(`Error getting progress for goal ${goalIdStr}:`, error);
              return {
                asset: asset as VaultAsset,
                data: { goalId: goalIdStr as string, progressUSD: 0, progressPercent: 0, attachmentCount: 0 },
              };
            }
          }
        );

        const progressResults = await Promise.all(progressPromises);
        
        const participantsSet = new Set<string>();
        const activeGoals: Record<string, string> = {};
        
        for (const { asset, data } of progressResults) {
          try {
            const goalId = BigInt(data.goalId);
            const [, , , , , , , cancelled] = await goalManager.goals(goalId);
            
            if (!cancelled) {
              vaultProgress[asset] = data;
              totalProgressUSD += data.progressUSD;
              activeGoals[asset] = data.goalId;
              
              if (data.attachmentCount > 0) {
                const maxAttachments = Math.min(data.attachmentCount, 50);
                const attachmentPromises = Array.from({ length: maxAttachments }, (_, i) =>
                  goalManager.attachmentAt(goalId, i).catch(() => null)
                );
                const attachments = await Promise.all(attachmentPromises);
                attachments.forEach((att) => {
                  if (att) participantsSet.add(att.owner.toLowerCase());
                });
              }
            }
          } catch (error) {
            console.error(`Error checking goal ${data.goalId}:`, error);
          }
        }

        const progressPercent =
          metaGoal.targetAmountUSD > 0
            ? (totalProgressUSD / metaGoal.targetAmountUSD) * 100
            : 0;

        if (Object.keys(activeGoals).length === 0) {
          // Clean up database if no active goals remain
          try {
            await collection.deleteOne({ metaGoalId: metaGoal.metaGoalId });
          } catch (error) {
            console.error(`Error cleaning up cancelled meta goal ${metaGoal.metaGoalId}:`, error);
          }
          return null;
        }

        // Update database if some goals were cancelled or participants changed
        const participantsArray = Array.from(participantsSet);
        const needsUpdate = 
          Object.keys(activeGoals).length !== Object.keys(metaGoal.onChainGoals).length ||
          JSON.stringify((metaGoal as MetaGoal & { participants?: string[] }).participants?.sort()) !== JSON.stringify(participantsArray.sort());

        if (needsUpdate) {
          try {
            await collection.updateOne(
              { metaGoalId: metaGoal.metaGoalId },
              { 
                $set: { 
                  onChainGoals: activeGoals, 
                  participants: participantsArray,
                  updatedAt: new Date().toISOString() 
                } 
              }
            );
          } catch (error) {
            console.error(`Error updating meta goal ${metaGoal.metaGoalId}:`, error);
          }
        }

        return {
          ...metaGoal,
          onChainGoals: activeGoals,
          totalProgressUSD,
          progressPercent,
          vaultProgress,
          participants: Array.from(participantsSet),
          userBalance: "0",
          userBalanceUSD: "0.00",
        };
      })
    );

    const validGoals = goalsWithProgress.filter(goal => goal !== null);
    return NextResponse.json(validGoals);
  } catch (error) {
    console.error("Get meta-goals error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<CreateMultiVaultGoalResponse | ErrorResponse>> {
  try {
    const body: CreateMultiVaultGoalRequest = await request.json();
    const { name, targetAmountUSD, targetDate, creatorAddress, vaults } = body;

    if (!name || !targetAmountUSD || !creatorAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (!isValidAddress(creatorAddress)) {
      return NextResponse.json({ error: "Invalid creator address" }, { status: 400 });
    }

    const provider = createProvider();
    const backendWallet = createBackendWallet(provider);
    const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, backendWallet);

    const targetVaults = vaults === "all" ? Object.keys(VAULTS) as VaultAsset[] : vaults;
    const metaGoalId = uuidv4();
    const onChainGoals: Record<VaultAsset, string> = {} as Record<VaultAsset, string>;
    const txHashes: Record<VaultAsset, string> = {} as Record<VaultAsset, string>;

    for (const asset of targetVaults) {
      const vaultConfig = VAULTS[asset];
      const targetAmountWei = ethers.parseUnits(targetAmountUSD.toString(), vaultConfig.decimals);
      
      let parsedTargetDate;
      if (targetDate) {
        const targetDateMs = new Date(targetDate).getTime();
        const targetDateSeconds = Math.floor(targetDateMs / 1000);
        const minAllowedDate = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
        parsedTargetDate = Math.max(targetDateSeconds, minAllowedDate + (24 * 60 * 60));
      } else {
        parsedTargetDate = getContractCompliantTargetDate();
      }

      const tx = await goalManager.createGoalFor(
        creatorAddress,
        vaultConfig.address,
        targetAmountWei,
        parsedTargetDate,
        name
      );

      const receipt = await tx.wait();
      const goalEvent = findEventInLogs(receipt.logs, goalManager, "GoalCreated");
      
      if (goalEvent) {
        onChainGoals[asset] = goalEvent.args.goalId.toString();
        txHashes[asset] = tx.hash;
      }
    }

    const metaGoal: MetaGoal & { participants?: string[] } = {
      metaGoalId,
      name,
      targetAmountUSD,
      targetDate: targetDate || "",
      creatorAddress,
      onChainGoals,
      participants: [creatorAddress.toLowerCase()],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const collection = await getMetaGoalsCollection();
    await collection.insertOne(metaGoal as MetaGoal);

    return NextResponse.json({
      success: true,
      metaGoalId,
      onChainGoals,
      txHashes,
    });
  } catch (error) {
    console.error("Create multi-vault goal error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
