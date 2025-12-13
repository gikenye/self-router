import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { VAULTS, CONTRACTS, GOAL_MANAGER_ABI } from "../constants";
import { createProvider, formatAmountForDisplay } from "../utils";
import { getMetaGoalsCollection } from "../database";
import type { VaultAsset, MetaGoal } from "../types";
import type { Collection } from "mongodb";

export class GoalSyncService {
  private provider: ethers.Provider;
  private goalManager: ethers.Contract;
  private collection: Collection<MetaGoal> | null = null;

  constructor(provider?: ethers.Provider) {
    this.provider = provider || createProvider();
    this.goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, this.provider);
  }

  private async getCollection() {
    if (!this.collection) {
      this.collection = await getMetaGoalsCollection();
    }
    return this.collection;
  }

  async syncGoalFromChain(goalId: string): Promise<MetaGoal | null> {
    try {
      const onChainGoal = await this.goalManager.goals(goalId);
      
      if (onChainGoal.id.toString() === "0") {
        return null;
      }

      const vaultAddress = onChainGoal.vault.toLowerCase();
      let asset: VaultAsset | null = null;
      
      for (const [key, config] of Object.entries(VAULTS)) {
        if (config.address.toLowerCase() === vaultAddress) {
          asset = key as VaultAsset;
          break;
        }
      }

      if (!asset) return null;

      const vaultConfig = VAULTS[asset];
      const targetAmountUSD = parseFloat(
        formatAmountForDisplay(onChainGoal.targetAmount.toString(), vaultConfig.decimals)
      );

      const collection = await this.getCollection();
      const existing = await collection.findOne({ [`onChainGoals.${asset}`]: goalId });

      if (existing) {
        return existing;
      }

      const metaGoalId = uuidv4();
      const metaGoal: MetaGoal = {
        metaGoalId,
        name: onChainGoal.metadataURI || `Goal ${goalId}`,
        targetAmountUSD,
        targetDate: new Date(Number(onChainGoal.targetDate) * 1000).toISOString(),
        creatorAddress: onChainGoal.creator.toLowerCase(),
        onChainGoals: { [asset]: goalId },
        createdAt: new Date(Number(onChainGoal.createdAt) * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await collection.insertOne(metaGoal);
      console.log(`✅ Synced goal ${goalId} from chain to DB as meta-goal ${metaGoalId}`);
      
      return metaGoal;
    } catch (error) {
      console.error(`Failed to sync goal ${goalId}:`, error);
      return null;
    }
  }

  async discoverUserGoalsFromEvents(userAddress: string, fromBlock: number = -5000): Promise<string[]> {
    const discoveredGoalIds: string[] = [];
    
    try {
      let startBlock: number;
      if (fromBlock < 0) {
        const latestBlock = await this.provider.getBlockNumber();
        startBlock = Math.max(0, latestBlock + fromBlock);
      } else {
        startBlock = Math.floor(fromBlock);
      }
      
      console.log(`🔍 Discovering goals for ${userAddress} from block ${startBlock}`);
      const filter = this.goalManager.filters.GoalCreated(null, userAddress, null);
      const events = await this.goalManager.queryFilter(filter, startBlock, "latest");
      
      console.log(`📊 Found ${events.length} GoalCreated events`);
      
      for (const event of events) {
        if ("args" in event && event.args?.goalId) {
          const goalId = event.args.goalId.toString();
          console.log(`  - Goal ID: ${goalId}`);
          discoveredGoalIds.push(goalId);
          await this.syncGoalFromChain(goalId);
        }
      }
    } catch (error) {
      console.error(`Error discovering goals for ${userAddress}:`, error);
    }
    
    return discoveredGoalIds;
  }

  async syncUserGoals(userAddress: string): Promise<void> {
    const collection = await this.getCollection();
    const syncedGoals: Record<VaultAsset, string> = {} as Record<VaultAsset, string>;
    let hasGoals = false;

    // Discover goals from recent events
    await this.discoverUserGoalsFromEvents(userAddress);

    for (const [asset, vaultConfig] of Object.entries(VAULTS)) {
      try {
        const goalId = await this.goalManager.getQuicksaveGoal(vaultConfig.address, userAddress);
        
        if (goalId > BigInt(0)) {
          hasGoals = true;
          const goal = await this.goalManager.goals(goalId);
          
          if (goal.creator.toLowerCase() === userAddress.toLowerCase()) {
            syncedGoals[asset as VaultAsset] = goalId.toString();
          }
        }
      } catch (error) {
        console.error(`Error syncing ${asset} goal for ${userAddress}:`, error);
      }
    }

    if (hasGoals) {
      const existing = await collection.findOne({
        creatorAddress: userAddress.toLowerCase(),
        targetAmountUSD: 0,
        name: "quicksave"
      });

      if (!existing) {
        const metaGoalId = uuidv4();
        await collection.insertOne({
          metaGoalId,
          name: "quicksave",
          targetAmountUSD: 0,
          targetDate: "",
          creatorAddress: userAddress.toLowerCase(),
          onChainGoals: syncedGoals,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } else {
        await collection.updateOne(
          { metaGoalId: existing.metaGoalId },
          { $set: { onChainGoals: syncedGoals, updatedAt: new Date().toISOString() } }
        );
      }
    }
  }

  async getGoalWithFallback(goalId: string): Promise<{ metaGoal: MetaGoal | null; fromChain: boolean }> {
    const collection = await this.getCollection();
    
    for (const [asset] of Object.entries(VAULTS)) {
      const existing = await collection.findOne({ [`onChainGoals.${asset}`]: goalId });
      if (existing) {
        return { metaGoal: existing, fromChain: false };
      }
    }

    const synced = await this.syncGoalFromChain(goalId);
    return { metaGoal: synced, fromChain: true };
  }
}
