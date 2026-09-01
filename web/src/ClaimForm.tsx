import { useState } from 'react'
import {
  useAccount,
  useChainId,
  useConfig,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { simulateContract } from 'wagmi/actions'
import { base as baseChain, bsc as bscChain } from 'viem/chains'
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  formatEther,
  isHash,
  keccak256,
  type Hex,
} from 'viem'
import { HashRow } from './HashRow'
import {
  BASE_EXPLORER,
  BASE_MAILBOX,
  BASE_MERKLE_HOOK,
  BASE_VALIDATORS,
  BASE_WARP_TOKEN,
  baseClient,
  BSC_EXPLORER,
  BSC_MAILBOX,
  BSC_WARP_TOKEN,
  bscClient,
  MAILBOX_ABI,
  MERKLE_HOOK_ABI,
  MULTISIG_THRESHOLD,
  ROUTER_ADDRESS,
  WARDEN_BASE_WARP_TOKEN,
  WARDEN_MAILBOX,
  WARDEN_MERKLE_HOOK,
  WARDEN_VALIDATORS,
  wardenClient,
  wardenProtocol,
} from './chains'

type ClaimDirection = 'base-to-warden' | 'warden-to-bsc'

const CLAIM_ROUTES = {
  'base-to-warden': {
    sourceName: 'Base',
    sourceChainId: baseChain.id,
    sourceClient: baseClient,
    sourceMailbox: BASE_MAILBOX,
    sourceMerkleHook: BASE_MERKLE_HOOK,
    expectedSender: BASE_WARP_TOKEN,
    destinationName: 'Warden',
    destinationChainId: wardenProtocol.id,
    destinationClient: wardenClient,
    destinationMailbox: WARDEN_MAILBOX,
    expectedRecipient: WARDEN_BASE_WARP_TOKEN,
    destinationExplorer: wardenProtocol.blockExplorers.default.url,
    gasSymbol: 'WARD',
    validators: BASE_VALIDATORS,
  },
  'warden-to-bsc': {
    sourceName: 'Warden',
    sourceChainId: wardenProtocol.id,
    sourceClient: wardenClient,
    sourceMailbox: WARDEN_MAILBOX,
    sourceMerkleHook: WARDEN_MERKLE_HOOK,
    expectedSender: ROUTER_ADDRESS,
    destinationName: 'BSC',
    destinationChainId: bscChain.id,
    destinationClient: bscClient,
    destinationMailbox: BSC_MAILBOX,
    expectedRecipient: BSC_WARP_TOKEN,
    destinationExplorer: BSC_EXPLORER,
    gasSymbol: 'BNB',
    validators: WARDEN_VALIDATORS,
  },
} as const

type ClaimRoute = (typeof CLAIM_ROUTES)[ClaimDirection]

type Parsed = {
  message: Hex
  messageId: Hex
  treeIndex: number
  version: number
  nonce: number
  origin: number
  destination: number
  sender: Hex
  recipient: Hex
  bodyRecipient: Hex
  bodyAmount: bigint
}

type SigEntry = {
  validator: Hex
  sigPacked: string
}

type Prepared = {
  direction: ClaimDirection
  metadata: Hex
  message: Hex
  messageId: Hex
  parsed: Parsed
  root: Hex
  treeIndex: number
  signers: Hex[]
  delivered: boolean
}

type CheckpointJson = {
  value: {
    checkpoint: {
      merkle_tree_hook_address: string
      mailbox_domain: number
      root: string
      index: number
    }
    message_id: string
  }
  signature: { r: string; s: string; v: number }
}

const JINA_PROXY = 'https://r.jina.ai/http://'

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

function pad32hex(addr: Hex): string {
  return addr.slice(2).padStart(64, '0')
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function parseMessage(hex: Hex): Parsed {
  const h = hex.slice(2)
  if (h.length < 282) throw new Error('Некорректный Hyperlane message: слишком короткий payload.')

  return {
    message: hex,
    messageId: (`0x${'0'.repeat(64)}`) as Hex,
    treeIndex: 0,
    version: parseInt(h.slice(0, 2), 16),
    nonce: parseInt(h.slice(2, 10), 16),
    origin: parseInt(h.slice(10, 18), 16),
    sender: (`0x${h.slice(18, 82)}`) as Hex,
    destination: parseInt(h.slice(82, 90), 16),
    recipient: (`0x${h.slice(90, 154)}`) as Hex,
    bodyRecipient: (`0x${h.slice(178, 218)}`) as Hex,
    bodyAmount: BigInt(`0x${h.slice(218, 282)}`),
  }
}

function parseCheckpointText(text: string): CheckpointJson {
  try {
    return JSON.parse(text) as CheckpointJson
  } catch {
    // r.jina.ai wraps JSON in a short Markdown preamble.
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) throw new Error('Validator returned invalid checkpoint JSON')
    return JSON.parse(text.slice(start, end + 1)) as CheckpointJson
  }
}

