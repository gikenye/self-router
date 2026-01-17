import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { CONTRACTS, GOAL_MANAGER_ABI, VAULTS, VAULT_ABI } from "../../../lib/constants";
import { createProvider, formatAmountForDisplay } from "../../../lib/utils";
import { RequestValidator } from "../../../lib/validators/request.validator";
import type {
  ActivityItem,
  ActivityResponse,
  DepositActivity,
  DepositAttachmentActivity,
  ErrorResponse,
  GoalCreatedActivity,
  MemberInviteActivity,
  MemberStatusActivity,
  VaultAsset,
} from "../../../lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_LOOKBACK_BLOCKS = -5000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type BaseActivity = {
  id: string;
  txHash: string;
  blockNumber: number;
  timestamp: string;
  logIndex: number;
};

type ActivityWithLogIndex = {
  item: ActivityItem;
  logIndex: number;
};

function resolveBlockNumber(
  value: string | null,
  latestBlock: number,
  fallbackOffset: number,
  label: string
): { value?: number; error?: string } {
  if (!value) {
    return { value: Math.max(0, latestBlock + fallbackOffset) };
  }

  if (value === "latest") {
    return { value: latestBlock };
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return { error: `Invalid ${label} parameter. Must be an integer or "latest".` };
  }

  const resolved = parsed < 0 ? latestBlock + parsed : parsed;
  return { value: Math.max(0, resolved) };
}

function resolveVaultMetadata(vaultAddress: string): { asset: VaultAsset; decimals: number } | null {
  const target = vaultAddress.toLowerCase();
  for (const [asset, config] of Object.entries(VAULTS)) {
    if (config.address.toLowerCase() === target) {
      return { asset: asset as VaultAsset, decimals: config.decimals };
    }
  }
  return null;
}

function isEventLog(event: ethers.Log | ethers.EventLog): event is ethers.EventLog {
  return "args" in event && "eventName" in event;
}

function toIsoTimestamp(seconds?: bigint | number | null): string | undefined {
  if (seconds === null || seconds === undefined) {
    return undefined;
  }
  const parsed = typeof seconds === "bigint" ? Number(seconds) : seconds;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return new Date(parsed * 1000).toISOString();
}

