import { createConfig, http } from 'wagmi'
import { bsc } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { wardenProtocol } from './chains'

export const config = createConfig({
  chains: [wardenProtocol, bsc],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [wardenProtocol.id]: http(),
    [bsc.id]: http(),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