async function fetchWithTimeout(url: string, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    window.clearTimeout(timeout)
  }
}

async function fetchValidatorCheckpoint(
  validator: ClaimRoute['validators'][number],
  index: number,
): Promise<CheckpointJson | null> {
  const url = `${validator.base}${validator.prefix}checkpoint_${index}_with_id.json`

  try {
    const direct = await fetchWithTimeout(url)
    if (direct.ok) return parseCheckpointText(await direct.text())
    if (direct.status === 404) return null
  } catch {
    // S3 does not expose browser CORS headers; use a read-only fallback below.
  }

  try {
    // A cache buster avoids retaining a pre-publication 404 for a new checkpoint.
    const viaProxy = await fetchWithTimeout(`${JINA_PROXY}${url}?claim=${Date.now()}`)
    if (!viaProxy.ok) return null
    return parseCheckpointText(await viaProxy.text())
  } catch {
    return null
  }
}

function assertRouteMessage(parsed: Parsed, route: ClaimRoute) {
  if (parsed.version !== 3) {
    throw new Error(`Неподдерживаемая версия Hyperlane message: ${parsed.version}.`)
  }
  if (parsed.origin !== route.sourceChainId || parsed.destination !== route.destinationChainId) {
    throw new Error(
      `Транзакция отправляет message ${parsed.origin} → ${parsed.destination}, а выбран маршрут ` +
        `${route.sourceChainId} → ${route.destinationChainId}.`,
    )
  }
  if (!sameHex(parsed.sender, `0x${pad32hex(route.expectedSender)}`)) {
    throw new Error(`Dispatch создан не WARD-контрактом маршрута ${route.sourceName}.`)
  }
  if (!sameHex(parsed.recipient, `0x${pad32hex(route.expectedRecipient)}`)) {
    throw new Error(`Получатель message не WARD-контракт маршрута в ${route.destinationName}.`)
  }
}

