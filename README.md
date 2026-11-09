# AutoTrust Ledger

A vehicle history demo for buyers, service companies, and sellers. Look up a VIN, append service or ownership records, and see ledger changes and tamper alerts live.

## Project Layout

| Path | Responsibility |
| --- | --- |
| `frontend/` | React dashboards, VIN lookup, photo upload, and browser-based odometer OCR |
| `backend/server.js` | Express API, SHA-256 ledger, seed data, and Socket.IO events |
| `scripts/prepare-ocr.js` | Copies the OCR worker, WebAssembly, and English model from the installed dependencies |
| `package.json` | Root commands for both applications |

The original ZIP is kept as a historical snapshot. The folders above contain the runnable source.

## Run Locally

Install Node.js 20.19+ on the 20.x line, or 22.12+. From the repository root:

```bash
npm ci
```

Start the API and UI in two terminals, both from the repository root:

```bash
# Terminal 1
npm run server

# Terminal 2
npm run dev
```

Open [the dashboard](http://localhost:5173/?role=buyer&apiPort=3001). Check the API at [the health endpoint](http://localhost:3001/api/health). On Windows, use `npm.cmd` in place of `npm` if PowerShell blocks npm's script.

`npm run lint` checks the source. `npm run build` writes the production frontend to `frontend/dist/`. With the API running, use `npm run preview` to preview that build on port `5173`. Stop the dev server first if it is using that port.

## Demo Workflow

1. In **Buyer**, verify `VIN1001` (Tata Nexon EV) or `VIN2002` (Hyundai Creta).
2. In **Service Company**, add a service, repair, accident, or insurance record. Upload an odometer photo and use the OCR result to match the entered reading.
3. In **Seller**, add a seller declaration or ownership transfer. Both roles can attach up to eight vehicle photos per record.
4. Watch the buyer history update live. To demonstrate tamper alerts, open the [security console](http://localhost:5173/?role=attacker&apiPort=3001) and attempt to change an existing block.

For a LAN demo, open `http://HOST-IP:5173/?apiPort=3001` on devices connected to the same network. The backend uses port `3001` by default. If you set its `PORT` environment variable, include the same port in the `apiPort` query parameter on every device.

## Ledger Scope

The Express process keeps a single in-memory hash chain and reloads its sample records at each restart. Roles are demo views. Odometer OCR runs in the browser, and the API compares the submitted OCR reading with the submitted mileage and the previous ledger reading.
