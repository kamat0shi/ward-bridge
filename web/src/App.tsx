import { useState } from 'react'
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { bsc as bscChain } from 'viem/chains'
import { ROUTER_ADDRESS, wardenProtocol } from './chains'
import { BridgeForm } from './BridgeForm'
import { ClaimForm } from './ClaimForm'

type Tab = 'send' | 'claim'

export default function App() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { connectors, connect, isPending: isConnecting, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: isSwitching, error: switchError } = useSwitchChain()
  const [tab, setTab] = useState<Tab>('send')

  const injectedConnector = connectors.find((c) => c.id === 'injected')
  const requiredChain = tab === 'send' ? wardenProtocol.id : bscChain.id
  const requiredChainName = tab === 'send' ? 'Warden Protocol' : 'BSC'
  const onWrongChain = tab === 'send' && isConnected && chainId !== wardenProtocol.id

  return (
    <main className="container">
      <header>
        <h1>WARD ↔ BSC bridge</h1>
        <p className="subtitle">
          Отправка через Hyperlane warp route + ручной claim если автоматический relayer не доставил message.
          Подписание идёт в вашем кошельке — приватный ключ остаётся в браузере.
        </p>
      </header>

      {!isConnected ? (
        <button
          className="primary"
          disabled={!injectedConnector || isConnecting}
          onClick={() => injectedConnector && connect({ connector: injectedConnector })}
        >
          {isConnecting
            ? 'Подключаемся…'
            : injectedConnector
              ? 'Подключить кошелёк'
              : 'Кошелёк не найден (установите MetaMask/Rabby)'}
        </button>
      ) : (
        <div className="account">
          <span className="addr">{address}</span>
          <button className="ghost" onClick={() => disconnect()}>Отключить</button>
        </div>
      )}

      {connectError && <div className="error">{connectError.message}</div>}

      {isConnected && (
        <>
          <div className="tabs">
            <button
              className={`tab ${tab === 'send' ? 'active' : ''}`}
              onClick={() => setTab('send')}
            >
              1. Отправить WARD → BSC
            </button>
            <button
              className={`tab ${tab === 'claim' ? 'active' : ''}`}
              onClick={() => setTab('claim')}
            >
              2. Ручной claim
            </button>
          </div>

          {onWrongChain && tab === 'send' && (
            <div className="warn">
              <p>
                Для отправки нужна сеть {requiredChainName} (chainId {requiredChain}). Текущая:{' '}
                {chainId}.
              </p>
              <button
                className="primary"
                disabled={isSwitching}
                onClick={() => switchChain({ chainId: wardenProtocol.id })}
              >
                {isSwitching ? 'Переключаем…' : `Переключить на ${requiredChainName}`}
              </button>
              {switchError && <div className="error">{switchError.message}</div>}
            </div>
          )}

          {tab === 'send' && !onWrongChain && <BridgeForm />}
          {tab === 'claim' && <ClaimForm />}
        </>
      )}

      <footer>
        <small>
          Router: <code>{ROUTER_ADDRESS}</code>
        </small>
      </footer>
    </main>
  )
}
