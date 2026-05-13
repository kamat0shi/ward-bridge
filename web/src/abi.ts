export const ROUTER_ABI = [
  {
    type: 'function',
    name: 'transferRemote',
    stateMutability: 'payable',
    inputs: [
      { name: 'destination', type: 'uint32' },
      { name: 'recipient', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'quoteGasPayment',
    stateMutability: 'view',
    inputs: [{ name: 'destination', type: 'uint32' }],
    outputs: [{ type: 'uint256' }],
  },
] as const
