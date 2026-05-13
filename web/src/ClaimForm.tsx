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
import { bsc as bscChain } from 'viem/chains'
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  formatEther,
  isHash,
  type Hex,
} from 'viem'
import { HashRow } from './HashRow'
import {
  BSC_EXPLORER,
  BSC_MAILBOX,
  bscClient,
  MAILBOX_ABI,
  MERKLE_HOOK_ABI,
  MULTISIG_THRESHOLD,
  VALIDATORS,
  WARDEN_MAILBOX,
  WARDEN_MERKLE_HOOK,
  wardenClient,
} from './chains'

type Parsed = {
  message: Hex
  messageId: Hex
  treeIndex: number
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
  metadata: Hex
  message: Hex
  messageId: Hex
  parsed: Parsed
  root: Hex
  treeIndex: number
  signers: Hex[]
  delivered: boolean
}

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

function parseMessage(hex: Hex): Parsed {
  const h = hex.slice(2)
  return {
    message: hex,
    messageId: ('0x' + '0'.repeat(64)) as Hex, // placeholder; filled by caller
    treeIndex: 0,
    nonce: parseInt(h.slice(2, 10), 16),
    origin: parseInt(h.slice(10, 18), 16),
    sender: ('0x' + h.slice(18, 82)) as Hex,
    destination: parseInt(h.slice(82, 90), 16),
    recipient: ('0x' + h.slice(90, 154)) as Hex,
    bodyRecipient: ('0x' + h.slice(154 + 24, 154 + 64)) as Hex,
    bodyAmount: BigInt('0x' + h.slice(154 + 64, 154 + 128)),
  }
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

const CORS_PROXY = 'https://api.codetabs.com/v1/proxy/?quest='

async function fetchValidatorCheckpoint(
  v: (typeof VALIDATORS)[number],
  index: number,
): Promise<CheckpointJson | null> {
  const url = `${v.base}${v.prefix}checkpoint_${index}_with_id.json`
  try {
    const direct = await fetch(url)
    if (direct.ok) return (await direct.json()) as CheckpointJson
    if (direct.status === 404) return null
  } catch {
    // CORS-blocked or network failure — fall through to proxy
  }
  try {
    const viaProxy = await fetch(CORS_PROXY + encodeURIComponent(url))
    if (!viaProxy.ok) return null
    return (await viaProxy.json()) as CheckpointJson
  } catch {
    return null
  }
}

function pad32hex(addr: Hex): string {
  return addr.slice(2).padStart(64, '0')
}

async function buildPrepared(txHash: Hex): Promise<Prepared> {
  const rcpt = await wardenClient.getTransactionReceipt({ hash: txHash })

  let message: Hex | null = null
  let messageId: Hex | null = null
  let treeIndex: number | null = null

  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() === WARDEN_MAILBOX.toLowerCase()) {
      try {
        const dec = decodeEventLog({
          abi: MAILBOX_ABI,
          data: log.data,
          topics: log.topics,
        })
        if (dec.eventName === 'Dispatch') message = dec.args.message as Hex
        if (dec.eventName === 'DispatchId') messageId = dec.args.messageId as Hex
      } catch {}
    }
    if (log.address.toLowerCase() === WARDEN_MERKLE_HOOK.toLowerCase()) {
      try {
        const dec = decodeEventLog({
          abi: MERKLE_HOOK_ABI,
          data: log.data,
          topics: log.topics,
        })
        if (dec.eventName === 'InsertedIntoTree') treeIndex = Number(dec.args.index)
      } catch {}
    }
  }

  if (!message) throw new Error('Dispatch event not found in this tx')
  if (treeIndex === null) throw new Error('InsertedIntoTree event not found')
  if (!messageId) throw new Error('DispatchId event not found')

  const parsed = parseMessage(message)
  parsed.messageId = messageId
  parsed.treeIndex = treeIndex

  const alreadyDelivered = await bscClient.readContract({
    address: BSC_MAILBOX,
    abi: MAILBOX_ABI,
    functionName: 'delivered',
    args: [messageId],
  })

  if (alreadyDelivered) {
    return {
      metadata: '0x' as Hex,
      message,
      messageId,
      parsed,
      root: ('0x' + '0'.repeat(64)) as Hex,
      treeIndex,
      signers: [],
      delivered: true,
    }
  }

  const sigs: SigEntry[] = []
  let root: Hex | null = null

  for (const v of VALIDATORS) {
    if (sigs.length >= MULTISIG_THRESHOLD) break
    const cp = await fetchValidatorCheckpoint(v, treeIndex).catch(() => null)
    if (!cp) continue
    const msgIdInCp = cp.value?.message_id
    if (!msgIdInCp || msgIdInCp.toLowerCase() !== messageId.toLowerCase()) continue
    const cpRoot = ('0x' + cp.value.checkpoint.root.replace(/^0x/, '').padStart(64, '0')) as Hex
    if (root && cpRoot.toLowerCase() !== root.toLowerCase()) continue
    root = cpRoot
    const r32 = cp.signature.r.replace(/^0x/, '').padStart(64, '0')
    const s32 = cp.signature.s.replace(/^0x/, '').padStart(64, '0')
    const vHex = cp.signature.v.toString(16).padStart(2, '0')
    sigs.push({ validator: v.addr, sigPacked: r32 + s32 + vHex })
  }

  if (sigs.length < MULTISIG_THRESHOLD || !root) {
    throw new Error(
      `Только ${sigs.length}/${MULTISIG_THRESHOLD} валидаторов опубликовали подпись для checkpoint ${treeIndex}. Подожди и попробуй ещё раз.`,
    )
  }

  const inner =
    pad32hex(WARDEN_MERKLE_HOOK) +
    root.slice(2) +
    treeIndex.toString(16).padStart(8, '0') +
    sigs.map((s) => s.sigPacked).join('')

  const headerStart = 8
  const headerEnd = headerStart + inner.length / 2
  const aggHeader =
    headerStart.toString(16).padStart(8, '0') +
    headerEnd.toString(16).padStart(8, '0')
  const metadata = ('0x' + aggHeader + inner) as Hex

  return {
    metadata,
    message,
    messageId,
    parsed,
    root,
    treeIndex,
    signers: sigs.map((s) => s.validator),
    delivered: false,
  }
}

