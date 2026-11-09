import { readFile } from "node:fs/promises";
import { ContractFactory, JsonRpcProvider, Wallet, parseEther } from "ethers";
import solc from "solc";
import { deploymentFile, readJson, rpcUrl, saveJson } from "../backend/chain.js";

const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
const { chainId } = await provider.getNetwork();
if (chainId !== 31337n) throw new Error("This demo deployer requires the local Hardhat chain (31337).");

const existing = await readJson(deploymentFile);
if (existing && await provider.getCode(existing.address) !== "0x") {
  console.log(`Anchor already deployed at ${existing.address}`);
} else {
  const name = "VehicleHistoryAnchor";
  const file = name + ".sol";
  const content = await readFile(new URL("../contracts/" + file, import.meta.url), "utf8");
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { [file]: { content } },
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const errors = result.errors?.filter((item) => item.severity === "error") || [];
  if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join("\n"));

  const artifact = result.contracts[file][name];
  const deployer = await provider.getSigner();
  const writer = Wallet.createRandom();
  await (await deployer.sendTransaction({ to: writer.address, value: parseEther("10") })).wait();

  const factory = new ContractFactory(artifact.abi, artifact.evm.bytecode.object, deployer);
  const contract = await factory.deploy(writer.address);
  const receipt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();
  await saveJson(deploymentFile, {
    address, chainId: String(chainId), blockNumber: receipt.blockNumber, writerKey: writer.privateKey,
  });
  console.log(`Deployed ${name} at ${address}\nDeployment transaction: ${receipt.hash}`);
}
provider.destroy();
