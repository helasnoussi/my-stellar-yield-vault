import { Keypair, rpc, Contract, TransactionBuilder, Networks, BASE_FEE, Address } from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const rpcUrl = "https://soroban-testnet.stellar.org";
  const networkPassphrase = Networks.TESTNET;
  const contractId = process.env.CONTRACT_ID;
  if (!contractId) {
    throw new Error("CONTRACT_ID est manquant dans le fichier .env !");
  }
  
  const secretKey = process.env.ADMIN_SECRET_KEY;
  if (!secretKey) {
    throw new Error("ADMIN_SECRET_KEY est manquant dans le fichier .env !");
  }

  const adminKeypair = Keypair.fromSecret(secretKey);
  const adminPublicKey = adminKeypair.publicKey();

  const server = new rpc.Server(rpcUrl, { allowHttp: true });
  const contract = new Contract(contractId);

  console.log("Récupération des informations du compte admin...");
  const account = await server.getAccount(adminPublicKey);

  console.log("Construction de la transaction d'initialisation...");

  // 1. Création de l'argument Admin (compte G...)
  const adminScVal = Address.fromString(adminPublicKey).toScVal();

  // 2. Création de l'argument Token (contrat C...) décodé via StrKey
  const tokenScVal = Address.fromString(
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
  ).toScVal();

  let transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call("initialize", adminScVal, tokenScVal)
    )
    .setTimeout(30)
    .build();

  console.log("Préparation (simulation & ajout de l'empreinte Soroban)...");
  transaction = await server.prepareTransaction(transaction);

  console.log("Signature de la transaction...");
  transaction.sign(adminKeypair);

  console.log("Envoi de la transaction sur le Testnet...");
  const response = await server.sendTransaction(transaction);
  console.log("Statut de la transaction:", response.status);

  if (response.status === "PENDING" || response.status === "SUCCESS") {
    console.log("Contrat initialisé avec succès ! Hachage :", response.hash);
  }
}

main().catch(console.error);