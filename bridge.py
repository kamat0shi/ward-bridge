# pip install web3
from web3 import Web3
from eth_account import Account

# ─── ОТРЕДАКТИРУЙ ЭТИ 3 СТРОКИ ──────────────────────────────
PRIVATE_KEY   = "0xТВОЙ_ПРИВАТНЫЙ_КЛЮЧ_СЕТИ_WARDEN"
BSC_RECIPIENT = "0xАДРЕС_ПОЛУЧАТЕЛЯ_НА_BSC"
AMOUNT_WARD   = "100"  # сколько WARD отправляем (строкой)
# ────────────────────────────────────────────────────────────

RPC    = "https://evm.wardenprotocol.org"
ROUTER = Web3.to_checksum_address("0xAB5159B5655CdAA5178C283853841aBB0D02Eef9")
DEST   = 56  # BSC

ABI = [
    {"name": "transferRemote", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "destination", "type": "uint32"},
                {"name": "recipient",   "type": "bytes32"},
                {"name": "amount",      "type": "uint256"}],
     "outputs":[{"type": "bytes32"}]},
    {"name": "quoteGasPayment", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "destination", "type": "uint32"}],
     "outputs":[{"type": "uint256"}]},
]

w3      = Web3(Web3.HTTPProvider(RPC))
account = Account.from_key(PRIVATE_KEY)
router  = w3.eth.contract(address=ROUTER, abi=ABI)

amount    = w3.to_wei(AMOUNT_WARD, "ether")                          # 18 decimals
recipient = bytes(12) + bytes.fromhex(BSC_RECIPIENT[2:])              # 0x000...000 + addr → bytes32
quote     = router.functions.quoteGasPayment(DEST).call()
# AggregationHook = [IGP, MerkleTreeHook]: IGP хочет ровно quote, MerkleTree хочет 0 excess.
# Любой "буфер" сверху → "MerkleTreeHook: no value expected".
value     = amount + quote

print(f"Отправляю {AMOUNT_WARD} WARD на {BSC_RECIPIENT} (BSC)")
print(f"Quote IGP: {w3.from_wei(quote, 'ether')} WARD, итого msg.value: {w3.from_wei(value, 'ether')} WARD")

tx = router.functions.transferRemote(DEST, recipient, amount).build_transaction({
    "from":     account.address,
    "value":    value,
    "nonce":    w3.eth.get_transaction_count(account.address),
    "chainId":  8765,
    "gas":      500_000,                # с запасом
    "gasPrice": w3.eth.gas_price,
})

signed = account.sign_transaction(tx)
tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
print(f"📤 tx отправлен: https://explorer.wardenprotocol.org/tx/{tx_hash.hex()}")

rcpt = w3.eth.wait_for_transaction_receipt(tx_hash)
if rcpt.status == 1:
    print(f"✅ Подтверждено в блоке {rcpt.blockNumber}. Жди 1–10 мин — токены придут на BSC.")
    print(f"🔍 Hyperlane: https://explorer.hyperlane.xyz/?search=0x{tx_hash.hex()}")
else:
    print("❌ Reverted")