export function ClaimForm() {
  const { address, isConnected } = useAccount()
  const config = useConfig()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const [txHash, setTxHash] = useState('')
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [simError, setSimError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const {
    writeContract,
    data: claimTxHash,
    isPending: isWriting,
    error: writeError,
    reset,
  } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: claimTxHash,
    chainId: bscChain.id,
  })

  const onWrongChain = isConnected && chainId !== bscChain.id

  async function handleLoad() {
    setLoadError(null)
    setSimError(null)
    setPrepared(null)
    reset()
    if (!isHash(txHash)) {
      setLoadError('Неверный формат tx hash. Ожидается 0x… длиной 66 символов.')
      return
    }
    setLoading(true)
    try {
      const p = await buildPrepared(txHash as Hex)
      setPrepared(p)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleClaim() {
    if (!prepared || prepared.delivered) return
    setSimError(null)
    setSubmitting(true)
    try {
      await simulateContract(config, {
        address: BSC_MAILBOX,
        abi: MAILBOX_ABI,
        functionName: 'process',
        args: [prepared.metadata, prepared.message],
        chainId: bscChain.id,
        account: address,
      })
      writeContract({
        address: BSC_MAILBOX,
        abi: MAILBOX_ABI,
        functionName: 'process',
        args: [prepared.metadata, prepared.message],
        chainId: bscChain.id,
      })
    } catch (err) {
      setSimError(extractRevert(err))
    } finally {
      setSubmitting(false)
    }
  }

  const claimTxUrl = claimTxHash ? `${BSC_EXPLORER}/tx/${claimTxHash}` : null

  return (
    <section className="card">
      <div className="row">
        <label htmlFor="claim-tx">Warden tx hash</label>
        <input
          id="claim-tx"
          type="text"
          value={txHash}
          onChange={(e) => setTxHash(e.target.value.trim())}
          placeholder="0x… origin transferRemote tx hash"
          spellCheck={false}
          autoComplete="off"
        />
        <small className="muted">
          Этот клейм нужен только если стандартный relayer не доставил message. Для подписи
          process() нужно немного BNB на BSC (~0.001 BNB на газ).
        </small>
      </div>

      <button className="primary" onClick={handleLoad} disabled={loading || !txHash}>
        {loading ? 'Загружаем + собираем подписи…' : 'Загрузить'}
      </button>

      {loadError && <div className="error">{loadError}</div>}

      {prepared && (
        <>
          <dl className="summary">
            <dt>messageId</dt>
            <dd className="mono">{prepared.messageId}</dd>
            <dt>merkle index</dt>
            <dd>{prepared.treeIndex}</dd>
            <dt>recipient (BSC)</dt>
            <dd className="mono">0x{prepared.parsed.bodyRecipient.slice(-40)}</dd>
            <dt>amount</dt>
            <dd>{formatEther(prepared.parsed.bodyAmount)} WARD</dd>
            <dt>checkpoint root</dt>
            <dd className="mono">{prepared.root}</dd>
            <dt>signatures</dt>
            <dd>
              {prepared.signers.length} / {MULTISIG_THRESHOLD}{' '}
              {prepared.signers.length > 0 && (
                <span className="muted">
                  ({prepared.signers.map((s) => s.slice(0, 10) + '…').join(', ')})
                </span>
              )}
            </dd>
            <dt>metadata size</dt>
            <dd>{prepared.metadata === '0x' ? '—' : (prepared.metadata.length - 2) / 2} bytes</dd>
          </dl>

          {prepared.delivered ? (
            <div className="ok-banner">
              ✅ Этот message уже доставлен на BSC. Mailbox.delivered(messageId) = true.
            </div>
          ) : onWrongChain ? (
            <div className="warn">
              <p>
                Для подписи process() кошелёк должен быть в BSC (chainId {bscChain.id}). Сейчас:{' '}
                {chainId}.
              </p>
              <button
                className="primary"
                disabled={isSwitching}
                onClick={() => switchChain({ chainId: bscChain.id })}
              >
                {isSwitching ? 'Переключаем…' : 'Переключить на BSC'}
              </button>
            </div>
          ) : (
            <button
              className="primary"
              onClick={handleClaim}
              disabled={!isConnected || isWriting || isConfirming || submitting}
            >
              {submitting && !isWriting
                ? 'Проверяем симуляцию…'
                : isWriting
                  ? 'Подтвердите в кошельке…'
                  : isConfirming
                    ? 'Ждём подтверждения на BSC…'
                    : 'Подписать process() на BSC'}
            </button>
          )}

          {simError && <div className="error">Симуляция отклонена: {simError}</div>}
          {writeError && <div className="error">{extractRevert(writeError)}</div>}

          {claimTxHash && (
            <div className="result">
              <HashRow label="BSC claim tx" hash={claimTxHash} href={claimTxUrl!} />
              {isSuccess && (
                <p className="ok">
                  ✅ process() прошёл. {formatEther(prepared.parsed.bodyAmount)} WARD выдан
                  на BSC адрес 0x{prepared.parsed.bodyRecipient.slice(-40)}.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
