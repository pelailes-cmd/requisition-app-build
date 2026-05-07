require("dotenv").config();

const cors = require("cors");
const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
const port = Number(process.env.PORT || 4000);
const otpExpiresMinutes = Number(process.env.OTP_EXPIRES_MINUTES || 10);
const managerStatusOptions = ["Draft", "Submitted", "Review", "Approved", "Ordered", "Received", "Rejected"];
const procurementStatusOptions = ["Purchased", "Delivered", "On-Bidding", "For Quotation", "Under Cost Control"];
const statusOptions = [...managerStatusOptions, ...procurementStatusOptions];
const pendingCodes = new Map();
const usePostgres = Boolean(process.env.DATABASE_URL);

let sqliteDb;
let pgPool;

if (usePostgres) {
  const { Pool } = require("pg");

  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
  });
} else {
  const { DatabaseSync } = require("node:sqlite");
  const dataDir = path.join(__dirname, "data");
  const dbPath = path.join(dataDir, "requisition.sqlite");

  fs.mkdirSync(dataDir, { recursive: true });
  sqliteDb = new DatabaseSync(dbPath);
}

app.use(cors());
app.use(express.json());

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : true,
  requireTLS: true,
  connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 15000),
  greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 15000),
  socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 20000),
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    database: usePostgres ? "postgres" : "sqlite",
    emailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  });
});

app.get("/accounts", async (req, res) => {
  res.json({ accounts: await getAccounts() });
});

app.get("/accounts/managers", async (req, res) => {
  const accounts = await getAccounts();
  res.json({ managers: accounts.filter((account) => account.role === "Manager") });
});

app.get("/requisitions", async (req, res) => {
  res.json({ requisitions: await getRequisitions() });
});

app.post("/requisitions", async (req, res) => {
  const requisition = readRequisitionBody(req.body);
  const changedBy = readChangedBy(req.body);

  if (!requisition.item || !requisition.quantity || !requisition.requestedBy || !requisition.chargeTo) {
    return res.status(400).json({ error: "Item, quantity, requested by, and charge to are required." });
  }

  const id = await getNextRequisitionId();
  await createRequisition(id, requisition);
  await addRequisitionHistory(id, "Created request", changedBy, "New requisition submitted.");

  return res.status(201).json({ requisition: await getRequisitionById(id) });
});

app.put("/requisitions/:id", async (req, res) => {
  const id = cleanText(req.params.id);
  const existing = await getRequisitionById(id);
  const requisition = readRequisitionBody(req.body);
  const changedBy = readChangedBy(req.body);

  if (!existing) {
    return res.status(404).json({ error: "Requisition not found." });
  }

  if (!requisition.item || !requisition.quantity || !requisition.requestedBy || !requisition.chargeTo) {
    return res.status(400).json({ error: "Item, quantity, requested by, and charge to are required." });
  }

  await updateRequisition(id, requisition);
  await addRequisitionHistory(id, "Edited request", changedBy, summarizeRequisitionChanges(existing, requisition));
  return res.json({ requisition: await getRequisitionById(id) });
});

app.patch("/requisitions/:id/status", async (req, res) => {
  const id = cleanText(req.params.id);
  const status = cleanText(req.body.status);
  const statusType = cleanText(req.body.statusType) === "procurement" ? "procurement" : "manager";
  const changedBy = readChangedBy(req.body);
  const existing = await getRequisitionById(id);

  if (!existing) {
    return res.status(404).json({ error: "Requisition not found." });
  }

  if (!isValidStatus(status, statusType)) {
    return res.status(400).json({ error: "Invalid status." });
  }

  await updateRequisitionStatus(id, status, statusType);
  await addRequisitionHistory(
    id,
    statusType === "procurement" ? "Changed procurement status" : "Changed manager status",
    changedBy,
    `${statusType === "procurement" ? existing.procurementStatus || "Not set" : existing.status} to ${status}`
  );
  return res.json({ requisition: await getRequisitionById(id) });
});

