import { NextRequest, NextResponse } from "next/server";
import { createProvider } from "../../../lib/utils";
import { getUserXPCollection } from "../../../lib/database";
import { XPService } from "../../../lib/services/xp.service";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get("userAddress");
    const action = searchParams.get("action");

    if (action === "leaderboard") {
      const limit = parseInt(searchParams.get("limit") || "100");
      const collection = await getUserXPCollection();
      const leaderboard = await collection.find({}).sort({ totalXP: -1 }).limit(limit).toArray();
      return NextResponse.json({ leaderboard });
    }

    if (!userAddress) {
      return NextResponse.json({ error: "userAddress required" }, { status: 400 });
    }

    const collection = await getUserXPCollection();
    const userXP = await collection.findOne({ userAddress: userAddress.toLowerCase() });

    return NextResponse.json(userXP || { userAddress: userAddress.toLowerCase(), totalXP: 0, xpHistory: [] });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { metaGoalId } = body;

    if (!metaGoalId) {
      return NextResponse.json({ error: "metaGoalId required" }, { status: 400 });
    }

    const provider = createProvider();
    const xpService = new XPService(provider);
    const result = await xpService.checkAndAwardXP(metaGoalId);

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal server error" }, { status: 500 });
  }
}
