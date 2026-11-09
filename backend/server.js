import cors from "cors";
import crypto from "crypto";
import express from "express";
import http from "http";
import os from "os";
import { join } from "node:path";
import { Server } from "socket.io";
import { connectAnchor, dataDir, readJson, saveJson } from "./chain.js";
import { decodeOdometerPhoto, readOdometerPhoto } from "./odometer.js";
import { createAccessControl, rateLimit } from "./security.js";

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "12mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "0.0.0.0";
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT) || 5173;

const ROLE_LABELS = {
  buyer: "Buyer",
  service: "Service Company",
  seller: "Seller",
  attacker: "Security Console",
  observer: "Observer",
};

const SECURITY_NODE = "AutoTrust Shield";
const recordTypes = {
  service: ["Registration", "Service", "Repair", "Accident", "Insurance Claim"],
  seller: ["Seller Declaration", "Ownership Transfer"],
};
const access = await createAccessControl();
const anchor = await connectAnchor();
const storeFile = join(dataDir, "ledger.json");

let notifications = [];
const chain = [];
let writeQueue = Promise.resolve();
let pendingWrites = 0;
let writeHealthy = true;

const asyncRoute = (handler) => (req, res, next) => handler(req, res).catch(next);

function serializedWrite(handler) {
  return asyncRoute(async (req, res) => {
    if (pendingWrites >= 4) return res.status(429).json({ error: "The evidence queue is full. Try again shortly." });
    pendingWrites++;
    const operation = writeQueue.then(() => {
      if (!writeHealthy) return res.status(503).json({ error: "Anchor recovery required. Restart the API after restoring the chain." });
      return handler(req, res);
    });
    writeQueue = operation.catch(() => {});
    try {
      await operation;
    } finally {
      pendingWrites--;
    }
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function calculateHash(block) {
  return crypto
    .createHash("sha256")
    .update(
      stableStringify({
        index: block.index,
        timestamp: block.timestamp,
        previousHash: block.previousHash,
        data: block.data,
        author: block.author,
      }),
    )
    .digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  Object.values(value).forEach((child) => deepFreeze(child));
  return value;
}

function normalizeVin(vin) {
  return String(vin || "").trim().toUpperCase();
}

function normalizePhotoUrl(photoUrl) {
  const value = String(photoUrl || "").trim();

  if (!value) {
    return "";
  }

  if (value.startsWith("data:image/") || /^https?:\/\//i.test(value)) {
    return value;
  }

  return "";
}

function normalizePhotoUrls(photoUrls) {
  const list = Array.isArray(photoUrls) ? photoUrls : [photoUrls];
  const uniqueUrls = [];

  list.forEach((photoUrl) => {
    const normalized = normalizePhotoUrl(photoUrl);

    if (normalized && !uniqueUrls.includes(normalized)) {
      uniqueUrls.push(normalized);
    }
  });

  return uniqueUrls.slice(0, 8);
}

function getBlockPhotoUrls(block) {
  return normalizePhotoUrls([
    ...(Array.isArray(block.data?.photoUrls) ? block.data.photoUrls : []),
    block.data?.photoUrl,
    ...(Array.isArray(block.data?.vehicle?.photoUrls) ? block.data.vehicle.photoUrls : []),
    block.data?.vehicle?.photoUrl,
  ]);
}

function createGenesisBlock() {
  const genesis = {
    index: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
    previousHash: "0",
    data: {
      category: "system",
      type: "Genesis",
      vin: "GENESIS",
      description: "AutoTrust Ledger network initialized",
      odometer: 0,
      owner: "Network",
      company: "AutoTrust",
    },
    author: "system",
    hash: "",
  };

  genesis.hash = calculateHash(genesis);
  return deepFreeze(genesis);
}

function getLatestBlock() {
  return chain[chain.length - 1];
}

function makeBlock(data, author, timestamp = new Date().toISOString()) {
  const block = {
    index: chain.length,
    timestamp,
    previousHash: getLatestBlock().hash,
    data: clone(data),
    author,
    hash: "",
  };

  block.hash = calculateHash(block);
  return block;
}

async function appendAnchoredBlock(data, author) {
  const block = makeBlock(data, author);
  // Save the candidate before sending so a restart can recover a mined transaction.
  await saveJson(storeFile, [...chain, block]);
  try {
    block.proof = await anchor.anchor(block);
  } catch (error) {
    writeHealthy = false;
    console.error("Anchor write failed:", error.shortMessage || error.message);
    return null;
  }
  chain.push(deepFreeze(block));
  return block;
}

function isChainValid() {
  if (!chain.length) {
    return false;
  }

  if (chain[0].previousHash !== "0" || calculateHash(chain[0]) !== chain[0].hash) {
    return false;
  }

  for (let i = 1; i < chain.length; i += 1) {
    const current = chain[i];
    const previous = chain[i - 1];

    if (current.index !== i) {
      return false;
    }

    if (current.previousHash !== previous.hash) {
      return false;
    }

    if (calculateHash(current) !== current.hash) {
      return false;
    }
  }

  return true;
}

function getVehicleBlocks(vin) {
  const targetVin = normalizeVin(vin);
  return chain.filter(
    (block) =>
      block.index > 0 &&
      normalizeVin(block.data?.vin) === targetVin &&
      block.data?.category !== "security",
  );
}

function summarizeVehicle(vin) {
  const records = getVehicleBlocks(vin);

  if (!records.length) {
    return null;
  }

  const registration = records.find((block) => block.data.type === "Registration") || records[0];
  const latestRecord = records[records.length - 1];
  const photoUrls = [];
  records
    .slice()
    .reverse()
    .forEach((block) => {
      getBlockPhotoUrls(block).forEach((photoUrl) => {
        if (!photoUrls.includes(photoUrl)) {
          photoUrls.push(photoUrl);
        }
      });
    });
  const photoUrl = photoUrls[0] || "";
  const odometerBlocks = records.filter((block) => Number.isFinite(Number(block.data.odometer)));
  const currentOdometer = odometerBlocks.length
    ? Number(odometerBlocks[odometerBlocks.length - 1].data.odometer)
    : 0;
  const latestOdometerProofBlock = records
    .slice()
    .reverse()
    .find((block) => block.data.odometerPhotoUrl);
  const odometerProof = latestOdometerProofBlock
    ? {
        photoUrl: latestOdometerProofBlock.data.odometerPhotoUrl,
        reading: latestOdometerProofBlock.data.odometerPhotoReading,
        ocrConfidence: latestOdometerProofBlock.data.odometerOcrConfidence,
        ocrText: latestOdometerProofBlock.data.odometerOcrText,
        verified: Boolean(latestOdometerProofBlock.data.odometerVerified),
        blockIndex: latestOdometerProofBlock.index,
        timestamp: latestOdometerProofBlock.timestamp,
      }
    : null;
  const accidentCount = records.filter((block) => block.data.type === "Accident").length;
  const serviceCount = records.filter((block) =>
    ["Service", "Repair", "Insurance Claim"].includes(block.data.type),
  ).length;

  return {
    vin: normalizeVin(vin),
    owner: latestRecord.data.owner || registration.data.owner,
    company: latestRecord.data.company || registration.data.company,
    photoUrl,
    photoUrls,
    vehicle: {
      ...(registration.data.vehicle || {
        make: "Unknown",
        model: "Unknown",
        year: "Unknown",
        color: "Unknown",
        plate: "Unassigned",
      }),
      photoUrl: registration.data.vehicle?.photoUrl || photoUrl,
      photoUrls,
    },
    currentOdometer,
    odometerProof,
    accidentCount,
    serviceCount,
    lastBlockIndex: latestRecord.index,
    lastHash: latestRecord.hash,
    firstRegisteredAt: registration.timestamp,
    records,
  };
}

function listVehicles() {
  const vins = new Set();
  chain.forEach((block) => {
    if (block.index > 0 && block.data?.vin && block.data.category !== "security") {
      vins.add(normalizeVin(block.data.vin));
    }
  });

  return Array.from(vins)
    .map((vin) => summarizeVehicle(vin))
    .filter(Boolean)
    .sort((a, b) => a.vin.localeCompare(b.vin));
}

function getSecurityEvents() {
  return chain
    .filter((block) => block.data?.category === "security")
    .slice()
    .reverse();
}

function getLanUrls() {
  const urls = [];
  const interfaces = os.networkInterfaces();

  Object.values(interfaces).forEach((addresses = []) => {
    addresses.forEach((address) => {
      if (address.family === "IPv4" && !address.internal) {
        urls.push({
          address: address.address,
          frontend: `http://${address.address}:${FRONTEND_PORT}`,
          api: `http://${address.address}:${PORT}`,
        });
      }
    });
  });

  return urls;
}

function roleCounts() {
  const counts = {
    buyer: 0,
    service: 0,
    seller: 0,
    attacker: 0,
    observer: 0,
  };

  io.of("/").sockets.forEach((socket) => {
    const role = socket.data.role || "observer";
    counts[role] = (counts[role] || 0) + 1;
  });

  return counts;
}

function getState() {
  return {
    chain,
    valid: writeHealthy && isChainValid(),
    blockchain: { address: anchor.address, chainId: anchor.chainId },
    vehicles: listVehicles(),
    securityEvents: getSecurityEvents(),
    notifications,
    network: {
      roles: roleCounts(),
      lanUrls: getLanUrls(),
      frontendPort: FRONTEND_PORT,
      apiPort: PORT,
    },
  };
}

function broadcastState() {
  io.emit("state", getState());
  io.emit("chainUpdated", chain);
}

function emitNotification({ title, message, level = "info", vin, targetRoles = [] }) {
  const note = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
    title,
    message,
    level,
    vin,
    targetRoles,
    timestamp: new Date().toISOString(),
  };

  notifications = [note, ...notifications].slice(0, 60);
  io.emit("notification", note);
  return note;
}

function seedLedger() {
  chain.push(createGenesisBlock());

  const seedBlocks = [
    {
      timestamp: "2026-01-07T09:30:00.000Z",
      author: "RTO Bengaluru",
      data: {
        category: "vehicle",
        type: "Registration",
        vin: "VIN1001",
        odometer: 0,
        description: "Chassis VIN1001 registered with owner and factory identity.",
        owner: "Rahul Mehta",
        company: "RTO Bengaluru",
        vehicle: {
          make: "Tata",
          model: "Nexon EV",
          year: "2023",
          color: "Blue",
          plate: "KA-01-AT-1001",
        },
      },
    },
    {
      timestamp: "2026-02-11T11:20:00.000Z",
      author: "AutoTrust Service Hub",
      data: {
        category: "vehicle",
        type: "Service",
        vin: "VIN1001",
        odometer: 12450,
        description: "Periodic service completed; brake pads inspected and battery health certified.",
        owner: "Rahul Mehta",
        company: "AutoTrust Service Hub",
      },
    },
    {
      timestamp: "2026-03-04T14:10:00.000Z",
      author: "SafeClaim Insurance",
      data: {
        category: "vehicle",
        type: "Accident",
        vin: "VIN1001",
        odometer: 15820,
        description: "Minor front bumper repair after parking impact; no structural damage reported.",
        owner: "Rahul Mehta",
        company: "SafeClaim Insurance",
      },
    },
    {
      timestamp: "2026-01-12T10:00:00.000Z",
      author: "RTO Pune",
      data: {
        category: "vehicle",
        type: "Registration",
        vin: "VIN2002",
        odometer: 0,
        description: "Chassis VIN2002 registered with verified ownership documents.",
        owner: "Asha Nair",
        company: "RTO Pune",
        vehicle: {
          make: "Hyundai",
          model: "Creta",
          year: "2022",
          color: "White",
          plate: "MH-12-AT-2002",
        },
      },
    },
    {
      timestamp: "2026-03-18T12:45:00.000Z",
      author: "Metro Motors Service",
      data: {
        category: "vehicle",
        type: "Repair",
        vin: "VIN2002",
        odometer: 28410,
        description: "Suspension bush replacement and wheel alignment completed.",
        owner: "Asha Nair",
        company: "Metro Motors Service",
      },
    },
  ];

  seedBlocks.forEach((block) => chain.push(makeBlock(block.data, block.author, block.timestamp)));
}

function validateRecordPayload(payload, role) {
  const vin = normalizeVin(payload.vin);
  const type = String(payload.type || "").trim();
  const description = String(payload.description || "").trim();
  const owner = String(payload.owner || "").trim();
  const company = String(payload.company || "").trim();
  const author = ROLE_LABELS[role];
  const odometer = payload.odometer;
  const photoUrls = normalizePhotoUrls([
    ...(Array.isArray(payload.photoUrls) ? payload.photoUrls : []),
    payload.photoUrl,
    ...(Array.isArray(payload.vehicle?.photoUrls) ? payload.vehicle.photoUrls : []),
    payload.vehicle?.photoUrl,
  ]);
  const photoUrl = photoUrls[0] || "";
  const odometerPhotoUrl = payload.odometerPhotoUrl;
  if (!/^[A-Z0-9-]{3,32}$/.test(vin) || !type || !description || !owner || !company ||
      description.length > 2000 || owner.length > 160 || company.length > 160) {
    return { error: "Enter a valid VIN, record type, description, owner, and company." };
  }
  if (!recordTypes[role].includes(type)) {
    return { status: 403, error: "This role cannot submit that record type." };
  }
  if (!Number.isSafeInteger(odometer) || odometer < 0 || odometer > 9999999) {
    return { error: "Odometer must be a whole number between 0 and 9,999,999 km." };
  }

  return {
    vin,
    type,
    description,
    owner,
    company,
    author,
    odometer,
    odometerPhotoUrl,
    photoUrl,
    photoUrls,
    vehicle: {
      make: String(payload.make || payload.vehicle?.make || "Unknown").trim() || "Unknown",
      model: String(payload.model || payload.vehicle?.model || "Unknown").trim() || "Unknown",
      year: String(payload.year || payload.vehicle?.year || "Unknown").trim() || "Unknown",
      color: String(payload.color || payload.vehicle?.color || "Unknown").trim() || "Unknown",
      plate: String(payload.plate || payload.vehicle?.plate || "Unassigned").trim() || "Unassigned",
      photoUrl,
      photoUrls,
    },
  };
}

app.get("/api/health", (req, res) => {
  res.status(writeHealthy ? 200 : 503).json({ ok: writeHealthy, valid: writeHealthy && isChainValid(), blocks: chain.length });
});

app.post("/api/session", rateLimit(8, 60_000), access.login);

app.get("/api/state", (req, res) => {
  res.json(getState());
});

app.get("/api/chain", (req, res) => {
  res.json(getState());
});

app.get("/api/vehicles/:vin", (req, res) => {
  const vehicle = summarizeVehicle(req.params.vin);

  if (!vehicle) {
    return res.status(404).json({ error: "Vehicle not found in ledger." });
  }

  return res.json({ vehicle, valid: isChainValid() });
});

app.get("/api/vehicles/:vin/proof", rateLimit(60, 60_000), asyncRoute(async (req, res) => {
  const records = getVehicleBlocks(req.params.vin);
  if (!records.length) return res.status(404).json({ error: "Vehicle not found in ledger." });
  const matches = await Promise.all(records.map(async (block) => ({
    index: block.index,
    digest: "0x" + block.hash,
    ...block.proof,
    verified: await anchor.matches(block),
  })));
  res.json({
    vin: normalizeVin(req.params.vin),
    valid: isChainValid() && matches.every((proof) => proof.verified),
    contract: anchor.address,
    chainId: anchor.chainId,
    records: matches,
  });
}));

const writeLimit = rateLimit(20, 60_000);
app.post("/api/record", writeLimit, access.requireRole("service", "seller"), serializedWrite(async (req, res) => {
  const payload = validateRecordPayload(req.body || {}, req.accessRole);

  if (payload.error) {
    return res.status(payload.status || 400).json({ error: payload.error });
  }

  const existingVehicle = summarizeVehicle(payload.vin);
  if (Boolean(existingVehicle) === (payload.type === "Registration")) {
    return res.status(409).json({ error: existingVehicle ? "This VIN is already registered." : "Register this VIN before adding history." });
  }

  if (existingVehicle && payload.odometer < existingVehicle.currentOdometer) {
    emitNotification({
      title: "Odometer rollback rejected",
      message: `${payload.author} tried to add ${payload.odometer} km for ${payload.vin}, below the verified ${existingVehicle.currentOdometer} km reading.`,
      level: "alert",
      vin: payload.vin,
      targetRoles: ["buyer", "service", "seller"],
    });

    return res.status(409).json({
      error: "Odometer rollback rejected. Existing blockchain history cannot be overwritten.",
      valid: isChainValid(),
      vehicle: existingVehicle,
    });
  }

  const photo = decodeOdometerPhoto(payload.odometerPhotoUrl);
  if (!photo) return res.status(400).json({ error: "Upload a JPEG or PNG odometer photo (max 2 MB and 2000 pixels per side)." });
  if (chain.some((block) => block.data.odometerEvidenceHash === photo.hash && block.data.vin !== payload.vin)) {
    return res.status(409).json({ error: "This odometer photo has already been used for another VIN." });
  }
  const ocr = await readOdometerPhoto(photo.bytes, payload.odometer);
  if (!ocr.matched) {
    return res.status(422).json({ error: "Server OCR could not confirm that reading. Upload a clear, cropped photo of the odometer." });
  }

  const block = await appendAnchoredBlock(
    {
      category: "vehicle",
      type: payload.type,
      vin: payload.vin,
      odometer: payload.odometer,
      description: payload.description,
      owner: payload.owner,
      company: payload.company,
      odometerPhotoUrl: payload.odometerPhotoUrl || undefined,
      odometerPhotoReading: payload.odometer,
      odometerOcrConfidence: ocr.confidence,
      odometerOcrText: ocr.text,
      odometerVerified: true,
      odometerEvidenceHash: photo.hash,
      photoUrl: payload.photoUrl || undefined,
      photoUrls: payload.photoUrls.length ? payload.photoUrls : undefined,
      vehicle: payload.type === "Registration" ? payload.vehicle : undefined,
    },
    payload.author,
  );
  if (!block) return res.status(503).json({ error: "Anchor confirmation failed. The record is pending recovery." });

  const vehicle = summarizeVehicle(payload.vin);
  emitNotification({
    title: "Record added to blockchain",
    message: `${payload.type} for ${payload.vin} was sealed in block #${block.index}. Buyer, seller, and service company can verify it now.`,
    level: "success",
    vin: payload.vin,
    targetRoles: ["buyer", "service", "seller"],
  });
  broadcastState();

  return res.json({ success: true, block, vehicle, valid: isChainValid() });
}));

app.post("/api/tamper", writeLimit, access.requireRole("attacker"), serializedWrite(async (req, res) => {
  const body = req.body || {};
  const vin = normalizeVin(body.vin);
  const fakeDescription = String(body.fakeDescription || "").trim();
  const fakeOdometer = Number(body.fakeOdometer);
  const sourceId = String(body.requestedBy || "external-write-source").trim();
  const targetIndex = Number(body.targetIndex);
  const vehicleBlocks = getVehicleBlocks(vin);
  const targetBlock = Number.isInteger(targetIndex)
    ? vehicleBlocks.find((block) => block.index === targetIndex)
    : vehicleBlocks.at(-1);

  if (!vin || !fakeDescription || fakeDescription.length > 2000 || !sourceId || sourceId.length > 160) {
    return res.status(400).json({ error: "VIN and attempted change details are required." });
  }

  if (!targetBlock) {
    emitNotification({
      title: "Tamper attempt blocked",
      message: `An unauthorized write request targeted ${vin}, but no matching vehicle block exists. Nothing was changed.`,
      level: "alert",
      vin,
      targetRoles: ["buyer", "service", "seller"],
    });

    return res.status(404).json({
      success: false,
      reason: "Target vehicle block was not found. Nothing was changed.",
      valid: isChainValid(),
    });
  }

  const attemptedDigest = "0x" + calculateHash({
    ...targetBlock,
    data: { ...targetBlock.data, description: fakeDescription, odometer: fakeOdometer },
  });
  if (!await anchor.checkUnauthorizedRewrite(targetBlock, attemptedDigest) || !await anchor.matches(targetBlock)) {
    return res.status(503).json({ error: "Could not verify that the contract blocked the rewrite." });
  }

  const alertBlock = await appendAnchoredBlock(
    {
      category: "security",
      type: "Tamper Attempt Blocked",
      vin,
      odometer: Number.isFinite(fakeOdometer) ? fakeOdometer : targetBlock.data.odometer,
      description: `Blocked tamper attempt: ${fakeDescription}`,
      owner: targetBlock.data.owner,
      company: targetBlock.data.company,
      targetBlockIndex: targetBlock.index,
      originalHash: targetBlock.hash,
      attemptedDigest,
      contractRevert: "UnauthorizedWriter",
      attemptedChange: {
        fakeOdometer: Number.isFinite(fakeOdometer) ? fakeOdometer : null,
        fakeDescription,
      },
      sourceFingerprint: crypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 16),
      outcome: "blocked",
      reason: "Existing vehicle blocks are hash-linked and append-only.",
    },
    SECURITY_NODE,
  );
  if (!alertBlock) return res.status(503).json({ error: "The security alert is pending anchor recovery." });

  const note = emitNotification({
    title: "Unauthorized write blocked",
    message: `An unauthorized write request tried to modify ${vin} block #${targetBlock.index}. The original hash stayed ${targetBlock.hash.slice(0, 14)}... and alert block #${alertBlock.index} was added.`,
    level: "alert",
    vin,
    targetRoles: ["buyer", "service", "seller"],
  });

  io.emit("tamperAlert", note);
  broadcastState();

  return res.json({
    success: false,
    reason: "The Solidity contract rejected the simulated write. The original digest still matches and the alert was anchored.",
    targetBlock,
    alertBlock,
    valid: isChainValid(),
  });
}));

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.status === 400 || error.status === 413) {
    return res.status(error.status).json({ error: error.status === 413 ? "Upload is too large." : "Invalid request body." });
  }
  console.error(error.shortMessage || error.message);
  res.status(503).json({ error: "Verification service is temporarily unavailable." });
});

