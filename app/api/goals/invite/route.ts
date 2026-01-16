import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import type { Db } from "mongodb";
import { connectToDatabase, getMetaGoalsCollection } from "../../../../lib/database";
import { isValidAddress } from "../../../../lib/utils";
import type { ErrorResponse } from "../../../../lib/types";

function buildInviteMessage(params: {
  metaGoalId: string;
  invitedAddress: string;
  inviterAddress: string;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    "Invite to goal",
    `metaGoalId: ${params.metaGoalId}`,
    `invitedAddress: ${params.invitedAddress}`,
    `inviterAddress: ${params.inviterAddress}`,
    `nonce: ${params.nonce}`,
    `issuedAt: ${params.issuedAt}`,
  ].join("\n");
}

async function isKnownUser(db: Db, address: string): Promise<boolean> {
  const normalizedAddress = address.toLowerCase();
  const user = await db
    .collection("users")
    .findOne({ address: normalizedAddress }, { projection: { _id: 1 } });

  return Boolean(user);
}

type InviteNonce = {
  metaGoalId: string;
  inviterAddress: string;
  invitedAddress: string;
  nonce: string;
  issuedAt: string;
  expiresAt: Date;
  createdAt: Date;
};

async function consumeInviteNonce(
  db: Db,
  params: {
    metaGoalId: string;
    inviterAddress: string;
    invitedAddress: string;
    nonce: string;
    issuedAt: string;
  }
): Promise<{ valid: boolean; error?: string }> {
  const collection = db.collection<InviteNonce>("invite_nonces");
  const value = await collection.findOneAndDelete({
    metaGoalId: params.metaGoalId,
    inviterAddress: params.inviterAddress,
    invitedAddress: params.invitedAddress,
    nonce: params.nonce,
    issuedAt: params.issuedAt,
  });

  if (!value) {
    return { valid: false, error: "Invalid or used nonce" };
  }

  if (value.expiresAt.getTime() <= Date.now()) {
    return { valid: false, error: "Nonce expired" };
  }

  return { valid: true };
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<{ success: boolean } | ErrorResponse>> {
  try {
    const {
      metaGoalId,
      invitedAddress,
      inviterAddress,
      signature,
      issuedAt,
      nonce,
    } = await request.json();

    if (
      !metaGoalId ||
      !invitedAddress ||
      !inviterAddress ||
      !signature ||
      !issuedAt ||
      !nonce
    ) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (typeof metaGoalId !== "string" || metaGoalId.length > 100) {
      return NextResponse.json({ error: "Invalid metaGoalId" }, { status: 400 });
    }

    if (
      typeof invitedAddress !== "string" ||
      typeof inviterAddress !== "string" ||
      typeof signature !== "string" ||
      typeof issuedAt !== "string" ||
      typeof nonce !== "string"
    ) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }

    if (!isValidAddress(invitedAddress) || !isValidAddress(inviterAddress)) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }

    if (nonce.length > 128) {
      return NextResponse.json({ error: "Invalid nonce" }, { status: 400 });
    }

    const issuedAtMs = Date.parse(issuedAt);
    if (Number.isNaN(issuedAtMs)) {
      return NextResponse.json({ error: "Invalid issuedAt" }, { status: 400 });
    }

    const collection = await getMetaGoalsCollection();
    const metaGoal = await collection.findOne({ metaGoalId });

    if (!metaGoal) {
      return NextResponse.json({ error: "Goal not found" }, { status: 404 });
    }

    const normalizedInviter = inviterAddress.toLowerCase();
    const normalizedInvited = invitedAddress.toLowerCase();
    const participants = (metaGoal.participants || []).map((participant) =>
      participant.toLowerCase()
    );
    const invitedUsers = (metaGoal.invitedUsers || []).map((invited) =>
      invited.toLowerCase()
    );
    const isCreator =
      metaGoal.creatorAddress.toLowerCase() === normalizedInviter;
    const isParticipant = participants.includes(normalizedInviter);

    if (!isCreator && !isParticipant) {
      return NextResponse.json(
        { error: "Only group members can invite users" },
        { status: 403 }
      );
    }

    // Signature binds inviter; nonce prevents replay.
    const expectedMessage = buildInviteMessage({
      metaGoalId,
      invitedAddress: normalizedInvited,
      inviterAddress: normalizedInviter,
      nonce,
      issuedAt,
    });

    try {
      const recovered = ethers.verifyMessage(expectedMessage, signature);
      if (recovered.toLowerCase() !== normalizedInviter) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    } catch (signatureError) {
      console.warn("Invite signature verification failed:", signatureError);
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const db = await connectToDatabase();
    const [inviterExists, invitedExists] = await Promise.all([
      isKnownUser(db, normalizedInviter),
      isKnownUser(db, normalizedInvited),
    ]);

    if (!inviterExists) {
      return NextResponse.json({ error: "Inviter not found" }, { status: 403 });
    }

    if (!invitedExists) {
      return NextResponse.json({ error: "Invited user not found" }, { status: 404 });
    }

    const nonceStatus = await consumeInviteNonce(db, {
      metaGoalId,
      inviterAddress: normalizedInviter,
      invitedAddress: normalizedInvited,
      nonce,
      issuedAt,
    });

    if (!nonceStatus.valid) {
      return NextResponse.json(
        { error: nonceStatus.error || "Invalid nonce" },
        { status: 401 }
      );
    }

    if (
      participants.includes(normalizedInvited) ||
      invitedUsers.includes(normalizedInvited)
    ) {
      return NextResponse.json({ success: true });
    }

    await collection.updateOne(
      { metaGoalId },
      {
        $addToSet: { invitedUsers: normalizedInvited },
        $set: { updatedAt: new Date().toISOString() },
      }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Invite user error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
