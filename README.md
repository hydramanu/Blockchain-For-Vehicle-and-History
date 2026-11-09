# AutoTrust Ledger

A blockchain and cybersecurity demo for used-vehicle history. Buyers can check a VIN against Ethereum, while service companies and sellers submit role-scoped records with odometer evidence. The security console demonstrates an unauthorized rewrite and anchors an audit record of the rejection.

## Project Layout

| Path | Responsibility |
| --- | --- |
| `frontend/` | React dashboards, VIN lookup, photo upload, and browser-based odometer OCR |
| `backend/` | Express API, hash-linked record storage, role sessions, server OCR, and live alerts |
| `contracts/VehicleHistoryAnchor.sol` | Writer-only, append-only Solidity contract for record digests |
| `scripts/deploy-ledger.js` | Compiles and deploys the contract with a dedicated local writer |
| `scripts/prepare-ocr.js` | Copies the OCR worker, WebAssembly, and English model from the installed dependencies |
| `package.json` | Root commands for both applications |

The original ZIP is kept as a historical snapshot. The folders above contain the runnable source.

## Run Locally

Install Node.js 20.19+ on the 20.x line, or 22.12+. From the repository root:

```bash
npm ci
```

Start the local Ethereum node, then deploy the contract from a second terminal:

```bash
# Terminal 1
npm run chain:node

# Terminal 2
npm run chain:deploy
npm run server
```

Start the frontend from a third terminal:

```bash
npm run dev
```

Open [the dashboard](http://localhost:5173/?role=buyer&apiPort=3001). Check the API at [the health endpoint](http://localhost:3001/api/health). On Windows, use `npm.cmd` in place of `npm` if PowerShell blocks npm's script.

The API creates `runtime/access.json` on first start. Use the `service`, `seller`, or `attacker` code to unlock the corresponding role. Buyer lookup is read-only and requires no code. Use demo data and keep the RPC and local writer key private.

`npm run lint` checks the source. `npm run build` writes the production frontend to `frontend/dist/`. With the API running, use `npm run preview` to preview that build on port `5173`. Stop the dev server first if it is using that port.

## Demo Workflow

1. In **Buyer**, verify `VIN1001` (Tata Nexon EV) or `VIN2002` (Hyundai Creta). Inspect the contract address and transaction receipts.
2. In **Service Company**, add a service, repair, accident, or insurance record. Use a tightly cropped odometer photo with clear digits. The backend independently reads the image and rejects inconsistent or lower mileage. It also rejects the same evidence file when it was used for another VIN.
3. In **Seller**, add a seller declaration or ownership transfer. Both roles can attach up to eight vehicle photos per record.
4. Watch the buyer history update live. Open the [security console](http://localhost:5173/?role=attacker&apiPort=3001) to simulate a write from an unauthorized Ethereum address. The API checks the Solidity revert, verifies that the original digest still matches, and anchors the alert with a separate transaction.

For a LAN demo, open `http://HOST-IP:5173/?apiPort=3001` on devices connected to the same network. The backend uses port `3001` by default. If you set its `PORT` environment variable, include the same port in the `apiPort` query parameter on every device.

## Ledger Scope

Records and photos persist in `runtime/ledger.json`. The contract stores SHA-256 digests and their ordering. `GET /api/vehicles/:vin/proof` compares the vehicle's record digests with the deployed contract. The API serializes writes and reloads the stored history on startup, including any candidate awaiting anchor confirmation.

Hardhat is a local development chain. After restarting the Hardhat node, run `npm run chain:deploy` again before starting the API. The local record file is re-anchored with fresh transactions on the new deployment. The shared role codes are for this demo. An on-chain digest proves integrity after recording, and OCR checks the reading visible in the photo. Establishing legal ownership or the authenticity of a photo requires independent evidence.
