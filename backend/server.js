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
const resendApiUrl = "https://api.resend.com/emails";
const mailRelayTimeoutMs = Number(process.env.MAIL_RELAY_TIMEOUT_MS || 15000);
const creatorEmail = process.env.CREATOR_EMAIL || "afhinzz.ailes@gmail.com";
const managerAccessPrice = "3,500 Pesos";

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

const transporter = hasSmtpConfig()
  ? nodemailer.createTransport({
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
    })
  : null;

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    database: usePostgres ? "postgres" : "sqlite",
    emailConfigured: Boolean(getEmailProvider()),
    emailProvider: getEmailProvider()
  });
});

app.get("/accounts", async (req, res) => {
  res.json({ accounts: await getAccounts() });
});

app.get("/accounts/managers", async (req, res) => {
  const accounts = await getAccounts();
  res.json({ managers: accounts.filter((account) => account.role === "Manager") });
});

app.get("/projects", async (req, res) => {
  const username = cleanText(req.query.username).toLowerCase();
  const role = cleanText(req.query.role);
  res.json({ projects: await getProjectsForUser(username, role) });
});

app.post("/projects", async (req, res) => {
  const project = readProjectBody(req.body);

  if (!project.title || !project.projectCode) {
    return res.status(400).json({ error: "Project title and project code are required." });
  }

  if (!project.managerUsername) {
    return res.status(400).json({ error: "Manager username is required." });
  }

  const managerAccount = await getAccountByUsername(project.managerUsername);

  if (!managerAccount || managerAccount.role !== "Manager") {
    return res.status(403).json({ error: "Only a registered manager can create projects." });
  }

  const existingProject = await getProjectByCode(project.projectCode, project.managerUsername);

  if (existingProject) {
    return res.status(409).json({ error: "Project code already exists." });
  }

  const id = await getNextProjectId();
  await createProject(id, project);
  return res.status(201).json({ project: await getProjectById(id) });
});

app.get("/projects/:id/access", async (req, res) => {
  const projectId = cleanText(req.params.id);
  const managerUsername = cleanText(req.query.managerUsername).toLowerCase();
  const project = await getProjectById(projectId);

  if (!project) {
    return res.status(404).json({ error: "Project not found." });
  }

  if (!managerUsername) {
    return res.status(400).json({ error: "Manager username is required." });
  }

  if (!isProjectManagedBy(project, managerUsername)) {
    return res.status(403).json({ error: "You can only manage access for your own projects." });
  }

  return res.json({ users: await getProjectAccessUsers(projectId, managerUsername) });
});

app.put("/projects/:id/access", async (req, res) => {
  const projectId = cleanText(req.params.id);
  const managerUsername = cleanText(req.body.managerUsername).toLowerCase();
  const usernames = readUsernameList(req.body.usernames);
  const project = await getProjectById(projectId);

  if (!project) {
    return res.status(404).json({ error: "Project not found." });
  }

  if (!managerUsername) {
    return res.status(400).json({ error: "Manager username is required." });
  }

  if (!isProjectManagedBy(project, managerUsername)) {
    return res.status(403).json({ error: "You can only manage access for your own projects." });
  }

  await replaceProjectAccess(projectId, managerUsername, usernames);
  return res.json({ users: await getProjectAccessUsers(projectId, managerUsername) });
});

app.get("/requisitions", async (req, res) => {
  const projectId = cleanText(req.query.projectId);
  const username = cleanText(req.query.username).toLowerCase();
  const role = cleanText(req.query.role);

  if (projectId && username && !(await canAccessProject(projectId, username, role))) {
    return res.status(403).json({ error: "You do not have access to this project." });
  }

  res.json({ requisitions: await getRequisitions(projectId) });
});

