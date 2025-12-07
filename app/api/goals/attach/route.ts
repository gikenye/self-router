import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { VAULTS, CONTRACTS, GOAL_MANAGER_ABI } from "../../../../lib/constants";
import { createProvider, createBackendWallet, isValidAddress } from "../../../../lib/utils";
import { getMetaGoalsCollection } from "../../../../lib/database";
import type {
  AttachDepositRequest,
  AttachDepositResponse,
  ErrorResponse,
  VaultAsset,
} from "../../../../lib/types";

export async function POST(request: NextRequest): Promise<NextResponse<AttachDepositResponse | ErrorResponse>> {
  try {
    const body: AttachDepositRequest = await request.json();
    const { metaGoalId, depositVault, depositId, userAddress } = body;

    if (!metaGoalId || !depositVault || !depositId || !userAddress) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (!isValidAddress(depositVault) || !isValidAddress(userAddress)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }

    // Find meta-goal in database
    const collection = await getMetaGoalsCollection();
    const metaGoal = await collection.findOne({ metaGoalId });

    if (!metaGoal) {
      return NextResponse.json({ error: "Meta-goal not found" }, { status: 404 });
    }

    // Find the correct vault asset for the deposit
    let targetAsset: VaultAsset | null = null;
    for (const [asset, config] of Object.entries(VAULTS)) {
      if (config.address.toLowerCase() === depositVault.toLowerCase()) {
        targetAsset = asset as VaultAsset;
        break;
      }
    }

    if (!targetAsset) {
      return NextResponse.json({ error: "Invalid deposit vault" }, { status: 400 });
    }

    // Get the corresponding on-chain goal ID
    const onChainGoalId = metaGoal.onChainGoals[targetAsset];
    if (!onChainGoalId) {
      return NextResponse.json({ 
        error: `No on-chain goal found for ${targetAsset} vault in this meta-goal` 
      }, { status: 400 });
    }

    // Attach deposit to the correct on-chain goal
    const provider = createProvider();
    const backendWallet = createBackendWallet(provider);
    const goalManager = new ethers.Contract(CONTRACTS.GOAL_MANAGER, GOAL_MANAGER_ABI, backendWallet);

    const attachTx = await goalManager.attachDepositsOnBehalf(
      onChainGoalId,
      userAddress,
      [depositId]
    );

    await attachTx.wait();

    return NextResponse.json({
      success: true,
      metaGoalId,
      attachedToGoalId: onChainGoalId,
      vault: depositVault,
      attachTxHash: attachTx.hash,
    });
  } catch (error) {
    console.error("Attach deposit error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}