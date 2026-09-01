import { createConfig, http } from 'wagmi'
import { base, bsc } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { wardenProtocol } from './chains'

export const config = createConfig({
  chains: [wardenProtocol, base, bsc],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [wardenProtocol.id]: http(),
    [base.id]: http(),
    [bsc.id]: http(),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
