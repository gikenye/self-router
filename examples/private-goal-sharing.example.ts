/**
 * Private Goal Sharing - Usage Examples
 */

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// Example 1: Create a private goal
async function createPrivateGoal() {
  const response = await fetch(`${BASE_URL}/api/user-positions?action=create-group-goal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Family Vacation Savings",
      targetAmountUSD: 5000,
      targetDate: "2025-12-31",
      creatorAddress: "0xCreatorAddress",
      vaults: "all",
      isPublic: false,
    }),
  });

  const data = await response.json();
  return data.metaGoalId;
}

// Example 2: Invite users to a private goal
async function inviteUsersToGoal(metaGoalId: string) {
  const response = await fetch(`${BASE_URL}/api/user-positions?action=invite-to-goal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      metaGoalId,
      inviterAddress: "0xCreatorAddress",
      inviteeAddresses: ["0xFriend1", "0xFriend2", "0xFamily1"],
    }),
  });

  const data = await response.json();
  return data.shareLink;
}

// Example 3: View private goal details
async function viewPrivateGoal(metaGoalId: string, userAddress: string) {
  const response = await fetch(`${BASE_URL}/api/goals/${metaGoalId}?userAddress=${userAddress}`);
  if (response.status === 403) return null;
  return await response.json();
}

// Example 4: Get user's groups
async function getMyGroups(userAddress: string) {
  const response = await fetch(`${BASE_URL}/api/user-positions?action=my-groups&userAddress=${userAddress}`);
  return await response.json();
}

export { createPrivateGoal, inviteUsersToGoal, viewPrivateGoal, getMyGroups };