async function buildPrepared(
  txHash: Hex,
  direction: ClaimDirection,
): Promise<Prepared> {
  const route = CLAIM_ROUTES[direction]
  const receipt = await route.sourceClient.getTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error('Исходная транзакция завершилась с revert.')

  const messages: Hex[] = []
  const dispatchIds = new Set<string>()
  const insertions = new Map<string, number>()

  for (const log of receipt.logs) {
    if (sameHex(log.address, route.sourceMailbox)) {
      try {
        const decoded = decodeEventLog({ abi: MAILBOX_ABI, data: log.data, topics: log.topics })
        if (decoded.eventName === 'Dispatch') messages.push(decoded.args.message as Hex)
        if (decoded.eventName === 'DispatchId') {
          dispatchIds.add((decoded.args.messageId as Hex).toLowerCase())
        }
      } catch {
        // The Mailbox emits several event types; unrelated logs are expected.
      }
    }
    if (sameHex(log.address, route.sourceMerkleHook)) {
      try {
        const decoded = decodeEventLog({
          abi: MERKLE_HOOK_ABI,
          data: log.data,
          topics: log.topics,
        })
        if (decoded.eventName === 'InsertedIntoTree') {
          insertions.set(
            (decoded.args.messageId as Hex).toLowerCase(),
            Number(decoded.args.index),
          )
        }
      } catch {
        // Ignore other hook events.
      }
    }
  }

  const matched = messages
    .map((message) => ({ message, messageId: keccak256(message) }))
    .filter(({ messageId }) => dispatchIds.has(messageId.toLowerCase()))
    .filter(({ messageId }) => insertions.has(messageId.toLowerCase()))

  if (matched.length === 0) {
    throw new Error(
      `В транзакции не найден полный WARD Dispatch на ${route.sourceName} ` +
        '(Dispatch + DispatchId + InsertedIntoTree).',
    )
  }
  if (matched.length > 1) {
    throw new Error('В транзакции найдено несколько Dispatch. Для безопасности claim не собран.')
  }

  const { message, messageId } = matched[0]
  const treeIndex = insertions.get(messageId.toLowerCase())!
  const parsed = parseMessage(message)
  parsed.messageId = messageId
  parsed.treeIndex = treeIndex
  assertRouteMessage(parsed, route)

  const alreadyDelivered = await route.destinationClient.readContract({
    address: route.destinationMailbox,
    abi: MAILBOX_ABI,
    functionName: 'delivered',
    args: [messageId],
  })

  if (alreadyDelivered) {
    return {
      direction,
      metadata: '0x',
      message,
      messageId,
      parsed,
      root: (`0x${'0'.repeat(64)}`) as Hex,
      treeIndex,
      signers: [],
      delivered: true,
    }
  }

  const checkpoints = await Promise.all(
    route.validators.map(async (validator) => ({
      validator,
      checkpoint: await fetchValidatorCheckpoint(validator, treeIndex),
    })),
  )

  const sigs: SigEntry[] = []
  let root: Hex | null = null
  const expectedHook = `0x${pad32hex(route.sourceMerkleHook)}`

  for (const { validator, checkpoint } of checkpoints) {
    if (!checkpoint || sigs.length >= MULTISIG_THRESHOLD) continue
    const value = checkpoint.value
    const cp = value?.checkpoint
    if (!value || !cp || !sameHex(value.message_id, messageId)) continue
    if (Number(cp.mailbox_domain) !== route.sourceChainId) continue
    if (Number(cp.index) !== treeIndex) continue
    if (!sameHex(cp.merkle_tree_hook_address, expectedHook)) continue

    const checkpointRoot = (`0x${cp.root.replace(/^0x/, '').padStart(64, '0')}`) as Hex
    if (root && !sameHex(checkpointRoot, root)) continue

    const r = checkpoint.signature?.r?.replace(/^0x/, '').padStart(64, '0')
    const s = checkpoint.signature?.s?.replace(/^0x/, '').padStart(64, '0')
    let v = Number(checkpoint.signature?.v)
    if (v === 0 || v === 1) v += 27
    if (!/^[0-9a-fA-F]{64}$/.test(r) || !/^[0-9a-fA-F]{64}$/.test(s) || (v !== 27 && v !== 28)) {
      continue
    }

    root = checkpointRoot
    sigs.push({
      validator: validator.addr,
      sigPacked: r + s + v.toString(16).padStart(2, '0'),
    })
  }

  if (sigs.length < MULTISIG_THRESHOLD || !root) {
    throw new Error(
      `Только ${sigs.length}/${MULTISIG_THRESHOLD} валидаторов опубликовали подходящую ` +
        `подпись ${route.sourceName} checkpoint ${treeIndex}. Подожди и попробуй ещё раз.`,
    )
  }

  const inner =
    pad32hex(route.sourceMerkleHook) +
    root.slice(2) +
    treeIndex.toString(16).padStart(8, '0') +
    sigs.map((signature) => signature.sigPacked).join('')
  const headerStart = 8
  const headerEnd = headerStart + inner.length / 2
  const metadata = (`0x${headerStart.toString(16).padStart(8, '0')}${headerEnd
    .toString(16)
    .padStart(8, '0')}${inner}`) as Hex

  return {
    direction,
    metadata,
    message,
    messageId,
    parsed,
    root,
    treeIndex,
    signers: sigs.map((signature) => signature.validator),
    delivered: false,
  }
}

