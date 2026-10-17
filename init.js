import { Keypair, rpc, Contract, TransactionBuilder, Networks, BASE_FEE, Address, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

// Pool Blend v2 de test (blend-capital/blend-utils, testnet.contracts.json : TestnetV2)
const DEFAULT_BLEND_POOL_ID = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";

async function main() {
  const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const networkPassphrase = Networks.TESTNET;
  const contractId = process.env.CONTRACT_ID;
  if (!contractId) {
    throw new Error("CONTRACT_ID est manquant dans le fichier .env !");
  }

  const secretKey = process.env.ADMIN_SECRET_KEY;
  if (!secretKey) {
    throw new Error("ADMIN_SECRET_KEY est manquant dans le fichier .env !");
  }

  const agentSecretKey = process.env.AGENT_SECRET_KEY;
  if (!agentSecretKey) {
    throw new Error("AGENT_SECRET_KEY est manquant dans le fichier .env !");
  }

  const adminKeypair = Keypair.fromSecret(secretKey);
  const agentPublicKey = Keypair.fromSecret(agentSecretKey).publicKey();
  const blendPoolId = process.env.BLEND_POOL_ID || DEFAULT_BLEND_POOL_ID;

  const server = new rpc.Server(rpcUrl, { allowHttp: true });
  const contract = new Contract(contractId);

  // L'admin et le token sont fixés au déploiement par __constructor ;
  // il reste à autoriser l'agent et le pool Blend.
  console.log("Configuration de l'agent", agentPublicKey);
  await invoke(server, contract, adminKeypair, networkPassphrase, "set_agent",
    Address.fromString(agentPublicKey).toScVal());

  const pools = await read(server, contract, adminKeypair, networkPassphrase, "pools");
  if (Object.values(pools).includes(blendPoolId)) {
    console.log("Pool Blend déjà autorisé :", blendPoolId);
  } else {
    console.log("Autorisation du pool Blend", blendPoolId, "(id 1)");
    await invoke(server, contract, adminKeypair, networkPassphrase, "add_pool",
      nativeToScVal(1, { type: "u32" }), Address.fromString(blendPoolId).toScVal());
  }
}

async function read(server, contract, keypair, networkPassphrase, method, ...args) {
  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation de ${method} échouée : ${sim.error}`);
  }
  return scValToNative(sim.result.retval);
}

async function invoke(server, contract, keypair, networkPassphrase, method, ...args) {
  const account = await server.getAccount(keypair.publicKey());
  let transaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  console.log("Préparation (simulation & ajout de l'empreinte Soroban)");
  transaction = await server.prepareTransaction(transaction);
  transaction.sign(keypair);

  console.log("Envoi de la transaction sur le Testnet");
  const response = await server.sendTransaction(transaction);
  if (response.status !== "PENDING") {
    throw new Error(`Transaction rejetée (${response.status}) : ${JSON.stringify(response.errorResult ?? response)}`);
  }

  console.log("En attente de confirmation…", response.hash);
  const result = await server.pollTransaction(response.hash, { attempts: 30 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${method} a échoué (${result.status}), hachage : ${response.hash}`);
  }
  console.log(`${method} confirmé ! Hachage :`, response.hash);
}

main().catch(console.error);
