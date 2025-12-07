// Chain configurations
export const CHAINS = {
  CELO: {
    id: 42220,
    name: "Celo",
    rpcUrl: "https://forno.celo.org",
    contracts: {
      GOAL_MANAGER: "0x449095A0e1f16D8Bcc2D140b9284F8006b931231",
      LEADERBOARD: "0x184196a6b0719c3A9d8F15c912467D7836baf50D",
    },
    vaults: {
      USDC: {
        address: "0xBEEf1612958A90F3553362c74Ccdf4c181512cf5",
        asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
        decimals: 6,
      },
      cUSD: {
        address: "0x1077E075c879E8C95E7d0545b106B1448d035F37",
        asset: "0x765de816845861e75a25fca122bb6898b8b1282a",
        decimals: 18,
      },
      USDT: {
        address: "0x90FF972CC2d12Ba495C8aC0887d6E9FD25B032c4",
        asset: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
        decimals: 6,
      },
      cKES: {
        address: "0xfC0a866533ee4B329Cf3843876067C89b5B08479",
        asset: "0x456a3D042C0DbD3db53D5489e98dFb038553B0d0",
        decimals: 18,
      },
    },
  },
} as const;

// Backward compatibility exports
export const CONTRACTS = CHAINS.CELO.contracts;
export const VAULTS = CHAINS.CELO.vaults;
export const DEFAULT_RPC_URL = CHAINS.CELO.rpcUrl;

// Contract ABIs
export const VAULT_ABI = [
  "function allocateOnrampDeposit(address user, uint256 amount, bytes32 txHash) external returns (uint256)",
  "function deposits(address user, uint256 index) external view returns (uint256 shares, uint256 principal, uint256 depositTime, uint256 lockEnd, bool pledgedAsCollateral)",
  "function depositCount(address user) external view returns (uint256)",
  "event OnrampDeposit(address indexed user, uint256 indexed depositId, uint256 amount, uint256 shares, bytes32 indexed txHash)",
  "event Deposited(address indexed user, uint256 indexed depositId, uint256 amount, uint256 shares, uint256 lockTier)",
];

export const GOAL_MANAGER_ABI = [
  "function getQuicksaveGoal(address vault, address user) external view returns (uint256)",
  "function createGoal(address vault, uint256 targetAmount, uint256 targetDate, string calldata metadataURI) external returns (uint256)",
  "function createGoalFor(address creator, address vault, uint256 targetAmount, uint256 targetDate, string calldata metadataURI) external returns (uint256)",
  "function createQuicksaveGoalFor(address user, address vault) external returns (uint256)",
  "function attachDeposits(uint256 goalId, uint256[] calldata depositIds) external",
  "function cancelGoal(uint256 goalId) external",
  "function attachDepositsOnBehalf(uint256 goalId, address owner, uint256[] calldata depositIds) external",
  "function goals(uint256) external view returns (uint256 id, address creator, address vault, uint256 targetAmount, uint256 targetDate, string metadataURI, uint256 createdAt, bool cancelled, bool completed)",
  "function getGoalProgressFull(uint256 goalId) external view returns (uint256 totalValue, uint256 percentBps)",
  "function attachmentCount(uint256 goalId) external view returns (uint256)",
  "function attachmentAt(uint256 goalId, uint256 index) external view returns (tuple(address owner, uint256 depositId, uint256 attachedAt, bool pledged))",
  "function depositToGoal(bytes32 key) external view returns (uint256)",
  "event GoalCreated(uint256 indexed goalId, address indexed creator, address indexed vault, uint256 targetAmount, uint256 targetDate, string metadataURI)",
  "event GoalCancelled(uint256 indexed goalId)",

];

export const LEADERBOARD_ABI = [
  "function recordDepositOnBehalf(address user, uint256 amount) external",
  "function getUserScore(address user) external view returns (uint256)",
  "function getTopListLength() external view returns (uint256)",
  "function getTopRange(uint256 start, uint256 end) external view returns (address[] users, uint256[] userScores)",
  "function scores(address user) external view returns (uint256)",
  "function topList(uint256 index) external view returns (address)",
];

// Leaderboard score decimals - based on USDC (6 decimals) as the base scoring unit
export const LEADERBOARD_DECIMALS = 6;