export async function GET(
  request: NextRequest
): Promise<NextResponse<ActivityResponse | ErrorResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const userAddress = searchParams.get("userAddress");

    const validation = RequestValidator.validateUserAddress(userAddress);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error! }, { status: 400 });
    }

    const limitParam = searchParams.get("limit");
    const limit = Number.parseInt(limitParam || String(DEFAULT_LIMIT), 10);
    if (Number.isNaN(limit) || limit < 1 || limit > MAX_LIMIT) {
      return NextResponse.json(
        { error: `Invalid limit parameter. Must be between 1 and ${MAX_LIMIT}.` },
        { status: 400 }
      );
    }

    const provider = createProvider();
    const latestBlock = await provider.getBlockNumber();

    const fromBlockResult = resolveBlockNumber(
      searchParams.get("fromBlock"),
      latestBlock,
      DEFAULT_LOOKBACK_BLOCKS,
      "fromBlock"
    );
    if (fromBlockResult.error) {
      return NextResponse.json({ error: fromBlockResult.error }, { status: 400 });
    }

    const toBlockResult = resolveBlockNumber(
      searchParams.get("toBlock"),
      latestBlock,
      0,
      "toBlock"
    );
    if (toBlockResult.error) {
      return NextResponse.json({ error: toBlockResult.error }, { status: 400 });
    }

    const startBlock = fromBlockResult.value!;
    const endBlock = Math.min(toBlockResult.value!, latestBlock);

    if (startBlock > endBlock) {
      return NextResponse.json(
        { error: "fromBlock must be less than or equal to toBlock." },
        { status: 400 }
      );
    }

    const normalizedAddress = userAddress!.toLowerCase();
    const goalManager = new ethers.Contract(
      CONTRACTS.GOAL_MANAGER,
      GOAL_MANAGER_ABI,
      provider
    );

    const blockTimestampCache = new Map<number, string>();
    const getBlockTimestamp = async (blockNumber: number): Promise<string> => {
      const cached = blockTimestampCache.get(blockNumber);
      if (cached) {
        return cached;
      }
      const block = await provider.getBlock(blockNumber);
      const timestamp = block
        ? new Date(block.timestamp * 1000).toISOString()
        : new Date(0).toISOString();
      blockTimestampCache.set(blockNumber, timestamp);
      return timestamp;
    };

    const buildBase = async (
      event: ethers.Log | ethers.EventLog
    ): Promise<BaseActivity | null> => {
      if (event.blockNumber === null || event.blockNumber === undefined || !event.transactionHash) {
        return null;
      }
      const timestamp = await getBlockTimestamp(event.blockNumber);
      const logIndex = (event as { logIndex?: number }).logIndex ?? 0;
      return {
        id: `${event.transactionHash}:${logIndex}`,
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        timestamp,
        logIndex,
      };
    };

    const [
      goalCreatedEvents,
      depositAttachedEvents,
      depositDetachedEvents,
      attachmentPledgedEvents,
      memberInvitedEvents,
      memberInvitedToEvents,
      inviteRevokedEvents,
      inviteRevokedForEvents,
      memberJoinedEvents,
      memberRemovedEvents,
    ] = await Promise.all([
      goalManager.queryFilter(
        goalManager.filters.GoalCreated(null, normalizedAddress, null),
        startBlock,
        endBlock
      ),
      goalManager.queryFilter(
        goalManager.filters.DepositAttached(null, normalizedAddress, null),
        startBlock,
        endBlock
      ),
      goalManager.queryFilter(
        goalManager.filters.DepositDetached(null, normalizedAddress, null),
        startBlock,
        endBlock
      ),
      goalManager.queryFilter(
        goalManager.filters.AttachmentPledged(null, normalizedAddress, null),
        startBlock,
        endBlock
      ),
      goalManager.queryFilter(
        goalManager.filters.MemberInvited(null, normalizedAddress, null),
        startBlock,
        endBlock
      ),
      goalManager.queryFilter(
        goalManager.filters.MemberInvited(null, null, normalizedAddress),
        startBlock,
        endBlock
      ),
      goalManager.queryFilter(
        goalManager.filters.InviteRevoked(null, normalizedAddress, null),
        startBlock,
        endBlock
      ),
      goalManager.queryFilter(
        goalManager.filters.InviteRevoked(null, null, normalizedAddress),
        startBlock,
        endBlock
      ),
      goalManager.queryFilter(
        goalManager.filters.MemberJoined(null, normalizedAddress),
        startBlock,
        endBlock
      ),
      goalManager.queryFilter(
        goalManager.filters.MemberRemoved(null, normalizedAddress),
        startBlock,
        endBlock
      ),
    ]);

    const vaultEvents = await Promise.all(
      Object.entries(VAULTS).map(async ([asset, vaultConfig]) => {
        const vault = new ethers.Contract(vaultConfig.address, VAULT_ABI, provider);
        const [onrampEvents, depositedEvents] = await Promise.all([
          vault.queryFilter(
            vault.filters.OnrampDeposit(normalizedAddress, null, null),
            startBlock,
            endBlock
          ),
          vault.queryFilter(
            vault.filters.Deposited(normalizedAddress, null),
            startBlock,
            endBlock
          ),
        ]);

        return { asset, vaultConfig, onrampEvents, depositedEvents };
      })
    );

    const activityPromises: Array<Promise<ActivityWithLogIndex | null>> = [];

    for (const event of goalCreatedEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            vault: string;
            targetAmount: bigint;
            targetDate: bigint;
            metadataURI: string;
          };
          const vaultMetadata = resolveVaultMetadata(args.vault);
          const targetAmountWei = args.targetAmount?.toString?.() || "0";
          const targetAmountUSD = vaultMetadata
            ? formatAmountForDisplay(targetAmountWei, vaultMetadata.decimals)
            : "0";
          const targetDateSeconds = Number(args.targetDate || 0);
          const targetDate = Number.isFinite(targetDateSeconds) && targetDateSeconds > 0
            ? new Date(targetDateSeconds * 1000).toISOString()
            : "";

          const { logIndex, ...baseItem } = base;
          const item: GoalCreatedActivity = {
            ...baseItem,
            type: "goal_created",
            goalId: args.goalId?.toString?.() || "",
            vault: args.vault,
            asset: vaultMetadata?.asset ?? null,
            targetAmountWei,
            targetAmountUSD,
            targetDate,
            metadataURI: args.metadataURI || "",
          };

          return { item, logIndex };
        })()
      );
    }

    for (const event of depositAttachedEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            depositId: bigint;
            attachedAt: bigint;
          };
          const { logIndex, ...baseItem } = base;
          const item: DepositAttachmentActivity = {
            ...baseItem,
            type: "deposit_attached",
            goalId: args.goalId?.toString?.() || "",
            depositId: args.depositId?.toString?.() || "",
            attachedAt: toIsoTimestamp(args.attachedAt),
          };
          return { item, logIndex };
        })()
      );
    }

    for (const event of depositDetachedEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            depositId: bigint;
            detachedAt: bigint;
          };
          const { logIndex, ...baseItem } = base;
          const item: DepositAttachmentActivity = {
            ...baseItem,
            type: "deposit_detached",
            goalId: args.goalId?.toString?.() || "",
            depositId: args.depositId?.toString?.() || "",
            detachedAt: toIsoTimestamp(args.detachedAt),
          };
          return { item, logIndex };
        })()
      );
    }

    for (const event of attachmentPledgedEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            depositId: bigint;
          };
          const { logIndex, ...baseItem } = base;
          const item: DepositAttachmentActivity = {
            ...baseItem,
            type: "attachment_pledged",
            goalId: args.goalId?.toString?.() || "",
            depositId: args.depositId?.toString?.() || "",
          };
          return { item, logIndex };
        })()
      );
    }

    for (const event of memberInvitedEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            inviter: string;
            invitee: string;
          };
          const inviter = args.inviter?.toLowerCase?.() || "";
          const invitee = args.invitee?.toLowerCase?.() || "";
          const { logIndex, ...baseItem } = base;
          const item: MemberInviteActivity = {
            ...baseItem,
            type: "member_invited",
            goalId: args.goalId?.toString?.() || "",
            inviter,
            invitee,
            role: inviter === normalizedAddress ? "inviter" : "invitee",
          };
          return { item, logIndex };
        })()
      );
    }

    for (const event of memberInvitedToEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            inviter: string;
            invitee: string;
          };
          const inviter = args.inviter?.toLowerCase?.() || "";
          const invitee = args.invitee?.toLowerCase?.() || "";
          const { logIndex, ...baseItem } = base;
          const item: MemberInviteActivity = {
            ...baseItem,
            type: "member_invited",
            goalId: args.goalId?.toString?.() || "",
            inviter,
            invitee,
            role: inviter === normalizedAddress ? "inviter" : "invitee",
          };
          return { item, logIndex };
        })()
      );
    }

    for (const event of inviteRevokedEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            revoker: string;
            invitee: string;
          };
          const revoker = args.revoker?.toLowerCase?.() || "";
          const invitee = args.invitee?.toLowerCase?.() || "";
          const { logIndex, ...baseItem } = base;
          const item: MemberInviteActivity = {
            ...baseItem,
            type: "invite_revoked",
            goalId: args.goalId?.toString?.() || "",
            inviter: revoker,
            invitee,
            role: revoker === normalizedAddress ? "inviter" : "invitee",
          };
          return { item, logIndex };
        })()
      );
    }

    for (const event of inviteRevokedForEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            revoker: string;
            invitee: string;
          };
          const revoker = args.revoker?.toLowerCase?.() || "";
          const invitee = args.invitee?.toLowerCase?.() || "";
          const { logIndex, ...baseItem } = base;
          const item: MemberInviteActivity = {
            ...baseItem,
            type: "invite_revoked",
            goalId: args.goalId?.toString?.() || "",
            inviter: revoker,
            invitee,
            role: revoker === normalizedAddress ? "inviter" : "invitee",
          };
          return { item, logIndex };
        })()
      );
    }

    for (const event of memberJoinedEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            member: string;
          };
          const { logIndex, ...baseItem } = base;
          const item: MemberStatusActivity = {
            ...baseItem,
            type: "member_joined",
            goalId: args.goalId?.toString?.() || "",
            member: args.member?.toLowerCase?.() || "",
          };
          return { item, logIndex };
        })()
      );
    }

    for (const event of memberRemovedEvents) {
      activityPromises.push(
        (async (): Promise<ActivityWithLogIndex | null> => {
          const base = await buildBase(event);
          if (!base || !isEventLog(event) || !event.args) {
            return null;
          }

          const args = event.args as unknown as {
            goalId: bigint;
            member: string;
          };
          const { logIndex, ...baseItem } = base;
          const item: MemberStatusActivity = {
            ...baseItem,
            type: "member_removed",
            goalId: args.goalId?.toString?.() || "",
            member: args.member?.toLowerCase?.() || "",
          };
          return { item, logIndex };
        })()
      );
    }

    for (const { asset, vaultConfig, onrampEvents, depositedEvents } of vaultEvents) {
      for (const event of onrampEvents) {
        activityPromises.push(
          (async (): Promise<ActivityWithLogIndex | null> => {
            const base = await buildBase(event);
            if (!base || !isEventLog(event) || !event.args) {
              return null;
            }

            const args = event.args as unknown as {
              depositId: bigint;
              amount: bigint;
              shares: bigint;
              txHash: string;
            };
            const amountWei = args.amount?.toString?.() || "0";
            const sharesWei = args.shares?.toString?.() || "0";
            const { logIndex, ...baseItem } = base;
            const item: DepositActivity = {
              ...baseItem,
              type: "deposit",
              vault: vaultConfig.address,
              asset: asset as VaultAsset,
              depositId: args.depositId?.toString?.() || "",
              amountWei,
              amountUSD: formatAmountForDisplay(amountWei, vaultConfig.decimals),
              sharesWei,
              sharesUSD: formatAmountForDisplay(sharesWei, vaultConfig.decimals),
              source: "onramp",
              onrampTxHash: args.txHash ? String(args.txHash) : undefined,
            };
            return { item, logIndex };
          })()
        );
      }

      for (const event of depositedEvents) {
        activityPromises.push(
          (async (): Promise<ActivityWithLogIndex | null> => {
            const base = await buildBase(event);
            if (!base || !isEventLog(event) || !event.args) {
              return null;
            }

            const args = event.args as unknown as {
              depositId: bigint;
              amount: bigint;
              shares: bigint;
              lockTier: bigint;
            };
            const amountWei = args.amount?.toString?.() || "0";
            const sharesWei = args.shares?.toString?.() || "0";
            const { logIndex, ...baseItem } = base;
            const item: DepositActivity = {
              ...baseItem,
              type: "deposit",
              vault: vaultConfig.address,
              asset: asset as VaultAsset,
              depositId: args.depositId?.toString?.() || "",
              amountWei,
              amountUSD: formatAmountForDisplay(amountWei, vaultConfig.decimals),
              sharesWei,
              sharesUSD: formatAmountForDisplay(sharesWei, vaultConfig.decimals),
              lockTier: args.lockTier?.toString?.() || "0",
              source: "direct",
            };
            return { item, logIndex };
          })()
        );
      }
    }

    const activitiesWithIndex = (await Promise.all(activityPromises)).filter(
      (item): item is ActivityWithLogIndex => Boolean(item)
    );

    activitiesWithIndex.sort((a, b) => {
      if (a.item.blockNumber !== b.item.blockNumber) {
        return b.item.blockNumber - a.item.blockNumber;
      }
      return b.logIndex - a.logIndex;
    });

    const activities = activitiesWithIndex.slice(0, limit).map(({ item }) => item);

    const response: ActivityResponse = {
      userAddress: normalizedAddress,
      startBlock,
      endBlock,
      limit,
      activities,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Activity API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
