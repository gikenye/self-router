import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/database";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<{ success: boolean }>> {
  try {
    const db = await connectToDatabase();
    await db.command({ ping: 1 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DB health check failed:", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
