const { ethers } = require("ethers");

const WARDEN_RPC = process.env.WARDEN_RPC || "https://evm.wardenprotocol.org";
const BSC_RPC = process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org";

const MAILBOX = "0x15eECB285AAE883FcFF1C3F38552EB9d64EbCb7d";
const MERKLE_TREE_HOOK = "0x2719d412dEcF46dbeb3C478e9099Ab16E53D9fb2";

const VALIDATORS = [
  { addr: "0x49CF57FE281fa67B08A156Fe4E212d44e1CC5762", base: "https://hyperlane-validator-signatures-liveraven-warden.s3.eu-central-1.amazonaws.com/", prefix: "wardenprotocol/" },
  { addr: "0x68c35338A78FbF1Dc7AA8e6F8435230b4704a243", base: "https://hyperlane-validator-signatures-cryptosjnet-warden-warden.s3.us-east-1.amazonaws.com/", prefix: "" },
  { addr: "0xB117F78749c6A59eB778e9E6920650Ee74D1eD83", base: "https://mainnet-hyperlane-validator.s3.eu-west-1.amazonaws.com/", prefix: "signatures-mainnet-warden/" },
  { addr: "0xEc554F998d57aEAe5916bD3BBFA255df8428B2bA", base: "https://eq-hyperlane-validator.s3.eu-west-1.amazonaws.com/", prefix: "signatures-warden/" },
];
const THRESHOLD = 2;

const MAILBOX_ABI = [
  "function process(bytes metadata, bytes message)",
  "function delivered(bytes32) view returns (bool)",
  "event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)",
  "event DispatchId(bytes32 indexed messageId)",
];

const TREE_ABI = [
  "event InsertedIntoTree(bytes32 messageId, uint32 index)",
];

function pad32(hex) {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

function parseMessage(message) {
  const h = message.replace(/^0x/, "");
  return {
    version: parseInt(h.slice(0, 2), 16),
    nonce: parseInt(h.slice(2, 10), 16),
    origin: parseInt(h.slice(10, 18), 16),
    sender: "0x" + h.slice(18, 82),
    destination: parseInt(h.slice(82, 90), 16),
    recipient: "0x" + h.slice(90, 154),
    body: "0x" + h.slice(154),
  };
}

async function fetchSig(v, index) {
  const url = `${v.base}${v.prefix}checkpoint_${index}_with_id.json`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  return j;
}

async function main() {
  const dispatchTx = process.argv[2];
  if (!dispatchTx) {
    console.error("Usage: HYP_KEY=0x... node deliver-any.js <wardenDispatchTxHash>");
    process.exit(1);
  }
  const pk = process.env.HYP_KEY;
  if (!pk) throw new Error("Set HYP_KEY=<bsc private key with BNB for gas>");

  const warden = new ethers.JsonRpcProvider(WARDEN_RPC);
  const bsc = new ethers.JsonRpcProvider(BSC_RPC);
  const wallet = new ethers.Wallet(pk, bsc);
  const mailbox = new ethers.Contract(MAILBOX, MAILBOX_ABI, wallet);
  const tree = new ethers.Interface(TREE_ABI);
  const mbIface = new ethers.Interface(MAILBOX_ABI);

  const rc = await warden.getTransactionReceipt(dispatchTx);
  if (!rc) throw new Error("Dispatch tx not found on Warden");

  let message = null, messageId = null, treeIndex = null;
  for (const log of rc.logs) {
    try {
      const p = mbIface.parseLog(log);
      if (p && p.name === "Dispatch") message = p.args.message;
      if (p && p.name === "DispatchId") messageId = p.args.messageId;
    } catch {}
    try {
      const p = tree.parseLog(log);
      if (p && p.name === "InsertedIntoTree") treeIndex = Number(p.args.index);
    } catch {}
  }
  if (!message) throw new Error("Dispatch event not found in tx logs");
  if (treeIndex == null) throw new Error("InsertedIntoTree event not found");
  if (!messageId) messageId = ethers.keccak256(message);

  const parsed = parseMessage(message);
  console.log("messageId :", messageId);
  console.log("nonce     :", parsed.nonce);
  console.log("treeIndex :", treeIndex);
  console.log("origin    :", parsed.origin, " dest:", parsed.destination);
  console.log("recipient :", "0x" + parsed.recipient.slice(-40));

  const already = await mailbox.delivered(messageId);
  if (already) { console.log("Already delivered."); return; }

  console.log("\nFetching validator signatures for index", treeIndex, "...");
  const sigs = [];
  let root = null;
  for (const v of VALIDATORS) {
    if (sigs.length >= THRESHOLD) break;
    const cp = await fetchSig(v, treeIndex);
    if (!cp) { console.log(" ", v.addr, "no checkpoint"); continue; }
    const c = cp.value?.checkpoint || cp.checkpoint || cp.value;
    const sigObj = cp.value?.signature || cp.signature;
    const msgIdInCp = cp.value?.message_id || cp.message_id;
    if (!c || !sigObj) { console.log(" ", v.addr, "bad checkpoint shape"); continue; }
    if (msgIdInCp && msgIdInCp.toLowerCase() !== messageId.toLowerCase()) {
      console.log(" ", v.addr, "messageId mismatch in cp", msgIdInCp);
      continue;
    }
    const r = c.root || c.merkle_root;
    if (root && r.toLowerCase() !== root.toLowerCase()) {
      console.log(" ", v.addr, "root mismatch — skipping");
      continue;
    }
    root = r;
    const r32 = pad32(sigObj.r);
    const s32 = pad32(sigObj.s);
    const v1 = (sigObj.v).toString(16).padStart(2, "0");
    sigs.push({ addr: v.addr, sig: r32 + s32 + v1 });
    console.log("  +", v.addr);
  }
  if (sigs.length < THRESHOLD) throw new Error(`Only ${sigs.length}/${THRESHOLD} signatures available`);

  // messageIdMultisig metadata: originMerkleTreeHook(32) | root(32) | index(4) | signatures...
  const innerHex =
    pad32(MERKLE_TREE_HOOK) +
    root.replace(/^0x/, "") +
    treeIndex.toString(16).padStart(8, "0") +
    sigs.map(s => s.sig).join("");

  // aggregation wrapper: per submodule (start: u32, end: u32) header, then payloads
  // single submodule: header is 8 bytes, payload is innerHex
  const headerStart = 8;
  const headerEnd = headerStart + innerHex.length / 2;
  const aggHeader =
    headerStart.toString(16).padStart(8, "0") +
    headerEnd.toString(16).padStart(8, "0");
  const metadata = "0x" + aggHeader + innerHex;

  console.log("\nmetadata len:", (metadata.length - 2) / 2, "bytes");

  try {
    await mailbox.process.staticCall(metadata, message);
    console.log("staticCall OK, submitting...");
  } catch (e) {
    console.error("staticCall reverted:", e.shortMessage || e.message);
    if (e.data) console.error("revert data:", e.data);
    if (!process.env.FORCE) { console.error("Set FORCE=1 to submit anyway."); process.exit(1); }
  }

  const tx = await mailbox.process(metadata, message, {
    gasLimit: process.env.FORCE ? 600000n : undefined,
  });
  console.log("submitted:", tx.hash);
  const r2 = await tx.wait();
  console.log("status:", r2.status, "block:", r2.blockNumber, "gasUsed:", r2.gasUsed.toString());
}

main().catch(e => { console.error(e); process.exit(1); });