export function ClaimForm() {
  const { address, isConnected } = useAccount()
  const config = useConfig()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const [direction, setDirection] = useState<ClaimDirection>('base-to-warden')
  const [txHash, setTxHash] = useState('')
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [simError, setSimError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const route = CLAIM_ROUTES[direction]
  const preparedRoute = prepared ? CLAIM_ROUTES[prepared.direction] : route

  const {
    writeContractAsync,
    data: claimTxHash,
    isPending: isWriting,
    error: writeError,
    reset,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: claimTxHash,
    chainId: preparedRoute.destinationChainId,
  })

  const onWrongChain = isConnected && chainId !== preparedRoute.destinationChainId

  function clearPrepared() {
    setPrepared(null)
    setLoadError(null)
    setSimError(null)
    reset()
  }

  function handleDirectionChange(next: ClaimDirection) {
    setDirection(next)
    setTxHash('')
    clearPrepared()
  }

  async function handleLoad() {
    clearPrepared()
    if (!isHash(txHash)) {
      setLoadError('Неверный формат tx hash. Ожидается 0x… длиной 66 символов.')
      return
    }
    setLoading(true)
    try {
      setPrepared(await buildPrepared(txHash as Hex, direction))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleClaim() {
    if (!prepared || prepared.delivered) return
    const destination = CLAIM_ROUTES[prepared.direction]
    setSimError(null)
    setSubmitting(true)
    try {
      await simulateContract(config, {
        address: destination.destinationMailbox,
        abi: MAILBOX_ABI,
        functionName: 'process',
        args: [prepared.metadata, prepared.message],
        chainId: destination.destinationChainId,
        account: address,
      })
      await writeContractAsync({
        address: destination.destinationMailbox,
        abi: MAILBOX_ABI,
        functionName: 'process',
        args: [prepared.metadata, prepared.message],
        chainId: destination.destinationChainId,
      })
    } catch (err) {
      setSimError(extractRevert(err))
    } finally {
      setSubmitting(false)
    }
  }

  const claimTxUrl = claimTxHash
    ? `${preparedRoute.destinationExplorer}/tx/${claimTxHash}`
    : null

  return (
    <section className="card">
      <div className="row">
        <label htmlFor="claim-direction">Направление зависшего перевода</label>
        <select
          id="claim-direction"
          value={direction}
          onChange={(event) => handleDirectionChange(event.target.value as ClaimDirection)}
        >
          <option value="base-to-warden">Base → Warden</option>
          <option value="warden-to-bsc">Warden → BSC</option>
        </select>
      </div>

      <div className="row">
        <label htmlFor="claim-tx">{route.sourceName} tx hash</label>
        <input
          id="claim-tx"
          type="text"
          value={txHash}
          onChange={(event) => setTxHash(event.target.value.trim())}
          placeholder="0x… исходная transferRemote транзакция"
          spellCheck={false}
          autoComplete="off"
        />
        <small className="muted">
          Claim нужен только если relayer не доставил message. Вызов process() подписывается в{' '}
          {route.destinationName}; для газа нужен небольшой запас {route.gasSymbol}. Вызвать claim
          может любой адрес — WARD всё равно поступит исходному получателю из message.
        </small>
        {direction === 'base-to-warden' && (
          <small className="muted">
            Проверяется именно Base-транзакция: {BASE_EXPLORER}/tx/0x…
          </small>
        )}
      </div>

      <button className="primary" onClick={handleLoad} disabled={loading || !txHash}>
        {loading ? 'Загружаем + собираем подписи…' : 'Загрузить перевод'}
      </button>

      {loadError && <div className="error">{loadError}</div>}

      {prepared && (
        <>
          <dl className="summary">
            <dt>route</dt>
            <dd>{preparedRoute.sourceName} → {preparedRoute.destinationName}</dd>
            <dt>messageId</dt>
            <dd className="mono">{prepared.messageId}</dd>
            <dt>merkle index</dt>
            <dd>{prepared.treeIndex}</dd>
            <dt>recipient ({preparedRoute.destinationName})</dt>
            <dd className="mono">{prepared.parsed.bodyRecipient}</dd>
            <dt>amount</dt>
            <dd>{formatEther(prepared.parsed.bodyAmount)} WARD</dd>
            <dt>checkpoint root</dt>
            <dd className="mono">{prepared.root}</dd>
            <dt>signatures</dt>
            <dd>
              {prepared.signers.length} / {MULTISIG_THRESHOLD}{' '}
              {prepared.signers.length > 0 && (
                <span className="muted">
                  ({prepared.signers.map((signer) => `${signer.slice(0, 10)}…`).join(', ')})
                </span>
              )}
            </dd>
            <dt>metadata size</dt>
            <dd>{prepared.metadata === '0x' ? '—' : (prepared.metadata.length - 2) / 2} bytes</dd>
          </dl>

          {prepared.delivered ? (
            <div className="ok-banner">
              ✅ Message уже доставлен в {preparedRoute.destinationName}. Повторный claim не нужен.
            </div>
          ) : onWrongChain ? (
            <div className="warn">
              <p>
                Для process() кошелёк должен быть в {preparedRoute.destinationName} (chainId{' '}
                {preparedRoute.destinationChainId}). Сейчас: {chainId}.
              </p>
              <button
                className="primary"
                disabled={isSwitching}
                onClick={() => switchChain({ chainId: preparedRoute.destinationChainId })}
              >
                {isSwitching ? 'Переключаем…' : `Переключить на ${preparedRoute.destinationName}`}
              </button>
            </div>
          ) : (
            <button
              className="primary"
              onClick={handleClaim}
              disabled={!isConnected || isWriting || isConfirming || submitting}
            >
              {submitting && !isWriting
                ? 'Проверяем и отправляем…'
                : isWriting
                  ? 'Подтвердите в кошельке…'
                  : isConfirming
                    ? `Ждём подтверждения в ${preparedRoute.destinationName}…`
                    : `Подписать process() в ${preparedRoute.destinationName}`}
            </button>
          )}

          {simError && <div className="error">Claim отклонён: {simError}</div>}
          {writeError && <div className="error">{extractRevert(writeError)}</div>}

          {claimTxHash && claimTxUrl && (
            <div className="result">
              <HashRow
                label={`${preparedRoute.destinationName} claim tx`}
                hash={claimTxHash}
                href={claimTxUrl}
              />
              {isSuccess && (
                <p className="ok">
                  ✅ process() прошёл. {formatEther(prepared.parsed.bodyAmount)} WARD отправлено на{' '}
                  {prepared.parsed.bodyRecipient} в {preparedRoute.destinationName}.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
