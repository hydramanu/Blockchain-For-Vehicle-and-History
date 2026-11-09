import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, ZeroHash } from "ethers";

export const rpcUrl = process.env.CHAIN_RPC_URL || "http://127.0.0.1:8545";
export const dataDir = process.env.AUTOTRUST_DATA_DIR
  ? resolve(process.env.AUTOTRUST_DATA_DIR)
  : fileURLToPath(new URL("../runtime/", import.meta.url));
export const deploymentFile = join(dataDir, "deployment.json");

const abi = [
  "function writer() view returns (address)",
  "function anchors(uint256 index) view returns (bytes32)",
  "function count() view returns (uint256)",
  "function anchorRecord(uint256 index, bytes32 digest, bytes32 previousHash)",
  "event RecordAnchored(uint256 indexed index, bytes32 indexed digest, bytes32 previousHash)",
  "error UnauthorizedWriter()",
];

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

const digestOf = (block) => "0x" + block.hash;
const previousOf = (block) => block.index === 0 ? ZeroHash : "0x" + block.previousHash;

export async function connectAnchor() {
  const deployment = await readJson(deploymentFile);
  if (!deployment) throw new Error("Run npm run chain:deploy before starting the server.");

  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const wallet = new Wallet(deployment.writerKey, provider);
  const contract = new Contract(deployment.address, abi, wallet);
  const network = await provider.getNetwork();
  if (String(network.chainId) !== deployment.chainId || await contract.writer() !== wallet.address) {
    throw new Error("The anchor deployment does not match the active chain or writer.");
  }

  return {
    address: deployment.address,
    chainId: deployment.chainId,
    count: async () => Number(await contract.count()),
    matches: async (block) => await contract.anchors(block.index) === digestOf(block),
    async anchor(block) {
      const current = await contract.anchors(block.index);
      if (current === ZeroHash) {
        const transaction = await contract.anchorRecord(block.index, digestOf(block), previousOf(block));
        const receipt = await transaction.wait();
        return { transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
      }
      if (current !== digestOf(block)) {
        throw new Error(`On-chain digest mismatch at ledger record ${block.index}.`);
      }
      const [event] = await contract.queryFilter(
        contract.filters.RecordAnchored(block.index, current), deployment.blockNumber,
      );
      if (!event) throw new Error(`Missing anchor event for ledger record ${block.index}.`);
      return { transactionHash: event.transactionHash, blockNumber: event.blockNumber };
    },
    async checkUnauthorizedRewrite(block, attemptedDigest) {
      const outsider = Wallet.createRandom().connect(provider);
      try {
        await contract.connect(outsider).anchorRecord.staticCall(
          block.index, attemptedDigest, previousOf(block),
        );
      } catch (error) {
        if (error.revert?.name === "UnauthorizedWriter") return true;
        throw error;
      }
      return false;
    },
  };
}
