import { Keypair, Networks, rpc, TransactionBuilder, nativeToScVal, Address, TimeoutInfinite, Operation, xdr } from "@stellar/stellar-sdk";
import * as dotenv from "dotenv";
dotenv.config();
// Network and Soroban RPC server configuration (Testnet)
const HORIZON_RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const server = new rpc.Server(HORIZON_RPC_URL);
// Bot secret key and deployed contract ID
const BOT_SECRET = process.env.BOT_SECRET_KEY || "YOUR_BOT_SECRET_KEY_HERE";
const botKeypair = Keypair.fromSecret(BOT_SECRET);
const CONTRACT_ID = "CDOZVZBKW7PHQ4CNV65E66PM7DS6RMDJI5FUSLCYJBNJ3GJFGS4HVJHW";
// Lock to prevent overlapping execution loops
let isExecuting = false;
async function runAIAgentLoop() {
    if (isExecuting) {
        console.log("⏳ [AI Agent] An analysis is already in progress, skipping this cycle...");
        return;
    }
    isExecuting = true;
    try {
        console.log("\n--------------------------------------------------");
        console.log("🤖 [AI Agent] Starting a new analysis cycle...");
        // 1. DECISION STEP (Simulating AI logic for the hackathon)
        const chosenStrategyId = await decideStrategyWithAI();
        console.log(`💡 [AI Agent] Chosen strategy: ID ${chosenStrategyId}`);
        // 2. ON-CHAIN EXECUTION STEP
        await executeOnChainStrategy(chosenStrategyId);
    }
    catch (error) {
        console.error("❌ [AI Agent] Error in cycle:", error);
    }
    finally {
        isExecuting = false;
        console.log("💤 [AI Agent] Waiting for the next cycle...");
    }
}
async function decideStrategyWithAI() {
    // You can replace this later with an actual LLM call or a yield API query
    const randomStrategy = Math.floor(Math.random() * 3) + 1;
    return randomStrategy;
}
async function executeOnChainStrategy(strategyId) {
    try {
        console.log("⛓️ [Stellar] Preparing Soroban transaction...");
        // 1. Load the bot account
        const account = await server.getAccount(botKeypair.publicKey());
        const contractAddress = Address.fromString(CONTRACT_ID);
        // 2. Create the contract invocation operation
        const invokeOp = Operation.invokeHostFunction({
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
                contractAddress: contractAddress.toScAddress(),
                functionName: "execute_strategy",
                args: [nativeToScVal(strategyId, { type: "u32" })]
            })),
            auth: []
        });
        // 3. Build the base transaction
        const tx = new TransactionBuilder(account, {
            fee: "100000",
            networkPassphrase: NETWORK_PASSPHRASE
        })
            .addOperation(invokeOp)
            .setTimeout(TimeoutInfinite)
            .build();
        // 4. Prepare the transaction (automatically simulates and adds Soroban footprint/resources)
        console.log("🔍 Simulating and preparing transaction...");
        const preparedTx = await server.prepareTransaction(tx);
        // 5. Sign the prepared transaction with the bot keypair
        preparedTx.sign(botKeypair);
        // 6. Send the transaction to the network
        console.log("🚀 Sending transaction to the Soroban network...");
        const response = await server.sendTransaction(preparedTx);
        // 7. Verify response hash
        if (response.hash) {
            console.log(`✅ Success! Strategy ${strategyId} sent. Hash: ${response.hash}`);
        }
        else {
            console.error("⚠️ Transaction status:", response);
        }
    }
    catch (error) {
        console.error("❌ Error during on-chain execution:", error);
    }
}
// ==========================================
// AGENT LAUNCH
// ==========================================
runAIAgentLoop();
// Loop every 30 seconds 
setInterval(runAIAgentLoop, 30 * 1000);
//# sourceMappingURL=agent.js.map