import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  useAccount,
  useBalance,
  useConfig,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { readContract, simulateContract } from 'wagmi/actions'
import {
  BaseError,
  ContractFunctionRevertedError,
  formatEther,
  isAddress,
  pad,
  parseAbiItem,
  parseEther,
} from 'viem'
import { ROUTER_ABI } from './abi'
import { HashRow } from './HashRow'
import {
  BSC_EXPLORER,
  BSC_MAILBOX,
  BSC_WARP_TOKEN,
  bscClient,
  HYPERLANE_DEST_BSC,
  HYPERLANE_EXPLORER,
  ROUTER_ADDRESS,
  wardenProtocol,
} from './chains'

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const HEALTH_LOOKBACK = 2000n

function extractRevert(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.shortMessage + (revert.reason ? ` — ${revert.reason}` : '')
    }
    return err.shortMessage
  }
  return err instanceof Error ? err.message : String(err)
}

type DeliveryTarget = {
  recipient: `0x${string}`
  amount: bigint
  fromBlock: bigint
}

export function BridgeForm() {
  const { address } = useAccount()
  const config = useConfig()
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [simError, setSimError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [healthCheckEnabled, setHealthCheckEnabled] = useState(true)
  const [target, setTarget] = useState<DeliveryTarget | null>(null)

  const { data: balance } = useBalance({
    address,
    chainId: wardenProtocol.id,
    query: { refetchInterval: 12_000 },
  })

  const { data: quote, isLoading: quoteLoading } = useReadContract({
    address: ROUTER_ADDRESS,
    abi: ROUTER_ABI,
    functionName: 'quoteGasPayment',
    args: [HYPERLANE_DEST_BSC],
    chainId: wardenProtocol.id,
    query: { refetchInterval: 12_000 },
  })

  const healthQuery = useQuery({
    queryKey: ['bsc-mailbox-health'],
    enabled: healthCheckEnabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const block = await bscClient.getBlockNumber()
      const fromBlock = block > HEALTH_LOOKBACK ? block - HEALTH_LOOKBACK : 0n
      const logs = await bscClient.getLogs({
        address: BSC_MAILBOX,
        fromBlock,
        toBlock: block,
      })
      return {
        block,
        lookbackBlocks: HEALTH_LOOKBACK,
        hasRecent: logs.length > 0,
        latestLogBlock: logs.length > 0 ? logs[logs.length - 1].blockNumber : null,
      }
    },
  })

  const {
    writeContract,
    data: txHash,
    isPending,
    error: writeError,
    reset,
  } = useWriteContract()

  const { isLoading: isConfirming, isSuccess: originConfirmed } =
    useWaitForTransactionReceipt({
      hash: txHash,
      chainId: wardenProtocol.id,
    })

  const deliveryQuery = useQuery({
    queryKey: ['delivery', target?.recipient, target?.fromBlock?.toString(), target?.amount?.toString()],
    enabled: !!target && originConfirmed,
    refetchInterval: (q) => (q.state.data?.delivered ? false : 15_000),
    queryFn: async () => {
      if (!target) return { delivered: false, tx: null, block: null }
      const logs = await bscClient.getLogs({
        address: BSC_WARP_TOKEN,
        event: TRANSFER_EVENT,
        args: { to: target.recipient },
        fromBlock: target.fromBlock,
        toBlock: 'latest',
      })
      const match = logs.find((l) => (l.args.value ?? 0n) >= target.amount)
      return {
        delivered: !!match,
        tx: match?.transactionHash ?? null,
        block: match?.blockNumber ?? null,
      }
    },
  })

  const parsed = useMemo(() => {
    const errs: string[] = []
    let amountWei: bigint | null = null
    let recipientBytes32: `0x${string}` | null = null

    if (recipient) {
      if (!isAddress(recipient)) {
        errs.push('Неверный адрес получателя (ожидается 0x… для BSC).')
      } else {
        recipientBytes32 = pad(recipient as `0x${string}`, { size: 32 })
      }
    }

    if (amount) {
      try {
        amountWei = parseEther(amount as `${number}`)
        if (amountWei <= 0n) errs.push('Сумма должна быть больше нуля.')
      } catch {
        errs.push('Неверный формат суммы.')
      }
    }

    let totalValue: bigint | null = null
    if (amountWei !== null && typeof quote === 'bigint') {
      totalValue = amountWei + quote
      if (balance && totalValue > balance.value) {
        errs.push(
          `Недостаточно WARD. Нужно ${formatEther(totalValue)}, есть ${formatEther(balance.value)}.`,
        )
      }
    }

    return { errs, amountWei, recipientBytes32, totalValue }
  }, [recipient, amount, quote, balance])

  const healthBlocked =
    healthCheckEnabled && !!healthQuery.data && !healthQuery.data.hasRecent
  const healthLoading = healthCheckEnabled && healthQuery.isLoading

  const ready =
    parsed.errs.length === 0 &&
    parsed.amountWei !== null &&
    parsed.recipientBytes32 !== null &&
    parsed.totalValue !== null &&
    !healthBlocked &&
    !healthLoading

  async function submit() {
    if (!ready || !parsed.amountWei || !parsed.recipientBytes32) return
    setSimError(null)
    setSubmitting(true)
    try {
      const [freshQuote, bscBaseline] = await Promise.all([
        readContract(config, {
          address: ROUTER_ADDRESS,
          abi: ROUTER_ABI,
          functionName: 'quoteGasPayment',
          args: [HYPERLANE_DEST_BSC],
          chainId: wardenProtocol.id,
        }),
        bscClient.getBlockNumber(),
      ])
      const value = parsed.amountWei + freshQuote
      if (balance && value > balance.value) {
        setSimError(
          `После обновления quote не хватает баланса: нужно ${formatEther(value)}, есть ${formatEther(balance.value)}.`,
        )
        return
      }
      await simulateContract(config, {
        address: ROUTER_ADDRESS,
        abi: ROUTER_ABI,
        functionName: 'transferRemote',
        args: [HYPERLANE_DEST_BSC, parsed.recipientBytes32, parsed.amountWei],
        value,
        chainId: wardenProtocol.id,
        account: address,
      })
      setTarget({
        recipient: recipient as `0x${string}`,
        amount: parsed.amountWei,
        fromBlock: bscBaseline,
      })
      writeContract({
        address: ROUTER_ADDRESS,
        abi: ROUTER_ABI,
        functionName: 'transferRemote',
        args: [HYPERLANE_DEST_BSC, parsed.recipientBytes32, parsed.amountWei],
        value,
        chainId: wardenProtocol.id,
      })
    } catch (err) {
      setSimError(extractRevert(err))
    } finally {
      setSubmitting(false)
    }
  }

  function fillMax() {
    if (!balance || typeof quote !== 'bigint') return
    const max = balance.value - quote
    if (max > 0n) setAmount(formatEther(max))
  }

  function resetForm() {
    reset()
    setSimError(null)
    setAmount('')
    setTarget(null)
  }

  const explorerTxUrl = txHash
    ? `${wardenProtocol.blockExplorers.default.url}/tx/${txHash}`
    : null
  const hyperlaneUrl = txHash ? `${HYPERLANE_EXPLORER}/?search=${txHash}` : null
  const deliveryTxUrl = deliveryQuery.data?.tx
    ? `${BSC_EXPLORER}/tx/${deliveryQuery.data.tx}`
    : null

  return (
    <section className="card">
      <div className="health-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={healthCheckEnabled}
            onChange={(e) => setHealthCheckEnabled(e.target.checked)}
          />
          <span>Проверять состояние BSC-моста перед отправкой</span>
        </label>
        {healthCheckEnabled && (
          <span className={`health-badge ${
            healthLoading
              ? 'pending'
              : healthQuery.data?.hasRecent
                ? 'ok'
                : 'stale'
          }`}>
            {healthLoading
              ? 'проверка…'
              : healthQuery.data?.hasRecent
                ? `Mailbox активен (последний лог: блок ${healthQuery.data.latestLogBlock?.toString()})`
                : `Mailbox не показывал активности последние ${HEALTH_LOOKBACK.toString()} блоков (~${Math.round(Number(HEALTH_LOOKBACK) * 3 / 60)} мин)`}
          </span>
        )}
      </div>

      {healthBlocked && (
        <div className="warn">
          <p>
            BSC Mailbox <code>{BSC_MAILBOX}</code> не показывал активности последние{' '}
            {HEALTH_LOOKBACK.toString()} блоков. Relayer этого warp route, скорее всего,
            офлайн — токены залочатся в Warden до восстановления. Снимите галочку выше, если
            всё равно хотите попробовать.
          </p>
        </div>
      )}

      <div className="row">
        <label htmlFor="recipient">Получатель в BSC</label>
        <input
          id="recipient"
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value.trim())}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
        />
        {parsed.recipientBytes32 && (
          <small className="mono">bytes32: {parsed.recipientBytes32}</small>
        )}
      </div>

      <div className="row">
        <label htmlFor="amount">Сумма WARD</label>
        <input
          id="amount"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
          placeholder="100"
          autoComplete="off"
        />
        {balance && (
          <small>
            Баланс: {formatEther(balance.value)} WARD
            <button type="button" className="link" onClick={fillMax}>
              max
            </button>
          </small>
        )}
      </div>

      <dl className="summary">
        <dt>IGP quote</dt>
        <dd>
          {quoteLoading
            ? '…'
            : typeof quote === 'bigint'
              ? `${formatEther(quote)} WARD`
              : '—'}
        </dd>
        <dt>Итого msg.value</dt>
        <dd>{parsed.totalValue ? `${formatEther(parsed.totalValue)} WARD` : '—'}</dd>
        <dt>Destination domain</dt>
        <dd>{HYPERLANE_DEST_BSC} (BSC)</dd>
      </dl>

      {parsed.errs.length > 0 && (
        <ul className="error-list">
          {parsed.errs.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <button
        className="primary"
        disabled={!ready || isPending || isConfirming || submitting}
        onClick={submit}
      >
        {submitting && !isPending
          ? 'Проверяем…'
          : isPending
            ? 'Подтвердите в кошельке…'
            : isConfirming
              ? 'Ждём подтверждения…'
              : 'Отправить'}
      </button>

      {simError && <div className="error">Симуляция отклонена: {simError}</div>}
      {writeError && <div className="error">{extractRevert(writeError)}</div>}

      {txHash && (
        <div className="result">
          <HashRow label="Tx (Warden)" hash={txHash} href={explorerTxUrl!} />

          {originConfirmed && target && (
            <div className="delivery">
              <p className="delivery-title">Доставка на BSC</p>
              {deliveryQuery.data?.delivered ? (
                <>
                  <p className="ok">
                    ✅ Получено {formatEther(target.amount)} WARD на {target.recipient.slice(0, 10)}…
                  </p>
                  {deliveryQuery.data.tx && deliveryTxUrl && (
                    <HashRow
                      label="BSC tx"
                      hash={deliveryQuery.data.tx}
                      href={deliveryTxUrl}
                    />
                  )}
                </>
              ) : (
                <>
                  <p className="muted">
                    Ожидаем Transfer-событие на BSC… (опрос каждые 15 с от блока{' '}
                    {target.fromBlock.toString()})
                  </p>
                  <p className="muted">
                    Если за 10+ минут ничего не пришло — скопируй tx-hash выше и заклеймь
                    вручную через вкладку «Ручной claim».
                  </p>
                </>
              )}
              <p>
                Hyperlane:{' '}
                <a target="_blank" rel="noopener noreferrer" href={hyperlaneUrl!}>
                  отслеживать
                </a>
              </p>
            </div>
          )}

          {(deliveryQuery.data?.delivered || originConfirmed) && (
            <button className="ghost" onClick={resetForm}>
              Новый перевод
            </button>
          )}
        </div>
      )}
    </section>
  )
}