app.post("/requisitions", async (req, res) => {
  const requisition = readRequisitionBody(req.body);
  const changedBy = readChangedBy(req.body);

  if (!requisition.item || !requisition.quantity || !requisition.requestedBy || !requisition.chargeTo) {
    return res.status(400).json({ error: "Item, quantity, requested by, and charge to are required." });
  }

  if (!(await getProjectById(requisition.projectId))) {
    return res.status(400).json({ error: "Select a valid project before creating a requisition." });
  }

  const accessUsername = cleanText(req.body.accessUsername).toLowerCase();
  const accessRole = cleanText(req.body.accessRole);

  if (accessUsername && !(await canAccessProject(requisition.projectId, accessUsername, accessRole))) {
    return res.status(403).json({ error: "You do not have access to this project." });
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

app.post("/password-reset/request", async (req, res) => {
  const username = cleanText(req.body.username).toLowerCase();
  const role = cleanText(req.body.role);

  if (!username || !role) {
    return res.status(400).json({ error: "Username and role are required." });
  }

  const account = await getAccountByUsername(username);

  if (!account || account.role !== role) {
    return res.status(404).json({ error: "Account not found for the selected role." });
  }

  if (!getEmailProvider()) {
    return res.status(500).json({ error: "No email provider is configured on the backend." });
  }

  const recipient = await getPasswordResetRecipient(account);

  if (!recipient.email) {
    return res.status(400).json({ error: "No email is available for this account." });
  }

  const code = generateCode();
  const expiresAt = Date.now() + otpExpiresMinutes * 60 * 1000;
  const key = getPasswordResetCodeKey(account.username, account.role);

  pendingCodes.set(key, {
    code,
    expiresAt,
    used: false
  });

  try {
    await sendOtpEmail({
      applicantEmail: account.email,
      code,
      managerEmail: recipient.email,
      managerName: recipient.name,
      role: account.role,
      purpose: "password-reset",
      username: account.username
    });

    return res.json({
      ok: true,
      expiresInMinutes: otpExpiresMinutes,
      sentTo: "account"
    });
  } catch (error) {
    console.error("Failed to send password reset email:", {
      provider: error?.provider,
      status: error?.status,
      code: error?.code,
      command: error?.command,
      responseCode: error?.responseCode,
      message: error?.message
    });
    pendingCodes.delete(key);
    return res.status(502).json({ error: getMailErrorMessage(error) });
  }
});

app.post("/password-reset/confirm", async (req, res) => {
  const username = cleanText(req.body.username).toLowerCase();
  const role = cleanText(req.body.role);
  const code = cleanText(req.body.code);
  const password = cleanText(req.body.password);
  const account = await getAccountByUsername(username);
  const key = getPasswordResetCodeKey(username, role);
  const savedCode = pendingCodes.get(key);

  if (!username || !role || !code || !password) {
    return res.status(400).json({ error: "Username, role, code, and new password are required." });
  }

  if (!account || account.role !== role) {
    return res.status(404).json({ error: "Account not found for the selected role." });
  }

  if (!savedCode || savedCode.used) {
    return res.status(400).json({ error: "No active password reset code was found." });
  }

  if (savedCode.expiresAt < Date.now()) {
    pendingCodes.delete(key);
    return res.status(400).json({ error: "The password reset code has expired." });
  }

  if (savedCode.code !== code) {
    return res.status(400).json({ error: "The password reset code is incorrect." });
  }

  await updateAccountPassword(username, password);
  pendingCodes.set(key, { ...savedCode, used: true });
  return res.json({ ok: true });
});

app.post("/manager-access/request", async (req, res) => {
  const request = {
    fullName: cleanText(req.body.fullName),
    email: normalizeEmail(req.body.email),
    company: cleanText(req.body.company),
    contactNumber: cleanText(req.body.contactNumber)
  };

  if (!request.fullName || !request.email || !request.contactNumber) {
    return res.status(400).json({ error: "Full name, email, and contact number are required." });
  }

  if (!getEmailProvider()) {
    return res.status(500).json({ error: "No email provider is configured on the backend." });
  }

  try {
    await sendAppEmail({
      to: creatorEmail,
      subject: "Manager access request",
      messageText: [
        "A user requested Manager access for the requisition app.",
        "",
        `Full name: ${request.fullName}`,
        `Email: ${request.email}`,
        `Company: ${request.company || "Not provided"}`,
        `Contact number: ${request.contactNumber}`,
        "",
        `Manager access price: ${managerAccessPrice}`
      ].join("\n")
    });

    await sendAppEmail({
      to: request.email,
      subject: "Requisition App Manager access pricing",
      messageText: [
        `Hello ${request.fullName},`,
        "",
        "Your Manager access request for the requisition app was received.",
        `Manager access price: ${managerAccessPrice}`,
        "",
        "The app creator will review your request and reply to this email for the next steps.",
        "",
        "Thank you."
      ].join("\n")
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Failed to send manager access request:", {
      provider: error?.provider,
      status: error?.status,
      code: error?.code,
      command: error?.command,
      responseCode: error?.responseCode,
      message: error?.message
    });
    return res.status(502).json({ error: getMailErrorMessage(error) });
  }
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

  const selectedManager = await getAccountByUsername(account.managerUsername);

  if (!selectedManager || selectedManager.role !== "Manager") {
    return res.status(400).json({ error: "Select a registered manager before creating the account." });
  }

  await createAccount(account);
  if (account.role === "Manager") {
    await ensureManagerSampleProject(account);
  } else {
    const managerSampleProject = await ensureManagerSampleProject(account.managerUsername);

    if (managerSampleProject) {
      await grantProjectAccess(managerSampleProject.id, account.username, account.managerUsername);
    }
  }
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

  if (!getEmailProvider()) {
    return res.status(500).json({ error: "No email provider is configured on the backend." });
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
    await sendOtpEmail({
      applicantEmail: email,
      code,
      managerEmail,
      managerName,
      role
    });

    return res.json({ ok: true, expiresInMinutes: otpExpiresMinutes });
  } catch (error) {
    console.error("Failed to send OTP email:", {
      provider: error?.provider,
      status: error?.status,
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

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        director TEXT NOT NULL DEFAULT '',
        start_date TEXT NOT NULL DEFAULT '',
        end_date TEXT NOT NULL DEFAULT '',
        managers TEXT NOT NULL DEFAULT '',
        engineers TEXT NOT NULL DEFAULT '',
        project_costs TEXT NOT NULL DEFAULT '',
        contractors TEXT NOT NULL DEFAULT '',
        location_site TEXT NOT NULL DEFAULT '',
        project_code TEXT NOT NULL,
        manager_username TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        manager_username TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, username)
      );

      CREATE TABLE IF NOT EXISTS requisitions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT 'sample' REFERENCES projects(id),
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
    await pgPool.query("ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'sample'");
    await pgPool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS manager_username TEXT NOT NULL DEFAULT ''");
    await pgPool.query("ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_code_key");
    await pgPool.query("CREATE INDEX IF NOT EXISTS projects_manager_username_idx ON projects(manager_username)");
    await pgPool.query("CREATE UNIQUE INDEX IF NOT EXISTS projects_manager_code_idx ON projects(manager_username, project_code)");
    await pgPool.query("CREATE INDEX IF NOT EXISTS requisitions_project_id_idx ON requisitions(project_id)");
    await pgPool.query("CREATE INDEX IF NOT EXISTS project_members_username_idx ON project_members(username)");
    await pgPool.query("CREATE INDEX IF NOT EXISTS project_members_manager_idx ON project_members(manager_username)");
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

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        director TEXT NOT NULL DEFAULT '',
        startDate TEXT NOT NULL DEFAULT '',
        endDate TEXT NOT NULL DEFAULT '',
        managers TEXT NOT NULL DEFAULT '',
        engineers TEXT NOT NULL DEFAULT '',
        projectCosts TEXT NOT NULL DEFAULT '',
        contractors TEXT NOT NULL DEFAULT '',
        locationSite TEXT NOT NULL DEFAULT '',
        projectCode TEXT NOT NULL,
        managerUsername TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS project_members (
        projectId TEXT NOT NULL,
        username TEXT NOT NULL,
        managerUsername TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (projectId, username)
      );

      CREATE TABLE IF NOT EXISTS requisitions (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL DEFAULT 'sample',
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
    addSqliteColumnIfMissing("requisitions", "projectId", "TEXT NOT NULL DEFAULT 'sample'");
    addSqliteColumnIfMissing("projects", "managerUsername", "TEXT NOT NULL DEFAULT ''");
    sqliteDb.exec("CREATE INDEX IF NOT EXISTS projectsManagerUsernameIndex ON projects(managerUsername);");
    sqliteDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS projectsManagerCodeIndex ON projects(managerUsername, projectCode);");
    sqliteDb.exec("CREATE INDEX IF NOT EXISTS requisitionsProjectIdIndex ON requisitions(projectId);");
    sqliteDb.exec("CREATE INDEX IF NOT EXISTS projectMembersUsernameIndex ON project_members(username);");
    sqliteDb.exec("CREATE INDEX IF NOT EXISTS projectMembersManagerIndex ON project_members(managerUsername);");
  }

  await seedAccounts();
  await seedProjects();
  await backfillProjectManagers();
  await ensureManagerSampleProjects();
  await pruneInvalidProjectAccess();
  await seedProjectAccess();
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

async function seedProjects() {
  if (await getProjectById("sample")) {
    return;
  }

  await createProject("sample", {
    title: "Sample",
    director: "",
    startDate: "",
    endDate: "",
    managers: "Pel Martine Ailes",
    engineers: "",
    projectCosts: "",
    contractors: "",
    locationSite: "",
    projectCode: "SAMPLE",
    managerUsername: "pelailes"
  });
}

async function backfillProjectManagers() {
  const defaultManagerUsername = await getDefaultManagerUsername();

  if (!defaultManagerUsername) {
    return;
  }

  const projects = await getProjects();

  for (const project of projects) {
    if (project.managerUsername) {
      continue;
    }

    await updateProjectManagerUsername(
      project.id,
      (await getProjectAccessManagerUsername(project.id)) || defaultManagerUsername
    );
  }
}

async function getProjectAccessManagerUsername(projectId) {
  const id = cleanText(projectId);

  if (usePostgres) {
    const result = await pgPool.query(
      `SELECT DISTINCT lower(manager_username) AS manager_username
       FROM project_members
       WHERE project_id = $1 AND COALESCE(manager_username, '') <> ''`,
      [id]
    );
    return result.rows.length === 1 ? result.rows[0].manager_username : "";
  }

  const rows = sqliteDb
    .prepare(
      `SELECT DISTINCT lower(managerUsername) AS managerUsername
       FROM project_members
       WHERE projectId = ? AND COALESCE(managerUsername, '') <> ''`
    )
    .all(id);
  return rows.length === 1 ? rows[0].managerUsername : "";
}

async function updateProjectManagerUsername(projectId, managerUsername) {
  const id = cleanText(projectId);
  const manager = cleanText(managerUsername).toLowerCase();

  if (!id || !manager) {
    return;
  }

  if (usePostgres) {
    await pgPool.query("UPDATE projects SET manager_username = $1, updated_at = NOW() WHERE id = $2", [manager, id]);
    return;
  }

  sqliteDb.prepare("UPDATE projects SET managerUsername = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?").run(manager, id);
}

async function ensureManagerSampleProjects() {
  const managers = (await getAccounts()).filter((account) => account.role === "Manager");

  for (const manager of managers) {
    await ensureManagerSampleProject(manager);
  }
}

async function pruneInvalidProjectAccess() {
  if (usePostgres) {
    await pgPool.query(
      `DELETE FROM project_members pm
       USING projects p
       WHERE pm.project_id = p.id
         AND lower(COALESCE(p.manager_username, '')) <> lower(COALESCE(pm.manager_username, ''))`
    );
    return;
  }

  sqliteDb.exec(`
    DELETE FROM project_members
    WHERE EXISTS (
      SELECT 1
      FROM projects
      WHERE projects.id = project_members.projectId
        AND lower(COALESCE(projects.managerUsername, '')) <> lower(COALESCE(project_members.managerUsername, ''))
    );
  `);
}

async function seedProjectAccess() {
  const accounts = (await getAccounts()).filter((account) => account.role !== "Manager");

  for (const account of accounts) {
    const managerSampleProject = await ensureManagerSampleProject(account.managerUsername);

    if (managerSampleProject) {
      await grantProjectAccess(managerSampleProject.id, account.username, account.managerUsername);
    }
  }
}

async function ensureManagerSampleProject(managerAccountOrUsername) {
  const managerAccount =
    typeof managerAccountOrUsername === "string"
      ? await getAccountByUsername(managerAccountOrUsername)
      : managerAccountOrUsername;

  if (!managerAccount || managerAccount.role !== "Manager") {
    return null;
  }

  const managerUsername = cleanText(managerAccount.username).toLowerCase();
  const existingSample = (await getProjectsManagedBy(managerUsername)).find(
    (project) => project.title.toLowerCase() === "sample"
  );

  if (existingSample) {
    return existingSample;
  }

  let projectId = getManagerSampleProjectId(managerUsername);

  if (await getProjectById(projectId)) {
    projectId = await getNextProjectId();
  }

  await createProject(projectId, {
    title: "Sample",
    director: "",
    startDate: "",
    endDate: "",
    managers: getAccountDisplayName(managerAccount),
    engineers: "",
    projectCosts: "",
    contractors: "",
    locationSite: "",
    projectCode: getManagerSampleProjectCode(managerUsername),
    managerUsername
  });

  return getProjectById(projectId);
}

async function getDefaultManagerUsername() {
  const managers = (await getAccounts()).filter((account) => account.role === "Manager");
  const preferredManager = managers.find((account) => account.username.toLowerCase() === "pelailes");
  const manager = preferredManager || managers[0];

  return manager ? manager.username.toLowerCase() : "";
}

function getManagerSampleProjectId(managerUsername) {
  const slug = slugifyUsername(managerUsername);
  return slug === "pelailes" ? "sample" : `sample-${slug}`;
}

function getManagerSampleProjectCode(managerUsername) {
  const slug = slugifyUsername(managerUsername).toUpperCase();
  return slug === "PELAILES" ? "SAMPLE" : `SAMPLE-${slug}`;
}

function slugifyUsername(username) {
  return cleanText(username).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "manager";
}

function getAccountDisplayName(account) {
  return [account.firstName, account.middleName, account.lastName].map(cleanText).filter(Boolean).join(" ");
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
      projectId: "sample",
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
      projectId: "sample",
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
      projectId: "sample",
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

async function getProjects() {
  if (usePostgres) {
    const result = await pgPool.query("SELECT * FROM projects ORDER BY created_at ASC, title ASC");
    return result.rows.map(mapProject);
  }

  return sqliteDb.prepare("SELECT * FROM projects ORDER BY createdAt ASC, title ASC").all().map(mapProject);
}

async function getProjectsForUser(username, role) {
  const normalizedUsername = cleanText(username).toLowerCase();

  if (!normalizedUsername) {
    return getProjects();
  }

  if (role === "Manager") {
    return getProjectsManagedBy(normalizedUsername);
  }

  if (usePostgres) {
    const result = await pgPool.query(
      `SELECT DISTINCT p.*
       FROM projects p
       INNER JOIN project_members pm ON pm.project_id = p.id
       WHERE lower(pm.username) = $1
       ORDER BY p.created_at ASC, p.title ASC`,
      [normalizedUsername]
    );
    return result.rows.map(mapProject);
  }

  return sqliteDb
    .prepare(
      `SELECT DISTINCT p.*
       FROM projects p
       INNER JOIN project_members pm ON pm.projectId = p.id
       WHERE lower(pm.username) = ?
       ORDER BY p.createdAt ASC, p.title ASC`
    )
    .all(normalizedUsername)
    .map(mapProject);
}

async function getProjectsManagedBy(managerUsername) {
  const normalizedUsername = cleanText(managerUsername).toLowerCase();

  if (usePostgres) {
    const result = await pgPool.query(
      `SELECT *
       FROM projects
       WHERE lower(manager_username) = $1
       ORDER BY created_at ASC, title ASC`,
      [normalizedUsername]
    );
    return result.rows.map(mapProject);
  }

  return sqliteDb
    .prepare(
      `SELECT *
       FROM projects
       WHERE lower(managerUsername) = ?
       ORDER BY createdAt ASC, title ASC`
    )
    .all(normalizedUsername)
    .map(mapProject);
}

async function getProjectById(id) {
  const projectId = cleanText(id) || "sample";

  if (usePostgres) {
    const result = await pgPool.query("SELECT * FROM projects WHERE id = $1", [projectId]);
    return result.rows[0] ? mapProject(result.rows[0]) : null;
  }

  const project = sqliteDb.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  return project ? mapProject(project) : null;
}

async function getProjectByCode(projectCode, managerUsername = "") {
  const code = cleanText(projectCode).toLowerCase();
  const manager = cleanText(managerUsername).toLowerCase();

  if (usePostgres) {
    const result = manager
      ? await pgPool.query("SELECT * FROM projects WHERE lower(project_code) = $1 AND lower(manager_username) = $2", [
          code,
          manager
        ])
      : await pgPool.query("SELECT * FROM projects WHERE lower(project_code) = $1", [code]);
    return result.rows[0] ? mapProject(result.rows[0]) : null;
  }

  const project = manager
    ? sqliteDb
        .prepare("SELECT * FROM projects WHERE lower(projectCode) = ? AND lower(managerUsername) = ?")
        .get(code, manager)
    : sqliteDb.prepare("SELECT * FROM projects WHERE lower(projectCode) = ?").get(code);
  return project ? mapProject(project) : null;
}

async function getNextProjectId() {
  const projects = await getProjects();
  const highest = projects.reduce((max, project) => {
    const match = /^PRJ-(\d+)$/.exec(project.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 1000);

  return `PRJ-${highest + 1}`;
}

async function createProject(id, project) {
  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO projects (
        id, title, director, start_date, end_date, managers, engineers,
        project_costs, contractors, location_site, project_code, manager_username
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        project.title,
        project.director,
        project.startDate,
        project.endDate,
        project.managers,
        project.engineers,
        project.projectCosts,
        project.contractors,
        project.locationSite,
        project.projectCode,
        cleanText(project.managerUsername).toLowerCase()
      ]
    );
    return;
  }

  sqliteDb
    .prepare(
      `INSERT INTO projects (
        id, title, director, startDate, endDate, managers, engineers,
        projectCosts, contractors, locationSite, projectCode, managerUsername
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      project.title,
      project.director,
      project.startDate,
      project.endDate,
      project.managers,
      project.engineers,
      project.projectCosts,
      project.contractors,
      project.locationSite,
      project.projectCode,
      cleanText(project.managerUsername).toLowerCase()
    );
}

async function getProjectAccessUsers(projectId, managerUsername) {
  const managedAccounts = await getAccountsManagedBy(managerUsername);
  const accessUsernames = await getProjectAccessUsernames(projectId);
  const accessSet = new Set(accessUsernames.map((username) => username.toLowerCase()));

  return managedAccounts.map((account) => ({
    ...account,
    hasAccess: accessSet.has(account.username.toLowerCase())
  }));
}

async function getAccountsManagedBy(managerUsername) {
  const username = cleanText(managerUsername).toLowerCase();

  if (usePostgres) {
    const result = await pgPool.query(
      `SELECT * FROM accounts
       WHERE lower(manager_username) = $1 AND role <> 'Manager'
       ORDER BY role, first_name, last_name`,
      [username]
    );
    return result.rows.map(mapAccount);
  }

  return sqliteDb
    .prepare(
      `SELECT * FROM accounts
       WHERE lower(managerUsername) = ? AND role <> 'Manager'
       ORDER BY role, firstName, lastName`
    )
    .all(username)
    .map(mapAccount);
}

async function getProjectAccessUsernames(projectId) {
  const id = cleanText(projectId);

  if (usePostgres) {
    const result = await pgPool.query("SELECT username FROM project_members WHERE project_id = $1", [id]);
    return result.rows.map((row) => row.username);
  }

  return sqliteDb
    .prepare("SELECT username FROM project_members WHERE projectId = ?")
    .all(id)
    .map((row) => row.username);
}

async function canAccessProject(projectId, username, role) {
  const id = cleanText(projectId);
  const accountUsername = cleanText(username).toLowerCase();

  if (!id) {
    return true;
  }

  if (!accountUsername) {
    return false;
  }

  if (role === "Manager") {
    return canManageProject(id, accountUsername);
  }

  if (usePostgres) {
    const result = await pgPool.query(
      "SELECT 1 FROM project_members WHERE project_id = $1 AND lower(username) = $2 LIMIT 1",
      [id, accountUsername]
    );
    return result.rowCount > 0;
  }

  return Boolean(
    sqliteDb
      .prepare("SELECT 1 FROM project_members WHERE projectId = ? AND lower(username) = ? LIMIT 1")
      .get(id, accountUsername)
  );
}

async function canManageProject(projectId, managerUsername) {
  const project = await getProjectById(projectId);
  return isProjectManagedBy(project, managerUsername);
}

function isProjectManagedBy(project, managerUsername) {
  return Boolean(project && cleanText(project.managerUsername).toLowerCase() === cleanText(managerUsername).toLowerCase());
}

async function replaceProjectAccess(projectId, managerUsername, usernames) {
  const id = cleanText(projectId);
  const manager = cleanText(managerUsername).toLowerCase();
  const managedAccounts = await getAccountsManagedBy(manager);
  const managedSet = new Set(managedAccounts.map((account) => account.username.toLowerCase()));
  const selectedUsernames = [...new Set(usernames.map((username) => cleanText(username).toLowerCase()))].filter((username) =>
    managedSet.has(username)
  );

  if (usePostgres) {
    await pgPool.query("DELETE FROM project_members WHERE project_id = $1 AND lower(manager_username) = $2", [id, manager]);

    for (const username of selectedUsernames) {
      await grantProjectAccess(id, username, manager);
    }
    return;
  }

  sqliteDb.prepare("DELETE FROM project_members WHERE projectId = ? AND lower(managerUsername) = ?").run(id, manager);

  for (const username of selectedUsernames) {
    await grantProjectAccess(id, username, manager);
  }
}

async function grantProjectAccess(projectId, username, managerUsername) {
  const id = cleanText(projectId);
  const accountUsername = cleanText(username).toLowerCase();
  const manager = cleanText(managerUsername).toLowerCase();

  if (!id || !accountUsername) {
    return;
  }

  if (usePostgres) {
    await pgPool.query(
      `INSERT INTO project_members (project_id, username, manager_username)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, username)
       DO UPDATE SET manager_username = EXCLUDED.manager_username`,
      [id, accountUsername, manager]
    );
    return;
  }

  sqliteDb
    .prepare(
      `INSERT INTO project_members (projectId, username, managerUsername)
       VALUES (?, ?, ?)
       ON CONFLICT(projectId, username)
       DO UPDATE SET managerUsername = excluded.managerUsername`
    )
    .run(id, accountUsername, manager);
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

async function getPasswordResetRecipient(account) {
  return {
    email: account.email,
    name: getAccountDisplayName(account) || "User"
  };
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

async function updateAccountPassword(username, password) {
  const accountUsername = cleanText(username).toLowerCase();
  const nextPassword = cleanText(password);

  if (usePostgres) {
    await pgPool.query("UPDATE accounts SET password = $1 WHERE lower(username) = $2", [nextPassword, accountUsername]);
    return;
  }

  sqliteDb.prepare("UPDATE accounts SET password = ? WHERE lower(username) = ?").run(nextPassword, accountUsername);
}

async function getRequisitions(projectId = "") {
  let requisitions;
  const cleanProjectId = cleanText(projectId);

  if (usePostgres) {
    const result = cleanProjectId
      ? await pgPool.query("SELECT * FROM requisitions WHERE project_id = $1 ORDER BY created_at DESC, id DESC", [cleanProjectId])
      : await pgPool.query("SELECT * FROM requisitions ORDER BY created_at DESC, id DESC");
    requisitions = result.rows.map(mapRequisition);
  } else {
    requisitions = cleanProjectId
      ? sqliteDb.prepare("SELECT * FROM requisitions WHERE projectId = ? ORDER BY createdAt DESC, id DESC").all(cleanProjectId).map(mapRequisition)
      : sqliteDb.prepare("SELECT * FROM requisitions ORDER BY createdAt DESC, id DESC").all().map(mapRequisition);
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
        id, project_id, item, category, quantity, needed_date, priority, requested_by, charge_to, status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        requisition.projectId,
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
        id, projectId, item, category, quantity, neededDate, priority, requestedBy, chargeTo, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      requisition.projectId,
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
        id, project_id, item, category, quantity, needed_date, priority, requested_by, charge_to, status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        requisition.id,
        requisition.projectId || "sample",
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
        id, projectId, item, category, quantity, neededDate, priority, requestedBy, chargeTo, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      requisition.id,
      requisition.projectId || "sample",
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
    projectId: cleanText(body.projectId) || "sample",
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

function readProjectBody(body) {
  return {
    title: cleanText(body.title),
    director: cleanText(body.director),
    startDate: cleanText(body.startDate),
    endDate: cleanText(body.endDate),
    managers: cleanText(body.managers),
    engineers: cleanText(body.engineers),
    projectCosts: cleanText(body.projectCosts),
    contractors: cleanText(body.contractors),
    locationSite: cleanText(body.locationSite),
    projectCode: cleanText(body.projectCode).toUpperCase(),
    managerUsername: cleanText(body.managerUsername).toLowerCase()
  };
}

function readUsernameList(usernames) {
  if (!Array.isArray(usernames)) {
    return [];
  }

  return usernames.map((username) => cleanText(username).toLowerCase()).filter(Boolean);
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

function mapProject(project) {
  return {
    id: project.id,
    title: project.title,
    director: project.director || "",
    startDate: project.startDate || project.start_date || "",
    endDate: project.endDate || project.end_date || "",
    managers: project.managers || "",
    engineers: project.engineers || "",
    projectCosts: project.projectCosts || project.project_costs || "",
    contractors: project.contractors || "",
    locationSite: project.locationSite || project.location_site || "",
    projectCode: project.projectCode || project.project_code || "",
    managerUsername: project.managerUsername || project.manager_username || "",
    createdAt: project.createdAt || project.created_at || ""
  };
}

function mapRequisition(requisition) {
  return {
    id: requisition.id,
    projectId: requisition.projectId || requisition.project_id || "sample",
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

function getPasswordResetCodeKey(username, role) {
  return `password-reset:${cleanText(username).toLowerCase()}:${cleanText(role)}`;
}

function getEmailProvider() {
  if (hasMailRelayConfig()) {
    return "mail-relay";
  }

  if (hasResendConfig()) {
    return "resend";
  }

  if (hasSmtpConfig()) {
    return "smtp";
  }

  return null;
}

function hasMailRelayConfig() {
  return Boolean(process.env.MAIL_RELAY_URL && process.env.MAIL_RELAY_SECRET);
}

function hasResendConfig() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

function hasSmtpConfig() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

async function sendOtpEmail({ applicantEmail, code, managerEmail, managerName, role, purpose = "signup", username = "" }) {
  const isPasswordReset = purpose === "password-reset";
  const subject = isPasswordReset ? "One-time password reset code" : "One-time sign-up code";
  const messageText = isPasswordReset
    ? [
        `Hello ${managerName},`,
        "",
        `A password change was requested for your ${role} account in the requisition app.`,
        `Username: ${username}`,
        `Account email: ${applicantEmail}`,
        `One-time code: ${code}`,
        "",
        `This code expires in ${otpExpiresMinutes} minutes.`
      ].join("\n")
    : [
        `Hello ${managerName},`,
        "",
        `A user is requesting a ${role} account for the requisition app.`,
        `Applicant email: ${applicantEmail}`,
        `One-time code: ${code}`,
        "",
        `This code expires in ${otpExpiresMinutes} minutes.`
      ].join("\n");

  return await sendAppEmail({
    to: managerEmail,
    subject,
    messageText
  });
}

async function sendAppEmail({ to, subject, messageText }) {
  const recipient = normalizeEmail(to);

  if (hasMailRelayConfig()) {
    return await sendOtpEmailWithMailRelay({
      managerEmail: recipient,
      subject,
      messageText
    });
  }

  if (hasResendConfig()) {
    return await sendOtpEmailWithResend({
      managerEmail: recipient,
      subject,
      messageText
    });
  }

  if (hasSmtpConfig() && transporter) {
    return await transporter.sendMail({
      from: `"Requisition App" <${process.env.GMAIL_USER}>`,
      to: recipient,
      subject,
      text: messageText
    });
  }

  throw new Error("No email provider is configured.");
}

async function sendOtpEmailWithMailRelay({ managerEmail, subject, messageText }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), mailRelayTimeoutMs);

  try {
    const response = await fetch(process.env.MAIL_RELAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        secret: process.env.MAIL_RELAY_SECRET,
        to: managerEmail,
        subject,
        text: messageText
      }),
      signal: controller.signal
    });

    const bodyText = await response.text();

    let responseBody = null;

    try {
      responseBody = bodyText ? JSON.parse(bodyText) : null;
    } catch (parseError) {
      responseBody = null;
    }

    if (!response.ok || responseBody?.ok === false) {
      const error = new Error(`Mail relay request failed with status ${response.status}. ${bodyText}`);
      error.provider = "mail-relay";
      error.status = responseBody?.statusCode || response.status;
      error.responseText = bodyText;
      throw error;
    }

    return responseBody || { ok: true };
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Mail relay request timed out.");
      timeoutError.provider = "mail-relay";
      timeoutError.code = "ETIMEDOUT";
      throw timeoutError;
    }

    if (!error.provider) {
      error.provider = "mail-relay";
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendOtpEmailWithResend({ managerEmail, subject, messageText }) {
  const response = await fetch(resendApiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: [managerEmail],
      subject,
      text: messageText
    })
  });

  if (!response.ok) {
    const bodyText = await response.text();
    const error = new Error(`Resend API request failed with status ${response.status}. ${bodyText}`);
    error.provider = "resend";
    error.status = response.status;
    error.responseText = bodyText;
    throw error;
  }

  return await response.json();
}

function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

function getMailErrorMessage(error) {
  if (error?.provider === "mail-relay") {
    if (error.status === 401 || error.status === 403) {
      return "The mail relay rejected the request. Check MAIL_RELAY_SECRET on the backend and Apps Script.";
    }

    if (error.code === "ETIMEDOUT") {
      return "The mail relay did not respond in time. Check the Google Apps Script deployment.";
    }

    return "The backend could not send the email through the mail relay. Check the Google Apps Script logs.";
  }

  if (error?.provider === "resend") {
    if (error.status === 401) {
      return "Resend rejected the API key. Check RESEND_API_KEY on the backend.";
    }

    if (error.status === 403) {
      return "Resend rejected the sender. Verify RESEND_FROM_EMAIL uses a verified Resend domain.";
    }

    return "The backend could not send the email through Resend. Check the Resend configuration and logs.";
  }

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
