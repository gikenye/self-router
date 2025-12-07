import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { VAULTS, CONTRACTS, GOAL_MANAGER_ABI } from "../../../lib/constants";
import { createProvider, createBackendWallet, formatAmountForDisplay, getContractCompliantTargetDate, waitForTransactionReceipt, findEventInLogs } from "../../../lib/utils";
import { getMetaGoalsCollection } from "../../../lib/database";
import { BlockchainService } from "../../../lib/services/blockchain.service";
import { DepositService } from "../../../lib/services/deposit.service";
import { RequestValidator } from "../../../lib/validators/request.validator";
import type { ErrorResponse, AssetBalance, VaultAsset, MetaGoal } from "../../../lib/types";

export const dynamic = 'force-dynamic';

interface ConsolidatedUserResponse {
  userAddress: string;
  totalValueUSD: string;
  leaderboardScore: string;
  formattedLeaderboardScore: string;
  leaderboardRank: number | null;
  assetBalances: AssetBalance[];
}

export async function GET(request: NextRequest): Promise<NextResponse<ConsolidatedUserResponse | ErrorResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get("userAddress");

    const validation = RequestValidator.validateUserAddress(userAddress);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error! }, { status: 400 });
    }

    const provider = createProvider();
    const blockchainService = new BlockchainService(provider);
    const depositService = new DepositService(blockchainService);

    const leaderboardScore = await blockchainService.getLeaderboard().getUserScore(userAddress!);
    const rank = await blockchainService.getUserLeaderboardRank(userAddress!, leaderboardScore);

    const vaultPromises = Object.entries(VAULTS).map(async ([assetName, vaultConfig]) => {
      const { deposits, assetBalance } = await depositService.processVaultDeposits(
        vaultConfig.address,
        assetName,
        userAddress!,
        vaultConfig
      );
      return { deposits, assetBalance: assetBalance.depositCount > 0 ? assetBalance : null };
    });

    const vaultResults = await Promise.all(vaultPromises);
    const assetBalances: AssetBalance[] = [];
    let totalValueUSD = 0;

    vaultResults.forEach(({ assetBalance }) => {
      if (assetBalance) {
        assetBalances.push(assetBalance);
        totalValueUSD += parseFloat(assetBalance.totalAmountUSD);
      }
    });

    const response: ConsolidatedUserResponse = {
      userAddress: userAddress!,
      totalValueUSD: totalValueUSD.toFixed(2),
      leaderboardScore: leaderboardScore.toString(),
      formattedLeaderboardScore: formatAmountForDisplay(leaderboardScore.toString(), 6, 2),
      leaderboardRank: rank,
      assetBalances,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("❌ User positions API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse<unknown | ErrorResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");

    switch (action) {
      case "create-goal":
        return await handleCreateGoal(request);
      case "create-group-goal":
        return await handleCreateGroupGoal(request);
      case "join-goal":
        return await handleJoinGoal(request);
      case "allocate":
        return await handleAllocate(request);
      case "group-goal-members":
        return await handleGetGroupGoalMembers(request);
      case "group-goal-details":
        return await handleGetGroupGoalDetails(request);
      case "cancel-goal":
        return await handleCancelGoal(request);
      default:
        return NextResponse.json(
          { error: "Invalid action. Supported: create-goal, create-group-goal, join-goal, allocate, group-goal-members, group-goal-details, cancel-goal" },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("❌ POST method error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

async function handleCreateGoal(request: NextRequest) {
  const body = await request.json();
  const { name, targetAmountUSD, targetDate, creatorAddress, vaults } = body;

  if (!name || !targetAmountUSD || !creatorAddress) {
    return NextResponse.json(
      { error: "Missing required fields: name, targetAmountUSD, creatorAddress" },
      { status: 400 }
    );
  }

  const validation = RequestValidator.validateUserAddress(creatorAddress);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const provider = createProvider();
  const backendWallet = createBackendWallet(provider);
  const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, backendWallet);

  const targetVaults: VaultAsset[] = vaults === "all" ? (Object.keys(VAULTS) as VaultAsset[]) : vaults;
  const metaGoalId = uuidv4();
  const onChainGoals: Record<VaultAsset, string> = {} as Record<VaultAsset, string>;
  const txHashes: Record<VaultAsset, string> = {} as Record<VaultAsset, string>;

  let parsedTargetDate;
  if (targetDate) {
    const targetDateSeconds = Math.floor(new Date(targetDate).getTime() / 1000);
    const minAllowedDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    parsedTargetDate = Math.max(targetDateSeconds, minAllowedDate + 24 * 60 * 60);
  } else {
    parsedTargetDate = getContractCompliantTargetDate();
  }

  const nonce = await backendWallet.getNonce();
  const txPromises = targetVaults.map(async (asset, index) => {
    const vaultConfig = VAULTS[asset];
    const targetAmountWei = ethers.parseUnits(targetAmountUSD.toString(), vaultConfig.decimals);
    const tx = await goalManager.createGoalFor(creatorAddress, vaultConfig.address, targetAmountWei, parsedTargetDate, name, { nonce: nonce + index });
    const receipt = await tx.wait();
    const goalEvent = findEventInLogs(receipt.logs, goalManager, "GoalCreated");
    return { asset, goalId: goalEvent?.args.goalId.toString() || "", txHash: tx.hash };
  });

  const results = await Promise.all(txPromises);
  results.forEach(({ asset, goalId, txHash }) => {
    if (goalId) {
      onChainGoals[asset] = goalId;
      txHashes[asset] = txHash;
    }
  });

  const metaGoal: MetaGoal = {
    metaGoalId,
    name,
    targetAmountUSD,
    targetDate: targetDate || "",
    creatorAddress,
    onChainGoals,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const collection = await getMetaGoalsCollection();
  await collection.insertOne(metaGoal);

  return NextResponse.json({ success: true, metaGoalId, onChainGoals, txHashes });
}

async function handleCreateGroupGoal(request: NextRequest) {
  const body = await request.json();
  const { name, targetAmountUSD, targetDate, creatorAddress, vaults, isPublic } = body;

  if (!name || !targetAmountUSD || !creatorAddress) {
    return NextResponse.json(
      { error: "Missing required fields: name, targetAmountUSD, creatorAddress" },
      { status: 400 }
    );
  }

  const validation = RequestValidator.validateUserAddress(creatorAddress);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const provider = createProvider();
  const backendWallet = createBackendWallet(provider);
  const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, backendWallet);

  const targetVaults: VaultAsset[] = vaults === "all" ? (Object.keys(VAULTS) as VaultAsset[]) : vaults;
  const metaGoalId = uuidv4();
  const onChainGoals: Record<VaultAsset, string> = {} as Record<VaultAsset, string>;
  const txHashes: Record<VaultAsset, string> = {} as Record<VaultAsset, string>;

  let parsedTargetDate;
  if (targetDate) {
    const targetDateSeconds = Math.floor(new Date(targetDate).getTime() / 1000);
    const minAllowedDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    parsedTargetDate = Math.max(targetDateSeconds, minAllowedDate + 24 * 60 * 60);
  } else {
    parsedTargetDate = getContractCompliantTargetDate();
  }

  const nonce = await backendWallet.getNonce();
  const txPromises = targetVaults.map(async (asset, index) => {
    const vaultConfig = VAULTS[asset];
    const targetAmountWei = ethers.parseUnits(targetAmountUSD.toString(), vaultConfig.decimals);
    const tx = await goalManager.createGoalFor(creatorAddress, vaultConfig.address, targetAmountWei, parsedTargetDate, name, { nonce: nonce + index });
    const receipt = await tx.wait();
    const goalEvent = findEventInLogs(receipt.logs, goalManager, "GoalCreated");
    return { asset, goalId: goalEvent?.args.goalId.toString() || "", txHash: tx.hash };
  });

  const results = await Promise.all(txPromises);
  results.forEach(({ asset, goalId, txHash }) => {
    if (goalId) {
      onChainGoals[asset] = goalId;
      txHashes[asset] = txHash;
    }
  });

  const metaGoal: MetaGoal & { isPublic?: boolean; participants?: string[] } = {
    metaGoalId,
    name,
    targetAmountUSD,
    targetDate: targetDate || "",
    creatorAddress,
    onChainGoals,
    isPublic: isPublic ?? true,
    participants: [creatorAddress],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const collection = await getMetaGoalsCollection();
  await collection.insertOne(metaGoal as MetaGoal);

  return NextResponse.json({ success: true, metaGoalId, onChainGoals, txHashes });
}

async function handleJoinGoal(request: NextRequest) {
  const body = await request.json();
  const { goalId, userAddress, depositTxHash, asset } = body;

  if (!goalId || !userAddress || !depositTxHash || !asset) {
    return NextResponse.json(
      { error: "Missing required fields: goalId, userAddress, depositTxHash, asset" },
      { status: 400 }
    );
  }

  if (!depositTxHash.match(/^0x[0-9a-fA-F]{64}$/)) {
    return NextResponse.json(
      { error: `Invalid depositTxHash format. Received: "${depositTxHash}" (length: ${depositTxHash.length}). Must be a valid 66-character hex transaction hash (0x + 64 hex chars)` },
      { status: 400 }
    );
  }

  const vaultConfig = VAULTS[asset as keyof typeof VAULTS];
  if (!vaultConfig) {
    return NextResponse.json(
      { error: `Invalid asset. Supported: ${Object.keys(VAULTS).join(", ")}` },
      { status: 400 }
    );
  }

  const provider = createProvider();
  const backendWallet = createBackendWallet(provider);

  const receipt = await waitForTransactionReceipt(provider, depositTxHash);
  if (!receipt || !receipt.status) {
    return NextResponse.json({ error: "Deposit transaction not found or failed" }, { status: 400 });
  }

  const blockchainService = new BlockchainService(provider);
  const vault = blockchainService.getVault(vaultConfig.address);
  const depositEvent = findEventInLogs(receipt.logs, vault, "Deposited");

  if (!depositEvent || depositEvent.args.user.toLowerCase() !== userAddress.toLowerCase()) {
    return NextResponse.json({ error: "Invalid deposit transaction" }, { status: 400 });
  }

  const goalManager = blockchainService.getGoalManager(backendWallet);
  const leaderboard = blockchainService.getLeaderboard(backendWallet);

  const [attachTx, scoreTx] = await Promise.all([
    goalManager.attachDepositsOnBehalf(goalId, userAddress, [depositEvent.args.depositId.toString()]),
    leaderboard.recordDepositOnBehalf(userAddress, depositEvent.args.amount.toString()),
  ]);

  await Promise.all([attachTx.wait(), scoreTx.wait()]);

  const collection = await getMetaGoalsCollection();
  const metaGoal = await collection.findOne({ [`onChainGoals.${asset}`]: goalId }) as (MetaGoal & { participants?: string[] }) | null;
  
  if (metaGoal && metaGoal.participants && !metaGoal.participants.includes(userAddress)) {
    await collection.updateOne(
      { metaGoalId: metaGoal.metaGoalId },
      { $addToSet: { participants: userAddress }, $set: { updatedAt: new Date().toISOString() } }
    );
  }

  return NextResponse.json({
    success: true,
    goalId,
    depositId: depositEvent.args.depositId.toString(),
    amount: depositEvent.args.amount.toString(),
    formattedAmount: formatAmountForDisplay(depositEvent.args.amount.toString(), vaultConfig.decimals, 4),
    attachTxHash: attachTx.hash,
  });
}

async function handleAllocate(request: NextRequest) {
  const body = await request.json();
  const { asset, userAddress, amount, txHash, targetGoalId } = body;

  if (!asset || !userAddress || !amount || !txHash) {
    return NextResponse.json(
      { error: "Missing required fields: asset, userAddress, amount, txHash" },
      { status: 400 }
    );
  }

  if (!txHash.match(/^0x[0-9a-fA-F]{64}$/)) {
    return NextResponse.json(
      { error: `Invalid txHash format. Received: "${txHash}" (length: ${txHash.length}). Must be a valid 66-character hex transaction hash (0x + 64 hex chars)` },
      { status: 400 }
    );
  }

  const vaultConfig = VAULTS[asset as keyof typeof VAULTS];
  if (!vaultConfig) {
    return NextResponse.json(
      { error: `Invalid asset. Supported: ${Object.keys(VAULTS).join(", ")}` },
      { status: 400 }
    );
  }

  const provider = createProvider();
  const backendWallet = createBackendWallet(provider);

  const receipt = await waitForTransactionReceipt(provider, txHash);
  if (!receipt || !receipt.status) {
    return NextResponse.json({ error: "Transaction not found or failed" }, { status: 400 });
  }

  const blockchainService = new BlockchainService(provider);
  const vault = blockchainService.getVault(vaultConfig.address, backendWallet);
  const depositEvent = findEventInLogs(receipt.logs, vault, "Deposited");

  if (!depositEvent) {
    return NextResponse.json({ error: "Failed to parse deposit event" }, { status: 500 });
  }

  const goalManager = blockchainService.getGoalManager();
  const goalManagerWrite = blockchainService.getGoalManager(backendWallet);
  const leaderboard = blockchainService.getLeaderboard(backendWallet);

  let attachedGoalId = targetGoalId
    ? BigInt(targetGoalId)
    : await goalManager.getQuicksaveGoal(vaultConfig.address, userAddress);

  if (attachedGoalId.toString() === "0") {
    const createTx = await goalManagerWrite.createQuicksaveGoalFor(userAddress, vaultConfig.address);
    const createReceipt = await createTx.wait();
    const goalEvent = findEventInLogs(createReceipt.logs, goalManagerWrite, "GoalCreated");
    if (goalEvent) {
      attachedGoalId = goalEvent.args.goalId;
    }
  }

  if (attachedGoalId !== BigInt(0)) {
    try {
      const attachTx = await goalManagerWrite.attachDepositsOnBehalf(
        attachedGoalId,
        userAddress,
        [depositEvent.args.depositId.toString()]
      );
      await attachTx.wait();
    } catch (error) {
      console.log("Attachment failed:", error instanceof Error ? error.message : String(error));
    }
  }

  const scoreTx = await leaderboard.recordDepositOnBehalf(userAddress, amount);
  await scoreTx.wait();

  return NextResponse.json({
    success: true,
    depositId: depositEvent.args.depositId.toString(),
    goalId: attachedGoalId.toString(),
    shares: depositEvent.args.shares.toString(),
    formattedShares: formatAmountForDisplay(depositEvent.args.shares.toString(), vaultConfig.decimals, 4),
    allocationTxHash: txHash,
  });
}

async function handleGetGroupGoalMembers(request: NextRequest) {
  const body = await request.json();
  const { metaGoalId } = body;

  if (!metaGoalId) {
    return NextResponse.json({ error: "Missing required field: metaGoalId" }, { status: 400 });
  }

  const collection = await getMetaGoalsCollection();
  const metaGoal = await collection.findOne({ metaGoalId }) as (MetaGoal & { cachedMembers?: unknown; lastSync?: string }) | null;

  if (!metaGoal) {
    return NextResponse.json({ error: "Group goal not found" }, { status: 404 });
  }

  console.log("🔄 Fetching fresh member data");
  const memberData = await fetchGroupGoalMembers(metaGoal);
  await collection.updateOne(
    { metaGoalId },
    { $set: { cachedMembers: memberData, lastSync: new Date().toISOString() } }
  );

  return NextResponse.json({
    metaGoalId,
    goalName: metaGoal.name,
    targetAmountUSD: metaGoal.targetAmountUSD,
    ...memberData,
  });
}

async function fetchGroupGoalMembers(metaGoal: MetaGoal) {
  const provider = createProvider();
  const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, provider);

  const memberStats: Record<string, {
    address: string;
    totalContributionUSD: number;
    contributionPercent: number;
    depositCount: number;
    joinedAt: string;
  }> = {};

  console.log("🔍 Fetching members for goal:", metaGoal.metaGoalId);

  for (const [asset, goalIdStr] of Object.entries(metaGoal.onChainGoals)) {
    const goalId = BigInt(goalIdStr as string);
    const attachmentCount = await goalManager.attachmentCount(goalId);
    console.log(`📊 ${asset} goal ${goalId}: ${attachmentCount} attachments`);
    
    const vaultConfig = VAULTS[asset as VaultAsset];
    const vault = new ethers.Contract(vaultConfig.address, ["function getUserDeposit(address,uint256) view returns (uint256,uint256,uint256,uint256,bool)"], provider);

    for (let i = 0; i < Number(attachmentCount); i++) {
      const attachment = await goalManager.attachmentAt(goalId, i);
      const owner = attachment.owner.toLowerCase();
      const [, currentValue] = await vault.getUserDeposit(attachment.owner, attachment.depositId);
      const contributionUSD = parseFloat(formatAmountForDisplay(currentValue.toString(), vaultConfig.decimals));
      
      console.log(`  👤 Member: ${attachment.owner}, Deposit: ${attachment.depositId}, Value: ${contributionUSD}`);

      if (!memberStats[owner]) {
        memberStats[owner] = {
          address: attachment.owner,
          totalContributionUSD: 0,
          contributionPercent: 0,
          depositCount: 0,
          joinedAt: new Date(Number(attachment.attachedAt) * 1000).toISOString(),
        };
      } else if (new Date(Number(attachment.attachedAt) * 1000) < new Date(memberStats[owner].joinedAt)) {
        memberStats[owner].joinedAt = new Date(Number(attachment.attachedAt) * 1000).toISOString();
      }

      memberStats[owner].totalContributionUSD += contributionUSD;
      memberStats[owner].depositCount++;
    }
  }
  
  console.log("✅ Total members found:", Object.keys(memberStats).length);

  const totalGoalValue = Object.values(memberStats).reduce((sum, m) => sum + m.totalContributionUSD, 0);
  Object.values(memberStats).forEach(member => {
    member.contributionPercent = totalGoalValue > 0 ? (member.totalContributionUSD / totalGoalValue) * 100 : 0;
  });

  const members = Object.values(memberStats).sort((a, b) => b.totalContributionUSD - a.totalContributionUSD);

  return {
    totalContributedUSD: totalGoalValue,
    progressPercent: (totalGoalValue / metaGoal.targetAmountUSD) * 100,
    memberCount: members.length,
    members,
  };
}

async function handleCancelGoal(request: NextRequest) {
  const body = await request.json();
  const { metaGoalId, userAddress } = body;

  if (!metaGoalId || !userAddress) {
    return NextResponse.json(
      { error: "Missing required fields: metaGoalId, userAddress" },
      { status: 400 }
    );
  }

  const collection = await getMetaGoalsCollection();
  const metaGoal = await collection.findOne({ metaGoalId });

  if (!metaGoal) {
    return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  }

  if (metaGoal.creatorAddress.toLowerCase() !== userAddress.toLowerCase()) {
    return NextResponse.json({ error: "Only goal creator can cancel" }, { status: 403 });
  }

  const provider = createProvider();
  const backendWallet = createBackendWallet(provider);
  const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, backendWallet);

  const cancelledGoals: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const alreadyCancelled: string[] = [];

  for (const [asset, goalIdStr] of Object.entries(metaGoal.onChainGoals)) {
    try {
      const goalId = BigInt(goalIdStr as string);
      const [, , , , , , , cancelled, completed] = await goalManager.goals(goalId);
      const attachmentCount = await goalManager.attachmentCount(goalId);

      if (cancelled) {
        errors[asset] = "Already cancelled";
        alreadyCancelled.push(asset);
        continue;
      }

      if (!completed && Number(attachmentCount) > 0) {
        errors[asset] = "Goal has deposits attached";
        continue;
      }

      const tx = await goalManager.cancelGoal(goalId);
      await tx.wait();
      cancelledGoals[asset] = tx.hash;
    } catch (error) {
      errors[asset] = error instanceof Error ? error.message : "Unknown error";
    }
  }

  if (Object.keys(cancelledGoals).length > 0 || alreadyCancelled.length > 0) {
    const remainingGoals: Record<string, string> = {};
    for (const [asset, goalId] of Object.entries(metaGoal.onChainGoals)) {
      if (!cancelledGoals[asset] && !alreadyCancelled.includes(asset)) {
        remainingGoals[asset] = goalId as string;
      }
    }

    if (Object.keys(remainingGoals).length === 0) {
      await collection.deleteOne({ metaGoalId });
    } else {
      await collection.updateOne(
        { metaGoalId },
        { $set: { onChainGoals: remainingGoals, updatedAt: new Date().toISOString() }, $unset: { cancelled: "" } }
      );
    }
  }

  return NextResponse.json({
    success: Object.keys(cancelledGoals).length > 0,
    metaGoalId,
    cancelledGoals,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  });
}

async function handleGetGroupGoalDetails(request: NextRequest) {
  const body = await request.json();
  const { metaGoalId } = body;

  if (!metaGoalId) {
    return NextResponse.json({ error: "Missing required field: metaGoalId" }, { status: 400 });
  }

  const collection = await getMetaGoalsCollection();
  const metaGoal = await collection.findOne({ metaGoalId });

  if (!metaGoal) {
    return NextResponse.json({ error: "Group goal not found" }, { status: 404 });
  }

  const provider = createProvider();
  const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, provider);

  const balances: Record<string, { asset: string; totalBalance: string; formattedBalance: string }> = {};
  const transactions: Array<{
    asset: string;
    userAddress: string;
    depositId: string;
    currentValue: string;
    formattedValue: string;
    attachedAt: string;
  }> = [];

  for (const [asset, goalIdStr] of Object.entries(metaGoal.onChainGoals)) {
    const goalId = BigInt(goalIdStr as string);
    const vaultConfig = VAULTS[asset as VaultAsset];
    const vault = new ethers.Contract(vaultConfig.address, [
      "function getUserDeposit(address,uint256) view returns (uint256,uint256,uint256,uint256,bool)"
    ], provider);

    let totalBalance = BigInt(0);
    const attachmentCount = await goalManager.attachmentCount(goalId);

    for (let i = 0; i < Number(attachmentCount); i++) {
      const attachment = await goalManager.attachmentAt(goalId, i);
      const [, currentValue] = await vault.getUserDeposit(attachment.owner, attachment.depositId);
      totalBalance += currentValue;

      transactions.push({
        asset,
        userAddress: attachment.owner,
        depositId: attachment.depositId.toString(),
        currentValue: currentValue.toString(),
        formattedValue: formatAmountForDisplay(currentValue.toString(), vaultConfig.decimals, 4),
        attachedAt: new Date(Number(attachment.attachedAt) * 1000).toISOString()
      });
    }

    balances[asset] = {
      asset,
      totalBalance: totalBalance.toString(),
      formattedBalance: formatAmountForDisplay(totalBalance.toString(), vaultConfig.decimals, 4)
    };
  }

  transactions.sort((a, b) => new Date(b.attachedAt).getTime() - new Date(a.attachedAt).getTime());

  return NextResponse.json({
    metaGoalId,
    goalName: metaGoal.name,
    targetAmountUSD: metaGoal.targetAmountUSD,
    balances,
    transactions
  });
}