app.patch("/requisitions/:id/delivery", async (req, res) => {
  const id = cleanText(req.params.id);
  const confirmation = cleanText(req.body.confirmation);
  const remarks = cleanText(req.body.remarks);
  const changedBy = readChangedBy(req.body);
  const existing = await getRequisitionById(id);

  if (!existing) {
    return res.status(404).json({ error: "Requisition not found." });
  }

  if (existing.procurementStatus !== "Delivered") {
    return res.status(400).json({ error: "Only delivered requisitions can be confirmed." });
  }

  if (!isValidDeliveryConfirmation(confirmation)) {
    return res.status(400).json({ error: "Invalid delivery confirmation." });
  }

  if (confirmation === "With Discrepancy" && !remarks) {
    return res.status(400).json({ error: "Remarks are required when there is a discrepancy." });
  }

  await updateDeliveryConfirmation(id, confirmation, confirmation === "With Discrepancy" ? remarks : "");
  await addRequisitionHistory(
    id,
    "Updated delivery confirmation",
    changedBy,
    confirmation === "With Discrepancy" ? `${confirmation}: ${remarks}` : confirmation
  );
  return res.json({ requisition: await getRequisitionById(id) });
});

app.delete("/requisitions/:id", async (req, res) => {
  const id = cleanText(req.params.id);

  if (!(await getRequisitionById(id))) {
    return res.status(404).json({ error: "Requisition not found." });
  }

  await deleteRequisition(id);
  return res.json({ ok: true });
});

app.post("/auth/login", async (req, res) => {
  const username = cleanText(req.body.username).toLowerCase();
  const password = cleanText(req.body.password);
  const role = cleanText(req.body.role);

  if (!username || !password || !role) {
    return res.status(400).json({ error: "Username, password, and role are required." });
  }

  const account = await getAccountForLogin(username, password, role);

  if (!account) {
    return res.status(401).json({ error: "Account not found." });
  }

  return res.json({ account });
});

app.post("/accounts", async (req, res) => {
  const account = {
    username: cleanText(req.body.username),
    password: cleanText(req.body.password),
    email: normalizeEmail(req.body.email),
    firstName: cleanText(req.body.firstName),
    middleName: cleanText(req.body.middleName),
    lastName: cleanText(req.body.lastName),
    department: cleanText(req.body.department),
    trade: cleanText(req.body.trade),
    head: cleanText(req.body.head),
    managerUsername: cleanText(req.body.managerUsername),
    role: cleanText(req.body.role)
  };

  if (
    !account.username ||
    !account.password ||
    !account.email ||
    !account.firstName ||
    !account.lastName ||
    !account.department ||
    !account.trade ||
    !account.head ||
    !account.managerUsername ||
    !account.role
  ) {
    return res.status(400).json({ error: "Missing required account information." });
  }

  if (await getAccountByUsername(account.username)) {
    return res.status(409).json({ error: "Username unavailable." });
  }

  await createAccount(account);
  return res.status(201).json({ account: await getAccountByUsername(account.username) });
});

app.post("/otp/request", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const role = cleanText(req.body.role);
  const managerUsername = cleanText(req.body.managerUsername);
  const managerEmail = normalizeEmail(req.body.managerEmail);
  const managerName = cleanText(req.body.managerName) || "Manager";

  if (!email || !role || !managerUsername || !managerEmail) {
    return res.status(400).json({ error: "Missing email, role, or manager information." });
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: "Gmail SMTP is not configured on the backend." });
  }

  const code = generateCode();
  const expiresAt = Date.now() + otpExpiresMinutes * 60 * 1000;
  const key = getCodeKey(email, role, managerUsername);

  pendingCodes.set(key, {
    code,
    expiresAt,
    used: false
  });

  try {
    await transporter.sendMail({
      from: `"Requisition App" <${process.env.GMAIL_USER}>`,
      to: managerEmail,
      subject: "One-time sign-up code",
      text: [
        `Hello ${managerName},`,
        "",
        `A user is requesting a ${role} account for the requisition app.`,
        `Applicant email: ${email}`,
        `One-time code: ${code}`,
        "",
        `This code expires in ${otpExpiresMinutes} minutes.`
      ].join("\n")
    });

    return res.json({ ok: true, expiresInMinutes: otpExpiresMinutes });
  } catch (error) {
    console.error("Failed to send OTP email:", {
      code: error?.code,
      command: error?.command,
      responseCode: error?.responseCode,
      message: error?.message
    });
    pendingCodes.delete(key);
    return res.status(502).json({ error: getMailErrorMessage(error) });
  }
});

