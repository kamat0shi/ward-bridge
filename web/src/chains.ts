import { createPublicClient, fallback, http, type Chain } from 'viem'
import { bsc as bscChain } from 'viem/chains'

export const wardenProtocol = {
  id: 8765,
  name: 'Warden Protocol',
  nativeCurrency: { name: 'WARD', symbol: 'WARD', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://evm.wardenprotocol.org'] },
  },
  blockExplorers: {
    default: { name: 'Warden Explorer', url: 'https://explorer.wardenprotocol.org' },
  },
} as const satisfies Chain

export const HYPERLANE_DEST_BSC = 56
export const ROUTER_ADDRESS = '0xAB5159B5655CdAA5178C283853841aBB0D02Eef9' as const
export const HYPERLANE_EXPLORER = 'https://explorer.hyperlane.xyz'

export const BSC_MAILBOX = '0x15eecb285aae883fcff1c3f38552eb9d64ebcb7d' as const
export const BSC_WARP_TOKEN = '0x6dc200b21894Af4660b549B678ea8df22BF7cfAc' as const
export const BSC_EXPLORER = 'https://bscscan.com'

export const bscClient = createPublicClient({
  chain: bscChain,
  transport: fallback([
    http('https://bsc-dataseed.binance.org'),
    http('https://bsc-rpc.publicnode.com'),
    http('https://rpc.ankr.com/bsc'),
  ]),
})

export const wardenClient = createPublicClient({
  chain: wardenProtocol,
  transport: http(),
})

export const WARDEN_MAILBOX = '0x15eecb285aae883fcff1c3f38552eb9d64ebcb7d' as const
export const WARDEN_MERKLE_HOOK = '0x2719d412dEcF46dbeb3C478e9099Ab16E53D9fb2' as const

export const VALIDATORS = [
  {
    addr: '0x49cf57fe281fa67b08a156fe4e212d44e1cc5762' as const,
    base: 'https://hyperlane-validator-signatures-liveraven-warden.s3.eu-central-1.amazonaws.com/',
    prefix: 'wardenprotocol/',
  },
  {
    addr: '0x68c35338a78fbf1dc7aa8e6f8435230b4704a243' as const,
    base: 'https://hyperlane-validator-signatures-cryptosjnet-warden-warden.s3.us-east-1.amazonaws.com/',
    prefix: '',
  },
  {
    addr: '0xb117f78749c6a59eb778e9e6920650ee74d1ed83' as const,
    base: 'https://mainnet-hyperlane-validator.s3.eu-west-1.amazonaws.com/',
    prefix: 'signatures-mainnet-warden/',
  },
  {
    addr: '0xec554f998d57aeae5916bd3bbfa255df8428b2ba' as const,
    base: 'https://eq-hyperlane-validator.s3.eu-west-1.amazonaws.com/',
    prefix: 'signatures-warden/',
  },
] as const

export const MULTISIG_THRESHOLD = 2

export const MAILBOX_ABI = [
  {
    type: 'function',
    name: 'process',
    stateMutability: 'payable',
    inputs: [
      { name: 'metadata', type: 'bytes' },
      { name: 'message', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'delivered',
    stateMutability: 'view',
    inputs: [{ name: 'messageId', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Dispatch',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'destination', type: 'uint32', indexed: true },
      { name: 'recipient', type: 'bytes32', indexed: true },
      { name: 'message', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DispatchId',
    inputs: [{ name: 'messageId', type: 'bytes32', indexed: true }],
  },
] as const

export const MERKLE_HOOK_ABI = [
  {
    type: 'event',
    name: 'InsertedIntoTree',
    inputs: [
      { name: 'messageId', type: 'bytes32', indexed: false },
      { name: 'index', type: 'uint32', indexed: false },
    ],
  },
] as const