io.on("connection", (socket) => {
  socket.data.role = "observer";
  socket.emit("state", getState());
  socket.emit("notification", {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
    title: "Connected",
    message: "Connected to the AutoTrust blockchain node.",
    level: "info",
    targetRoles: [],
    timestamp: new Date().toISOString(),
  });

  socket.on("joinRole", (role) => {
    const nextRole = ROLE_LABELS[role] ? role : "observer";
    const previousRole = socket.data.role;

    if (previousRole) {
      socket.leave(previousRole);
    }

    socket.data.role = nextRole;
    socket.join(nextRole);
    broadcastState();
  });

  socket.on("disconnect", () => {
    broadcastState();
  });
});

const saved = await readJson(storeFile);
if (saved) {
  chain.push(...saved);
} else {
  seedLedger();
  await saveJson(storeFile, chain);
}
if (!isChainValid() || await anchor.count() > chain.length) {
  throw new Error("Local ledger does not match the on-chain history. Refusing to start.");
}
for (const block of chain) {
  chain[block.index] = deepFreeze({ ...block, proof: await anchor.anchor(block) });
}

server.listen(PORT, HOST, () => {
  const lanUrls = getLanUrls();
  console.log(`AutoTrust blockchain server running on http://localhost:${PORT}`);
  lanUrls.forEach((url) => {
    console.log(`LAN frontend: ${url.frontend}`);
    console.log(`LAN API: ${url.api}`);
  });
});