app.post("/otp/verify", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const role = cleanText(req.body.role);
  const managerUsername = cleanText(req.body.managerUsername);
  const code = cleanText(req.body.code);
  const key = getCodeKey(email, role, managerUsername);
  const savedCode = pendingCodes.get(key);

  if (!email || !role || !managerUsername || !code) {
    return res.status(400).json({ valid: false, error: "Missing verification information." });
  }

  if (!savedCode || savedCode.used) {
    return res.status(400).json({ valid: false, error: "No active code was found." });
  }

  if (savedCode.expiresAt < Date.now()) {
    pendingCodes.delete(key);
    return res.status(400).json({ valid: false, error: "The code has expired." });
  }

  if (savedCode.code !== code) {
    return res.status(400).json({ valid: false, error: "The code is incorrect." });
  }

  pendingCodes.set(key, { ...savedCode, used: true });
  return res.json({ valid: true });
});

startServer();

async function startServer() {
  await initializeDatabase();

  app.listen(port, "0.0.0.0", () => {
    console.log(`Backend listening on http://0.0.0.0:${port} using ${usePostgres ? "PostgreSQL" : "SQLite"}`);
  });
}

async function initializeDatabase() {
  if (usePostgres) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        email TEXT NOT NULL,
        first_name TEXT NOT NULL,
        middle_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL,
        department TEXT NOT NULL,
        trade TEXT NOT NULL,
        head TEXT NOT NULL,
        manager_username TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS requisitions (
        id TEXT PRIMARY KEY,
        item TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        quantity TEXT NOT NULL,
        needed_date TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'Normal',
        requested_by TEXT NOT NULL,
        charge_to TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Submitted',
        procurement_status TEXT NOT NULL DEFAULT '',
        delivery_confirmation TEXT NOT NULL DEFAULT '',
        delivery_remarks TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS requisition_history (
        id SERIAL PRIMARY KEY,
        requisition_id TEXT NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        changed_by TEXT NOT NULL DEFAULT 'Unknown user',
        details TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pgPool.query("ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS charge_to TEXT NOT NULL DEFAULT ''");
    await pgPool.query("ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS procurement_status TEXT NOT NULL DEFAULT ''");
    await pgPool.query("ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS delivery_confirmation TEXT NOT NULL DEFAULT ''");
    await pgPool.query("ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS delivery_remarks TEXT NOT NULL DEFAULT ''");
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        email TEXT NOT NULL,
        firstName TEXT NOT NULL,
        middleName TEXT NOT NULL DEFAULT '',
        lastName TEXT NOT NULL,
        department TEXT NOT NULL,
        trade TEXT NOT NULL,
        head TEXT NOT NULL,
        managerUsername TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS requisitions (
        id TEXT PRIMARY KEY,
        item TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        quantity TEXT NOT NULL,
        neededDate TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'Normal',
        requestedBy TEXT NOT NULL,
        chargeTo TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Submitted',
        procurementStatus TEXT NOT NULL DEFAULT '',
        deliveryConfirmation TEXT NOT NULL DEFAULT '',
        deliveryRemarks TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS requisition_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requisitionId TEXT NOT NULL,
        action TEXT NOT NULL,
        changedBy TEXT NOT NULL DEFAULT 'Unknown user',
        details TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (requisitionId) REFERENCES requisitions(id) ON DELETE CASCADE
      );
    `);

    addSqliteColumnIfMissing("requisitions", "chargeTo", "TEXT NOT NULL DEFAULT ''");
    addSqliteColumnIfMissing("requisitions", "procurementStatus", "TEXT NOT NULL DEFAULT ''");
    addSqliteColumnIfMissing("requisitions", "deliveryConfirmation", "TEXT NOT NULL DEFAULT ''");
    addSqliteColumnIfMissing("requisitions", "deliveryRemarks", "TEXT NOT NULL DEFAULT ''");
  }

  await seedAccounts();
  await seedRequisitions();
  await migrateProcurementStatuses();
}

async function seedAccounts() {
  const count = await getCount("accounts");

  if (count > 0) {
    return;
  }

  await createAccount({
    username: "pelailes",
    password: "pel291999",
    email: "afhinzz.ailes@gmail.com",
    firstName: "Pel Martine",
    middleName: "Aguilar",
    lastName: "Ailes",
    department: "Management",
    trade: "Management",
    head: "Manager",
    managerUsername: "",
    role: "Manager"
  });
}

async function seedRequisitions() {
  const count = await getCount("requisitions");

  if (count > 0) {
    return;
  }

  for (const requisition of [
    {
      id: "REQ-1042",
      item: "Safety helmets",
      category: "PPE",
      quantity: "36",
      neededDate: "2026-05-14",
      priority: "High",
      requestedBy: "Site Team A",
      chargeTo: "North Wing Project",
      status: "Submitted",
      notes: "For new contractors at the north wing."
    },
    {
      id: "REQ-1043",
      item: "Rotary hammer drill",
      category: "Equipment",
      quantity: "2",
      neededDate: "2026-05-18",
      priority: "Normal",
      requestedBy: "Structural Team",
      chargeTo: "Structural Works",
      status: "Review",
      notes: "Prefer cordless units with extra batteries."
    },
    {
      id: "REQ-1044",
      item: "PVC conduit 25mm",
      category: "Material",
      quantity: "120",
      neededDate: "2026-05-20",
      priority: "Low",
      requestedBy: "Electrical Team",
      chargeTo: "Level 3 Electrical",
      status: "Ordered",
      notes: "For level 3 rough-in works."
    }
  ]) {
    await createSeedRequisition(requisition);
  }
}

async function migrateProcurementStatuses() {
  const rows = usePostgres
    ? (await pgPool.query("SELECT id, status, procurement_status FROM requisitions")).rows
    : sqliteDb.prepare("SELECT id, status, procurementStatus FROM requisitions").all();

  for (const row of rows) {
    const status = row.status;
    const procurementStatus = row.procurementStatus || row.procurement_status || "";

    if (!procurementStatus && procurementStatusOptions.includes(status)) {
      const managerStatus = await findPreviousManagerStatus(row.id, status);

      if (usePostgres) {
        await pgPool.query(
          "UPDATE requisitions SET status = $1, procurement_status = $2, updated_at = NOW() WHERE id = $3",
          [managerStatus, status, row.id]
        );
      } else {
        sqliteDb
          .prepare("UPDATE requisitions SET status = ?, procurementStatus = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?")
          .run(managerStatus, status, row.id);
      }
    }
  }
}

async function findPreviousManagerStatus(requisitionId, currentStatus) {
  const histories = await getRequisitionHistory(requisitionId);
  const statusHistory = histories.find((history) => history.details.endsWith(` to ${currentStatus}`));
  const previousStatus = statusHistory ? statusHistory.details.replace(` to ${currentStatus}`, "") : "";

  return managerStatusOptions.includes(previousStatus) ? previousStatus : "Review";
}

async function getAccounts() {
  if (usePostgres) {
    const result = await pgPool.query(`
      SELECT * FROM accounts
      ORDER BY (role = 'Manager') DESC, first_name, last_name
    `);
    return result.rows.map(mapAccount);
  }

  return sqliteDb
    .prepare("SELECT * FROM accounts ORDER BY role = 'Manager' DESC, firstName, lastName")
    .all()
    .map(mapAccount);
}

async function getAccountForLogin(username, password, role) {
  if (usePostgres) {
    const result = await pgPool.query(
      "SELECT * FROM accounts WHERE lower(username) = $1 AND password = $2 AND role = $3",
      [username, password, role]
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  const account = sqliteDb
    .prepare("SELECT * FROM accounts WHERE lower(username) = ? AND password = ? AND role = ?")
    .get(username, password, role);
  return account ? mapAccount(account) : null;
}

async function getAccountByUsername(username) {
  if (usePostgres) {
    const result = await pgPool.query("SELECT * FROM accounts WHERE lower(username) = $1", [
      cleanText(username).toLowerCase()
    ]);
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  const account = sqliteDb
    .prepare("SELECT * FROM accounts WHERE lower(username) = ?")
    .get(cleanText(username).toLowerCase());
  return account ? mapAccount(account) : null;
}

async function createAccount(account) {
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO accounts (
        username, password, email, first_name, middle_name, last_name,
        department, trade, head, manager_username, role
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        account.username,
        account.password,
        account.email,
        account.firstName,
        account.middleName,
        account.lastName,
        account.department,
        account.trade,
        account.head,
        account.managerUsername,
        account.role
      ]
    );
    return;
  }

  sqliteDb
    .prepare(
      `INSERT INTO accounts (
        username, password, email, firstName, middleName, lastName,
        department, trade, head, managerUsername, role
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      account.username,
      account.password,
      account.email,
      account.firstName,
      account.middleName,
      account.lastName,
      account.department,
      account.trade,
      account.head,
      account.managerUsername,
      account.role
    );
}

async function getRequisitions() {
  let requisitions;

  if (usePostgres) {
    const result = await pgPool.query("SELECT * FROM requisitions ORDER BY created_at DESC, id DESC");
    requisitions = result.rows.map(mapRequisition);
  } else {
    requisitions = sqliteDb.prepare("SELECT * FROM requisitions ORDER BY createdAt DESC, id DESC").all().map(mapRequisition);
  }

  return Promise.all(requisitions.map(attachRequisitionHistory));
}

async function getRequisitionById(id) {
  let requisition;

  if (usePostgres) {
    const result = await pgPool.query("SELECT * FROM requisitions WHERE id = $1", [cleanText(id)]);
    requisition = result.rows[0] ? mapRequisition(result.rows[0]) : null;
  } else {
    const row = sqliteDb.prepare("SELECT * FROM requisitions WHERE id = ?").get(cleanText(id));
    requisition = row ? mapRequisition(row) : null;
  }

  return requisition ? attachRequisitionHistory(requisition) : null;
}

async function getNextRequisitionId() {
  const requisitions = await getRequisitions();
  const highest = requisitions.reduce((max, row) => {
    const match = /^REQ-(\d+)$/.exec(row.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 1041);

  return `REQ-${highest + 1}`;
}

async function createRequisition(id, requisition) {
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO requisitions (
        id, item, category, quantity, needed_date, priority, requested_by, charge_to, status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        requisition.item,
        requisition.category,
        requisition.quantity,
        requisition.neededDate,
        requisition.priority,
        requisition.requestedBy,
        requisition.chargeTo,
        "Submitted",
        requisition.notes
      ]
    );
    return;
  }

  sqliteDb
    .prepare(
      `INSERT INTO requisitions (
        id, item, category, quantity, neededDate, priority, requestedBy, chargeTo, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      requisition.item,
      requisition.category,
      requisition.quantity,
      requisition.neededDate,
      requisition.priority,
      requisition.requestedBy,
      requisition.chargeTo,
      "Submitted",
      requisition.notes
    );
}

async function createSeedRequisition(requisition) {
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO requisitions (
        id, item, category, quantity, needed_date, priority, requested_by, charge_to, status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        requisition.id,
        requisition.item,
        requisition.category,
        requisition.quantity,
        requisition.neededDate,
        requisition.priority,
        requisition.requestedBy,
        requisition.chargeTo,
        requisition.status,
        requisition.notes
      ]
    );
    return;
  }

  sqliteDb
    .prepare(
      `INSERT INTO requisitions (
        id, item, category, quantity, neededDate, priority, requestedBy, chargeTo, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      requisition.id,
      requisition.item,
      requisition.category,
      requisition.quantity,
      requisition.neededDate,
      requisition.priority,
      requisition.requestedBy,
      requisition.chargeTo,
      requisition.status,
      requisition.notes
    );
}

async function updateRequisition(id, requisition) {
  if (usePostgres) {
    await pgPool.query(
      `UPDATE requisitions
       SET item = $1, category = $2, quantity = $3, needed_date = $4, priority = $5,
           requested_by = $6, charge_to = $7, notes = $8, updated_at = NOW()
       WHERE id = $9`,
      [
        requisition.item,
        requisition.category,
        requisition.quantity,
        requisition.neededDate,
        requisition.priority,
        requisition.requestedBy,
        requisition.chargeTo,
        requisition.notes,
        id
      ]
    );
    return;
  }

  sqliteDb
    .prepare(
      `UPDATE requisitions
       SET item = ?, category = ?, quantity = ?, neededDate = ?, priority = ?, requestedBy = ?, chargeTo = ?, notes = ?, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .run(
      requisition.item,
      requisition.category,
      requisition.quantity,
      requisition.neededDate,
      requisition.priority,
      requisition.requestedBy,
      requisition.chargeTo,
      requisition.notes,
      id
    );
}

async function updateRequisitionStatus(id, status, statusType) {
  if (usePostgres) {
    const column = statusType === "procurement" ? "procurement_status" : "status";
    await pgPool.query(`UPDATE requisitions SET ${column} = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
    return;
  }

  const column = statusType === "procurement" ? "procurementStatus" : "status";
  sqliteDb.prepare(`UPDATE requisitions SET ${column} = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`).run(status, id);
}

async function updateDeliveryConfirmation(id, confirmation, remarks) {
  if (usePostgres) {
    await pgPool.query(
      "UPDATE requisitions SET delivery_confirmation = $1, delivery_remarks = $2, updated_at = NOW() WHERE id = $3",
      [confirmation, remarks, id]
    );
    return;
  }

  sqliteDb
    .prepare("UPDATE requisitions SET deliveryConfirmation = ?, deliveryRemarks = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?")
    .run(confirmation, remarks, id);
}

async function deleteRequisition(id) {
  if (usePostgres) {
    await pgPool.query("DELETE FROM requisitions WHERE id = $1", [id]);
    return;
  }

  sqliteDb.prepare("DELETE FROM requisitions WHERE id = ?").run(id);
}

async function getCount(tableName) {
  if (usePostgres) {
    const result = await pgPool.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
    return result.rows[0].count;
  }

  return sqliteDb.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function readRequisitionBody(body) {
  const priority = cleanText(body.priority) || "Normal";

  return {
    item: cleanText(body.item),
    category: cleanText(body.category),
    quantity: cleanText(body.quantity),
    neededDate: cleanText(body.neededDate),
    priority,
    requestedBy: cleanText(body.requestedBy),
    chargeTo: cleanText(body.chargeTo),
    notes: cleanText(body.notes)
  };
}

function readChangedBy(body) {
  return cleanText(body.changedBy) || "Unknown user";
}

function isValidStatus(status, statusType = "manager") {
  return statusType === "procurement"
    ? procurementStatusOptions.includes(status)
    : managerStatusOptions.includes(status);
}

function isValidDeliveryConfirmation(confirmation) {
  return ["Confirmed", "With Discrepancy"].includes(confirmation);
}

function mapAccount(account) {
  return {
    id: account.id,
    username: account.username,
    email: account.email,
    firstName: account.firstName || account.first_name,
    middleName: account.middleName || account.middle_name || "",
    lastName: account.lastName || account.last_name,
    department: account.department,
    trade: account.trade,
    head: account.head,
    managerUsername: account.managerUsername || account.manager_username || "",
    role: account.role
  };
}

function mapRequisition(requisition) {
  return {
    id: requisition.id,
    item: requisition.item,
    category: requisition.category,
    quantity: requisition.quantity,
    neededDate: requisition.neededDate || requisition.needed_date || "",
    priority: requisition.priority,
    requestedBy: requisition.requestedBy || requisition.requested_by,
    chargeTo: requisition.chargeTo || requisition.charge_to || "",
    status: requisition.status,
    procurementStatus: requisition.procurementStatus || requisition.procurement_status || "",
    deliveryConfirmation: requisition.deliveryConfirmation || requisition.delivery_confirmation || "",
    deliveryRemarks: requisition.deliveryRemarks || requisition.delivery_remarks || "",
    notes: requisition.notes,
    createdAt: requisition.createdAt || requisition.created_at || "",
    editHistory: []
  };
}

async function attachRequisitionHistory(requisition) {
  return {
    ...requisition,
    editHistory: await getRequisitionHistory(requisition.id)
  };
}

async function getRequisitionHistory(requisitionId) {
  if (usePostgres) {
    const result = await pgPool.query(
      `SELECT id, action, changed_by, details, created_at
       FROM requisition_history
       WHERE requisition_id = $1
       ORDER BY created_at DESC, id DESC`,
      [requisitionId]
    );
    return result.rows.map(mapHistory);
  }

  return sqliteDb
    .prepare(
      `SELECT id, action, changedBy, details, createdAt
       FROM requisition_history
       WHERE requisitionId = ?
       ORDER BY createdAt DESC, id DESC`
    )
    .all(requisitionId)
    .map(mapHistory);
}

async function addRequisitionHistory(requisitionId, action, changedBy, details) {
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO requisition_history (requisition_id, action, changed_by, details)
       VALUES ($1, $2, $3, $4)`,
      [requisitionId, action, changedBy, details]
    );
    return;
  }

  sqliteDb
    .prepare(
      `INSERT INTO requisition_history (requisitionId, action, changedBy, details)
       VALUES (?, ?, ?, ?)`
    )
    .run(requisitionId, action, changedBy, details);
}

function mapHistory(history) {
  return {
    id: history.id,
    action: history.action,
    changedBy: history.changedBy || history.changed_by,
    details: history.details,
    createdAt: history.createdAt || history.created_at
  };
}

function summarizeRequisitionChanges(existing, next) {
  const labels = {
    item: "Item",
    category: "Category",
    quantity: "Quantity",
    neededDate: "Needed date",
    priority: "Priority",
    requestedBy: "Requested by",
    chargeTo: "Charge to",
    notes: "Notes"
  };
  const changes = Object.keys(labels)
    .filter((key) => cleanText(existing[key]) !== cleanText(next[key]))
    .map((key) => labels[key]);

  return changes.length ? `Updated ${changes.join(", ")}` : "Saved without field changes.";
}

function addSqliteColumnIfMissing(tableName, columnName, definition) {
  const columns = sqliteDb.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    sqliteDb.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getCodeKey(email, role, managerUsername) {
  return `${email}:${role}:${managerUsername}`;
}

function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

function getMailErrorMessage(error) {
  const code = String(error?.code || "").toUpperCase();
  const responseCode = Number(error?.responseCode || 0);

  if (code === "EAUTH" || responseCode === 534 || responseCode === 535) {
    return "Gmail rejected the login. Check GMAIL_USER and GMAIL_APP_PASSWORD on the backend.";
  }

  if (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION") {
    return "The backend could not reach Gmail SMTP. Check the Gmail SMTP settings and try again.";
  }

  return "Could not send email through Gmail SMTP.";
}

function cleanText(value) {
  return String(value || "").trim();
}
