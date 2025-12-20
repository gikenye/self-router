import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const metaGoalId = url.searchParams.get("id");
  const invitedBy = url.searchParams.get("invitedBy");

  if (!metaGoalId || typeof metaGoalId !== 'string' || metaGoalId.trim().length === 0 || metaGoalId.length > 100) {
    return NextResponse.json({ error: "Invalid metaGoalId" }, { status: 400 });
  }

  const redirectUrl = new URL(`${url.origin}/goals/${metaGoalId.trim()}`);
  if (invitedBy) {
    redirectUrl.searchParams.set("invitedBy", invitedBy);
  }

  return NextResponse.redirect(redirectUrl.toString());
}
