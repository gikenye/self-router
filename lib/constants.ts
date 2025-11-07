// Smart contract addresses
export const CONTRACTS = {
  GOAL_MANAGER: "0x449095A0e1f16D8Bcc2D140b9284F8006b931231",
  LEADERBOARD: "0x184196a6b0719c3A9d8F15c912467D7836baf50D",
} as const;

// Vault configurations
export const VAULTS = {
  USDC: {
    address: "0xBEEf1612958A90F3553362c74Ccdf4c181512cf5",
    asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  },
  cUSD: {
    address: "0x1077E075c879E8C95E7d0545b106B1448d035F37",
    asset: "0x765de816845861e75a25fca122bb6898b8b1282a",
  },
  USDT: {
    address: "0x90FF972CC2d12Ba495C8aC0887d6E9FD25B032c4",
    asset: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  },
  cKES: {
    address: "0xfC0a866533ee4B329Cf3843876067C89b5B08479",
    asset: "0x456a3D042C0DbD3db53D5489e98dFb038553B0d0",
  },
} as const;

// Contract ABIs
export const VAULT_ABI = [
  "function allocateOnrampDeposit(address user, uint256 amount, bytes32 txHash) external returns (uint256)",
  "event OnrampDeposit(address indexed user, uint256 indexed depositId, uint256 amount, uint256 shares, bytes32 indexed txHash)",
];

export const GOAL_MANAGER_ABI = [
  "function getQuicksaveGoal(address vault, address user) external view returns (uint256)",
  "function createGoal(address vault, uint256 targetAmount, uint256 targetDate, string calldata metadataURI) external returns (uint256)",
  "function attachDeposits(uint256 goalId, uint256[] calldata depositIds) external",
  "function goals(uint256) external view returns (uint256 id, address creator, address vault, uint256 targetAmount, uint256 targetDate, string metadataURI, uint256 createdAt, bool cancelled, bool completed)",
  "function getGoalProgressFull(uint256 goalId) external view returns (uint256 totalValue, uint256 percentBps)",
  "function attachmentCount(uint256 goalId) external view returns (uint256)",
  "function attachmentAt(uint256 goalId, uint256 index) external view returns (tuple(address owner, uint256 depositId, uint256 attachedAt, bool pledged))",
  "event GoalCreated(uint256 indexed goalId, address indexed creator, address indexed vault, uint256 targetAmount, uint256 targetDate, string metadataURI)",
];

export const LEADERBOARD_ABI = [
  "function recordDepositOnBehalf(address user, uint256 amount) external",
  "function getUserScore(address user) external view returns (uint256)",
  "function getTopListLength() external view returns (uint256)",
  "function getTopRange(uint256 start, uint256 end) external view returns (address[] users, uint256[] userScores)",
];

// Default RPC URL
export const DEFAULT_RPC_URL = "https://forno.celo.org";
