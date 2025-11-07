import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { CONTRACTS, LEADERBOARD_ABI } from "../../../lib/constants";
import {
  createProvider,
  isValidAddress,
  formatAmountForDisplay,
} from "../../../lib/utils";
import type {
  UserScore,
  LeaderboardResponse,
  ErrorResponse,
  LeaderboardEntry,
} from "../../../lib/types";

export async function GET(
  request: NextRequest
): Promise<NextResponse<UserScore | LeaderboardResponse | ErrorResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get("userAddress");
    const start = searchParams.get("start") || "0";
    const limit = searchParams.get("limit") || "10";

    const provider = createProvider();
    const leaderboard = new ethers.Contract(
      CONTRACTS.LEADERBOARD,
      LEADERBOARD_ABI,
      provider
    );

    // Handle individual user score query
    if (userAddress) {
      if (!isValidAddress(userAddress)) {
        return NextResponse.json(
          { error: "Invalid userAddress" },
          { status: 400 }
        );
      }

      const score = await leaderboard.getUserScore(userAddress);
      const scoreString = score.toString();
      return NextResponse.json({
        userAddress,
        score: scoreString,
        formattedScore: formatAmountForDisplay(scoreString, 18, 2), // Assuming 18 decimals for leaderboard scores
      });
    }

    // Validate pagination parameters
    const startIdx = parseInt(start, 10);
    const limitNum = parseInt(limit, 10);

    if (isNaN(startIdx) || startIdx < 0) {
      return NextResponse.json(
        { error: "Invalid start parameter. Must be a non-negative integer." },
        { status: 400 }
      );
    }

    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return NextResponse.json(
        { error: "Invalid limit parameter. Must be between 1 and 100." },
        { status: 400 }
      );
    }

    // Handle leaderboard range query
    const topLength = await leaderboard.getTopListLength();
    const topLengthNum = Number(topLength);
    const endIdx = Math.min(startIdx + limitNum, topLengthNum);

    if (startIdx >= topLengthNum) {
      return NextResponse.json({
        total: topLength.toString(),
        start: startIdx,
        limit: limitNum,
        data: [],
      });
    }

    const [users, scores] = await leaderboard.getTopRange(startIdx, endIdx);

    const leaderboardData: LeaderboardEntry[] = users.map(
      (address: string, index: number) => {
        const scoreString = scores[index].toString();
        return {
          rank: startIdx + index + 1,
          address,
          score: scoreString,
          formattedScore: formatAmountForDisplay(scoreString, 18, 2), // Assuming 18 decimals for leaderboard scores
        };
      }
    );

    const response: LeaderboardResponse = {
      total: topLength.toString(),
      start: startIdx,
      limit: limitNum,
      data: leaderboardData,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Leaderboard API error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}

// Handle unsupported methods
export async function POST(): Promise<NextResponse<ErrorResponse>> {
  return NextResponse.json(
    { error: "Method not allowed. Use GET." },
    { status: 405 }
  );
}
