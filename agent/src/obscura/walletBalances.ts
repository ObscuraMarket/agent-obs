// Print the desk's wallet as the chains and Obscura report it. Read-only.
//   npm run wallet:balances
import { WALLET_ADDRESS, EXPLORER_URL } from "../config.ts";
import { walletRead, walletLines } from "./reads.ts";

if (!WALLET_ADDRESS) {
  console.error("no OBS_WALLET_ADDRESS in .env; create the wallet with `npm run wallet -- create` and set the address");
  process.exit(1);
}
const w = await walletRead(WALLET_ADDRESS);
console.log(`${WALLET_ADDRESS}\n${EXPLORER_URL}/address/${WALLET_ADDRESS}\n${walletLines(w).join("\n")}`);
