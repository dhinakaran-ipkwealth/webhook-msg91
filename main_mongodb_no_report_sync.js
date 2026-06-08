const {
  app,
  BrowserWindow,
  dialog,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const csvParser = require("csv-parser");
const axios = require("axios");
const express = require("express");
const XLSX = require("xlsx");
const { MongoClient } = require("mongodb");
const nodemailer = require("nodemailer");
const SftpClient = require("ssh2-sftp-client");
// const { ipcMain } = require("electron");

function getExternalConfigPaths(fileName) {
  const paths = [
    path.join(__dirname, fileName),
    process.resourcesPath ? path.join(process.resourcesPath, fileName) : "",
    process.execPath ? path.join(path.dirname(process.execPath), fileName) : "",
  ].filter(Boolean);
  return [...new Set(paths)];
}

// Populate process.env from .env file immediately on startup
try {
  const envPath = getExternalConfigPaths(".env").find((candidate) =>
    fs.existsSync(candidate),
  );
  if (envPath) {
    fs.readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex === -1) return;
        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      });
    console.log(`Loaded .env variables into process.env from ${envPath}`);
  }
} catch (err) {
  console.warn("Failed to load inline .env file on startup:", err.message);
}

let mainWindow;
const webhookPort = 3002;
const reportRefreshIntervalMs = 2000;
const defaultWebhookBaseUrl = "https://crm.ipkwealth.com";
let db;
let msg91ConfigCache = null;
let mongoClient = null;
let mongoDb = null;
let tray = null;
let webhookServer = null;
let isQuitting = false;
let reportPollInProgress = false;
let reportPollingTimer = null;
let isDbClosing = false;
let scheduleConfig = null;
let scheduleTimer = null;

const scheduleFilePath = path.join(
  app.getPath("userData"),
  "report-schedule.json",
);

function loadScheduleConfig() {
  try {
    if (!fs.existsSync(scheduleFilePath)) return null;
    return JSON.parse(fs.readFileSync(scheduleFilePath, "utf8"));
  } catch (err) {
    console.warn("Failed to load schedule config:", err.message);
    return null;
  }
}

function saveScheduleConfig(cfg) {
  try {
    fs.writeFileSync(scheduleFilePath, JSON.stringify(cfg, null, 2), "utf8");
    return true;
  } catch (err) {
    console.warn("Failed to save schedule config:", err.message);
    return false;
  }
}

function clearScheduleTimer() {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
}

function scheduleNextRun(cfg) {
  clearScheduleTimer();
  if (!cfg || !cfg.enabled) return;
  const [hh, mm] = (cfg.time || "10:00").split(":").map((v) => Number(v));
  const now = new Date();
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next.getTime() - now.getTime();
  scheduleTimer = setTimeout(async function runAndReschedule() {
    try {
      if (cfg.mechanism === "email") {
        console.log(
          `Scheduled run triggered. Generating 24-hour RM and Admin reports (from configured ${cfg.time} yesterday to ${cfg.time} today)...`,
        );

        // 1. Calculate the exact 24-hour range (from configured time yesterday to configured time today)
        const end = new Date();
        end.setHours(hh, mm, 0, 0);
        const start = new Date(end);
        start.setDate(start.getDate() - 1);

        const timeFilters = {
          startDateTime: start.toISOString(),
          endDateTime: end.toISOString(),
        };

        // 2. Generate & email full 24-hour comprehensive report to Admin
        const fullRangeResult = await exportCustomReport(timeFilters);
        await sendAdminReportEmailDirect(
          fullRangeResult.filePath,
          start.toISOString(),
          end.toISOString(),
        );

        // 3. Generate & email grouped 24-hour reports to each corresponding RM
        await sendRmGroupedReportsDirect(timeFilters);
      } else if (cfg.mechanism === "sftp") {
        const result = await exportCustomReport({});
        await deliverFileBySftp(result.filePath);
      } else {
        const result = await exportCustomReport({});
        // Auto-export: optionally move to folder specified in env EXPORT_FOLDER
        const exportFolder = process.env.EXPORT_FOLDER;
        if (exportFolder) {
          try {
            const dest = path.join(
              exportFolder,
              path.basename(result.filePath),
            );
            fs.copyFileSync(result.filePath, dest);
          } catch (e) {
            console.warn("Auto-export copy failed:", e.message);
          }
        }
      }
    } catch (err) {
      console.warn("Scheduled export failed:", err.message);
    }
    // schedule next day
    scheduleTimer = setTimeout(runAndReschedule, 24 * 60 * 60 * 1000);
  }, ms);
}

async function deliverFileByEmail(filePath, toEmailsCsv) {
  // Backwards compatibility fallback if needed
  await sendAdminReportEmailDirect(filePath, null, null);
}

async function sendAdminReportEmailDirect(filePath, startIso, endIso) {
  if (
    String(process.env.DISABLE_EMAIL_DELIVERY || "").toLowerCase() === "true"
  ) {
    console.log(
      `Email delivery disabled by DISABLE_EMAIL_DELIVERY; would have delivered admin report: ${filePath}`,
    );
    return { skipped: true, filePath };
  }

  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) throw new Error("SMTP_HOST not configured in environment");

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Boolean(process.env.SMTP_SECURE === "true"),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const to = (process.env.ADMIN_EMAILS_TO || "prabhukumarasamy@ipkwealth.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cc = [
    process.env.ADMIN_EMAILS_CC_SALES1,
    process.env.ADMIN_EMAILS_CC_SALES2,
  ]
    .map((s) => s?.trim())
    .filter(Boolean);
  const bcc = (
    process.env.ADMIN_EMAILS_BCC ||
    "dhinakaran@ipkwealth.com,vijaytp@ipkwealth.com"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!to.length)
    throw new Error("No recipient addresses configured for admin emails.");

  const startLabel = startIso ? new Date(startIso).toLocaleString() : "";
  const endLabel = endIso ? new Date(endIso).toLocaleString() : "";
  const rangeStr =
    startLabel && endLabel
      ? `${startLabel} to ${endLabel}`
      : "Daily Webhook Feed";

  const mailOptions = {
    from:
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      "software@ipkwealth.com",
    to: to.join(","),
    subject: `Admin Bulk Sender Webhook Report (${new Date().toLocaleDateString()})`,
    text: `Hi Admin,\n\nPlease find attached the comprehensive Excel report containing all transaction webhook events for the range: ${rangeStr}.\n\nReport Details:\n- Range: ${rangeStr}\n- Generation Time: ${new Date().toLocaleString()}\n\nBest Regards,\nIPK Wealth Services Private Limited`,
    attachments: [{ filename: path.basename(filePath), path: filePath }],
  };

  if (cc.length) mailOptions.cc = cc.join(",");
  if (bcc.length) mailOptions.bcc = bcc.join(",");

  await transporter.sendMail(mailOptions);
  console.log(`Admin email notification sent successfully to ${to.join(", ")}`);
  return { success: true, filePath };
}

async function sendRmGroupedReportsDirect(filters = {}) {
  // 1. Get all rows matching the filters
  const allRows = await getCustomReportRows(filters);
  if (!allRows.length) {
    console.log("No webhook transaction rows found for RM grouped reporting.");
    return { count: 0, sent: 0 };
  }

  // 2. Load RM integratedNumbers config
  const config = loadMsg91Config();
  const rms = config.integratedNumbers || [];
  if (!rms.length) {
    console.log(
      "No RMs configured in msg91.config.json for grouped report delivery.",
    );
    return { count: 0, sent: 0 };
  }

  let rmSentCount = 0;

  for (const rm of rms) {
    const rmNumber = String(rm.number).trim();
    if (!rmNumber) continue;

    // Filter events belonging to this RM number
    const rmRows = allRows.filter((row) => {
      const rowSender = String(
        row.integratedNumber || row.integrated_number || "",
      ).trim();
      return rowSender === rmNumber || rowSender === `client-${rmNumber}`;
    });

    if (!rmRows.length) {
      console.log(
        `No transactions found for RM ${rm.label} (${rmNumber}). Skipping email.`,
      );
      continue;
    }

    // Determine the RM's email address.
    // Priority: msg91.config.json "email" field → env RM_EMAIL_<number> → admin fallback.
    let rmEmail = rm.email || "";
    if (!rmEmail) {
      rmEmail =
        process.env[`RM_EMAIL_${rmNumber}`] ||
        process.env[`RM_${rmNumber}_EMAIL`] ||
        process.env.ADMIN_EMAILS_TO ||
        "";
    }

    if (!rmEmail) {
      console.warn(
        `No email address configured or resolved for RM ${rm.label} (${rmNumber}). Skipping delivery.`,
      );
      continue;
    }

    // Generate Excel attachment for this RM
    const filenamePrefix = `rm-report-${rmNumber}`;
    const { filePath } = generateExcelFromRows(rmRows, filenamePrefix);

    // Send email to RM
    if (
      String(process.env.DISABLE_EMAIL_DELIVERY || "").toLowerCase() === "true"
    ) {
      console.log(
        `[DRY RUN] Would have sent RM report to ${rmEmail} with file ${filePath}`,
      );
      rmSentCount++;
      continue;
    }

    const smtpHost = process.env.SMTP_HOST;
    if (!smtpHost) throw new Error("SMTP_HOST not configured");

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Boolean(process.env.SMTP_SECURE === "true"),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const mailOptions = {
      from:
        process.env.SMTP_FROM ||
        process.env.SMTP_USER ||
        "software@ipkwealth.com",
      to: rmEmail,
      subject: `Relationship Manager Webhook Report - ${rm.label}`,
      text: `Hi ${rm.label.split("-")[1]?.trim() || "RM"},\n\nPlease find attached your grouped MSG91 transaction report representing deliveries and customer replies for your assigned sender number (${rmNumber}).\n\nReport Period: Selected Date-Time Range\nGenerated At: ${new Date().toLocaleString()}\n\nBest Regards,\nIPK Wealth Services Private Limited`,
      attachments: [{ filename: path.basename(filePath), path: filePath }],
    };

    // Optionally CC admin so they keep track
    if (process.env.ADMIN_EMAILS_TO) {
      mailOptions.cc = process.env.ADMIN_EMAILS_TO;
    }

    await transporter.sendMail(mailOptions);
    console.log(
      `RM report successfully sent to ${rmEmail} for sender ${rmNumber}`,
    );
    rmSentCount++;
  }

  return { count: rms.length, sent: rmSentCount };
}

async function deliverFileBySftp(filePath) {
  const host = process.env.SFTP_HOST;
  if (!host) throw new Error("SFTP_HOST not configured");
  const client = new SftpClient();
  const port = Number(process.env.SFTP_PORT || 22);
  const remotePath = process.env.SFTP_REMOTE_PATH || "/upload";
  try {
    await client.connect({
      host,
      port,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });
    const dest = path.posix.join(remotePath, path.basename(filePath));
    await client.put(filePath, dest);
  } finally {
    try {
      await client.end();
    } catch (e) {}
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

const WEBHOOK_EVENT_COLUMNS = [
  "crqid",
  "companyId",
  "requestedAt",
  "customerNumber",
  "content",
  "requestId",
  "reason",
  "eventName",
  "uuid",
  "integratedNumber",
  "direction",
  "templateName",
  "campaignName",
  "campaignRequestId",
  "templateLanguage",
  "accountManagerEmailId",
  "oneApiRequestId",
  "emailId",
  "conversationExpTimestamp",
  "moengageMsgId",
  "webengageMsgId",
  "clevertapMsgId",
  "pluginsource",
  "customerName",
  "contentType",
  "text",
  "latitude",
  "longitude",
  "caption",
  "filename",
  "url",
  "button",
  "contacts",
  "reaction",
  "interactive",
  "orders",
  "paymentStatus",
  "messageType",
  "messages",
  "webhookType",
  "ts",
  "moEngageErrorCode",
  "cleverTapErrorCode",
  "cleverTapErrorReason",
  "statusCode",
  "statusUpdatedAt",
  "price",
  "replyMsgId",
];

const MEDIA_COMPONENT_TYPES = new Set([
  "image",
  "video",
  "document",
  "audio",
  "media",
]);

function compactObject(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null && item !== "",
    ),
  );
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  });

  return values;
}

function getRuntimeEnvValues() {
  return getExternalConfigPaths(".env").reduce(
    (values, filePath) => ({ ...values, ...parseEnvFile(filePath) }),
    {},
  );
}

function findRuntimeConfigFile(fileName) {
  return getExternalConfigPaths(fileName).find((candidate) =>
    fs.existsSync(candidate),
  );
}

function readJsonFile(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveConfigValue(value, envValues) {
  if (typeof value !== "string") return value;
  return value.replace(
    /\$\{([^}]+)\}/g,
    (match, key) => envValues[key] || process.env[key] || "",
  );
}

function resolveConfigPlaceholders(value, envValues) {
  if (Array.isArray(value))
    return value.map((item) => resolveConfigPlaceholders(item, envValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveConfigPlaceholders(item, envValues),
      ]),
    );
  }
  return resolveConfigValue(value, envValues);
}

function getDefaultMsg91Config() {
  return {
    authKey: "",
    integratedNumber: "",
    integratedNumbers: [],
    namespace: "",
    templates: [],
  };
}

function normalizeIntegratedNumberValue(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits.length >= 10 ? digits : String(value || "").trim();
}

function getTemplateDisplayName(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getTemplateFieldLabel(value) {
  return getTemplateDisplayName(
    String(value || "")
      .replace(/^body_body_/, "")
      .replace(/^body_/, "")
      .replace(/^header_/, "header_"),
  );
}

function extractMsg91TemplateList(responseData) {
  const candidates = [
    responseData,
    responseData?.data,
    responseData?.templates,
    responseData?.result,
    responseData?.result?.data,
    responseData?.data?.templates,
  ];
  const list = candidates.find((candidate) => Array.isArray(candidate));
  return list || [];
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function extractComponentText(component) {
  return (
    component.text ||
    component.body ||
    component.content ||
    component.example ||
    component.sample ||
    ""
  );
}

function normalizeTemplateParameterName(value, fallback) {
  const raw = String(value || fallback || "").trim();
  if (!raw) return "";
  return raw.replace(/^{{\s*/, "").replace(/\s*}}$/, "");
}

function buildComponentKey(componentType, parameterName, index) {
  const safeParameter =
    String(parameterName || "")
      .replace(/[^a-z0-9_]+/gi, "_")
      .replace(/^_+|_+$/g, "") || index + 1;
  return `${String(componentType || "body").toLowerCase()}_${safeParameter}`;
}

function inferComponentType(component, variableDetails = {}) {
  return String(
    variableDetails.type ||
      variableDetails.content_type ||
      variableDetails.contentType ||
      component.format ||
      component.type ||
      "text",
  ).toLowerCase();
}

function normalizeMsg91CodeComponent(component) {
  if (!component || typeof component !== "object") return component;
  return {
    ...component,
    type: component.type || component.component_type,
    format: component.format || component.header_format,
  };
}

function getTemplateVariablesFromText(component, variables) {
  const text = extractComponentText(component);
  const matches = String(text).match(/{{\s*([^}]+)\s*}}/g) || [];
  matches.forEach((match, index) => {
    const parameterName = normalizeTemplateParameterName(match, index + 1);
    variables.push({ parameterName, source: "text" });
  });
}

function pushExampleVariables(component, variables) {
  const namedExamples = [
    ...toArray(component.example?.body_text_named_params),
    ...toArray(component.example?.header_text_named_params),
  ];
  namedExamples.forEach((example) => {
    if (!example?.param_name) return;
    variables.push({
      parameterName: example.param_name,
      defaultValue: example.example,
      source: "named_example",
    });
  });

  const examples = [
    ...toArray(component.example?.body_text).flat(),
    ...toArray(component.example?.header_text).flat(),
    ...toArray(component.example?.header_handle).flat(),
  ];
  examples.forEach((example, index) => {
    if (typeof example === "object") return;
    variables.push({
      parameterName: String(index + 1),
      defaultValue: example,
      source: "example",
    });
  });
}

function getComponentVariables(template, languageEntry) {
  const variableTypes =
    languageEntry.variable_type ||
    languageEntry.variableType ||
    template.variable_type ||
    template.variableType ||
    {};
  const explicitVariables = Array.isArray(languageEntry.variables)
    ? languageEntry.variables
    : Array.isArray(template.variables)
      ? template.variables
      : Object.keys(variableTypes);
  const rawComponents = [
    ...toArray(languageEntry.components),
    ...toArray(template.components),
    ...toArray(languageEntry.code),
    ...toArray(template.code),
  ].map(normalizeMsg91CodeComponent);

  const variables = [];
  rawComponents.forEach((component) => {
    const componentType = String(component.type || "body").toLowerCase();
    if (!explicitVariables.length) {
      const beforeTextVariables = variables.length;
      getTemplateVariablesFromText(component, variables);
      if (variables.length === beforeTextVariables) {
        pushExampleVariables(component, variables);
      }
    }
    if (
      !explicitVariables.length &&
      MEDIA_COMPONENT_TYPES.has(inferComponentType(component))
    ) {
      variables.push({
        parameterName: component.parameter_name || componentType,
        type: inferComponentType(component),
        source: "media",
        componentType,
      });
    }
  });

  explicitVariables.forEach((variable) => {
    const variableKey =
      typeof variable === "object"
        ? variable.key ||
          variable.name ||
          variable.parameter_name ||
          variable.parameterName
        : variable;
    if (!variableKey) return;
    const details =
      typeof variable === "object"
        ? variable
        : variableTypes[variableKey] || {};
    variables.push({
      parameterName:
        details.parameter_name ||
        details.parameterName ||
        String(variableKey).replace(/^body_/, ""),
      type: details.type,
      key: String(variableKey),
      defaultValue: details.default || details.example || "",
      source: "variable_type",
    });
  });

  const seen = new Set();
  return variables
    .map((variable, index) => {
      const parameterName = normalizeTemplateParameterName(
        variable.parameterName,
        index + 1,
      );
      const details = variableTypes[variable.key] || {};
      const type = String(
        variable.type || details.type || "text",
      ).toLowerCase();
      const key =
        variable.key ||
        buildComponentKey(
          variable.componentType || "body",
          parameterName,
          index,
        );
      return compactObject({
        key,
        label: getTemplateFieldLabel(parameterName || key),
        type,
        parameterName,
        defaultColumn: parameterName || key,
        defaultValue: variable.defaultValue,
        filenameColumn: details.filename_column || details.filenameColumn,
        defaultFilename: details.default_filename || details.defaultFilename,
        source: variable.source,
      });
    })
    .filter((component) => {
      const uniqueKey = `${component.key}:${component.parameterName}:${component.type}`;
      if (seen.has(uniqueKey)) return false;
      seen.add(uniqueKey);
      return component.key;
    });
}

function normalizeMsg91Template(template, languageEntry = {}) {
  const name =
    languageEntry.name ||
    template.name ||
    template.template_name ||
    template.templateName ||
    "";
  const language =
    languageEntry.language ||
    languageEntry.code ||
    template.language ||
    template.template_language ||
    template.templateLanguage ||
    "en";
  const id = languageEntry.id
    ? `${name}:${languageEntry.id}`
    : `${name}:${language}`;
  const components = getComponentVariables(template, languageEntry);

  return {
    id,
    name,
    label: `${getTemplateDisplayName(name)} (${language})`,
    language,
    namespace: template.namespace || languageEntry.namespace || "",
    category: template.category || "",
    status:
      languageEntry.status ||
      template.status ||
      template.template_status ||
      template.templateStatus ||
      "",
    description: [
      template.category,
      languageEntry.status || template.status || template.template_status,
    ]
      .filter(Boolean)
      .join(" | "),
    components,
    rawTemplateId: languageEntry.id || template.id || "",
  };
}

function normalizeMsg91Templates(responseData) {
  const templates = [];
  extractMsg91TemplateList(responseData).forEach((template) => {
    const languages = Array.isArray(template.languages)
      ? template.languages
      : [template];
    languages.forEach((languageEntry) => {
      const normalized = normalizeMsg91Template(template, languageEntry);
      if (normalized.name) templates.push(normalized);
    });
  });
  return templates;
}

async function fetchTemplatesForIntegratedNumber(number, authKey) {
  if (!number || !authKey) return [];
  const templates = [];
  const seenIds = new Set();
  const pageSize = 100;

  for (let pageNum = 1; pageNum <= 5; pageNum += 1) {
    const response = await axios.get(
      `https://control.msg91.com/api/v5/whatsapp/get-template-client/${encodeURIComponent(number)}`,
      {
        headers: {
          accept: "application/json",
          authkey: authKey,
          "content-type": "text/plain",
        },
        params: {
          page_num: pageNum,
          page_size: pageSize,
          pagination: "",
          template_name: "",
          template_status: "",
          template_language: "",
        },
        timeout: 20000,
      },
    );
    const pageTemplates = normalizeMsg91Templates(response.data);
    pageTemplates.forEach((template) => {
      if (seenIds.has(template.id)) return;
      seenIds.add(template.id);
      templates.push(template);
    });
    if (pageTemplates.length < pageSize) break;
  }

  return templates;
}

async function hydrateMsg91Templates(config) {
  if (!config.authKey) return config;
  const hydrated = {
    ...config,
    integratedNumbers: await Promise.all(
      config.integratedNumbers.map(async (entry) => {
        try {
          const remoteTemplates = await fetchTemplatesForIntegratedNumber(
            entry.number,
            config.authKey,
          );
          return {
            ...entry,
            templates: remoteTemplates.length
              ? remoteTemplates
              : entry.templates,
            templateFetchError: "",
          };
        } catch (error) {
          console.warn(
            `MSG91 template fetch failed for ${entry.number}:`,
            error.response?.data?.message || error.message || error,
          );
          return {
            ...entry,
            templateFetchError: error.response?.data?.message || error.message,
          };
        }
      }),
    ),
  };
  return hydrated;
}

function normalizeIntegratedNumbers(config, envValues) {
  const configuredNumbers = Array.isArray(config.integratedNumbers)
    ? config.integratedNumbers
    : [];
  const envNumbers = (
    envValues.MSG91_WHATSAPP_NUMBERS ||
    process.env.MSG91_WHATSAPP_NUMBERS ||
    ""
  )
    .split(",")
    .map((number) => number.trim())
    .filter(Boolean);
  const fallbackNumber =
    config.integratedNumber ||
    envValues.MSG91_INTEGRATED_NUMBER ||
    envValues.MSG91_WHATSAPP_NUMBER ||
    process.env.MSG91_INTEGRATED_NUMBER ||
    process.env.MSG91_WHATSAPP_NUMBER ||
    "";
  const allNumbers = configuredNumbers.length
    ? configuredNumbers
    : envNumbers.length
      ? envNumbers.map((number) => ({ number }))
      : [{ number: fallbackNumber }];

  return allNumbers
    .map((entry) => {
      const rawNumber =
        typeof entry === "string"
          ? entry
          : entry.number || entry.integratedNumber || entry.value || "";
      const number = normalizeIntegratedNumberValue(rawNumber);
      if (!number) return null;
      return {
        id: entry.id || number,
        number,
        label: entry.label || rawNumber || number,
        namespace: entry.namespace || config.namespace || "",
        templateNamespaces: entry.templateNamespaces || {},
        templates: Array.isArray(entry.templates) ? entry.templates : [],
      };
    })
    .filter(Boolean);
}

function loadMsg91Config() {
  const envValues = getRuntimeEnvValues();
  const fileConfig = readJsonFile(
    findRuntimeConfigFile("msg91.config.json"),
    getDefaultMsg91Config(),
  );
  const resolvedConfig = resolveConfigPlaceholders(fileConfig, envValues);
  const integratedNumber =
    resolvedConfig.integratedNumber ||
    envValues.MSG91_INTEGRATED_NUMBER ||
    envValues.MSG91_WHATSAPP_NUMBER ||
    process.env.MSG91_INTEGRATED_NUMBER ||
    process.env.MSG91_WHATSAPP_NUMBER ||
    "";

  msg91ConfigCache = {
    ...getDefaultMsg91Config(),
    ...resolvedConfig,
    authKey:
      resolvedConfig.authKey ||
      envValues.MSG91_AUTH_KEY ||
      process.env.MSG91_AUTH_KEY ||
      "",
    integratedNumber,
    namespace:
      resolvedConfig.namespace ||
      envValues.MSG91_TEMPLATE_NAMESPACE ||
      process.env.MSG91_TEMPLATE_NAMESPACE ||
      "",
    templates: Array.isArray(resolvedConfig.templates)
      ? resolvedConfig.templates
      : [],
  };
  msg91ConfigCache.integratedNumbers = normalizeIntegratedNumbers(
    msg91ConfigCache,
    envValues,
  );
  if (
    !msg91ConfigCache.integratedNumber &&
    msg91ConfigCache.integratedNumbers[0]
  ) {
    msg91ConfigCache.integratedNumber =
      msg91ConfigCache.integratedNumbers[0].number;
  }

  return msg91ConfigCache;
}

function getMongoConfig() {
  const envValues = getRuntimeEnvValues();

  const uri =
    envValues.MONGODB_URI ||
    envValues.DATABASE_URL ||
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL ||
    "";

  const dbName =
    envValues.MONGODB_DB_NAME ||
    process.env.MONGODB_DB_NAME ||
    "ipkwealth_crm_test";

  return { uri: String(uri).trim(), dbName: String(dbName).trim() };
}

async function initMongo() {
  if (mongoDb && mongoClient) return mongoDb;

  const { uri, dbName } = getMongoConfig();

  if (!uri) {
    console.error(
      "MongoDB URI missing. Set MONGODB_URI or DATABASE_URL in .env",
    );
    mongoDb = null;
    return null;
  }

  try {
    console.log("Connecting to MongoDB...");
    console.log("MongoDB DB Name:", dbName);
    console.log(
      "MongoDB URI Type:",
      uri.startsWith("mongodb+srv://") ? "SRV" : "STANDARD",
    );

    mongoClient = new MongoClient(uri, {
      tls: true,
      retryWrites: true,
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      minPoolSize: 0,
    });

    await mongoClient.connect();

    mongoDb = mongoClient.db(dbName);

    await mongoDb.command({ ping: 1 });

    console.log("MongoDB connected successfully.");

    await safeCreateIndex(
      mongoDb.collection("whatsapp_uploads"),
      { uploadId: 1 },
      { unique: true },
    );

    await safeCreateIndex(
      mongoDb.collection("whatsapp_numbers"),
      { uploadId: 1, numberId: 1 },
      { unique: true },
    );

    await safeCreateIndex(mongoDb.collection("whatsapp_numbers"), {
      uploadId: 1,
      id: 1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_numbers"), {
      uploadId: 1,
      cleaned: 1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_numbers"), {
      updatedAt: -1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_webhook_events"), {
      receivedAt: -1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_webhook_events"), {
      matchedUploadId: 1,
      receivedAt: -1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_webhook_events"), {
      uploadId: 1,
      receivedAt: -1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_webhook_events"), {
      source: 1,
      receivedAt: -1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_webhook_events"), {
      source: 1,
      sourceEventId: 1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_webhook_events"), {
      normalizedMobile: 1,
      receivedAt: -1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_webhook_events"), {
      eventType: 1,
      normalizedStatus: 1,
      receivedAt: -1,
    });

    await safeCreateIndex(
      mongoDb.collection("whatsapp_webhook_events"),
      { eventKey: 1 },
      { unique: true },
    );

    await safeCreateIndex(
      mongoDb.collection("whatsapp_webhook_events"),
      { stableKey: 1 },
      { sparse: true },
    );

    await safeCreateIndex(
      mongoDb.collection("whatsapp_webhook_events"),
      { source: 1, stableKey: 1 },
      {
        unique: true,
        partialFilterExpression: {
          stableKey: { $type: "string" },
        },
      },
    );

    await safeCreateIndex(mongoDb.collection("whatsapp_webhook_events"), {
      modifiedAt: -1,
    });

    await safeCreateIndex(
      mongoDb.collection("whatsapp_sender_reports"),
      { senderNumber: 1, templateName: 1, uploadId: 1, numberId: 1 },
      { unique: true },
    );

    await safeCreateIndex(mongoDb.collection("whatsapp_sender_reports"), {
      uploadId: 1,
      numberId: 1,
    });

    await safeCreateIndex(mongoDb.collection("whatsapp_sender_reports"), {
      senderNumber: 1,
      teamLabel: 1,
      updatedAt: -1,
    });

    console.log("MongoDB indexes verified.");

    return mongoDb;
  } catch (error) {
    console.error("MongoDB connection failed.");
    console.error(error);

    mongoDb = null;

    if (mongoClient) {
      try {
        await mongoClient.close();
      } catch (_) {}
      mongoClient = null;
    }

    return null;
  }
}

async function requireMongoDb() {
  if (!mongoDb || isDbClosing) {
    const connectedDb = await initMongo();

    if (!connectedDb) {
      throw new Error(
        "MongoDB is not available. Check MONGODB_URI, Atlas IP whitelist, database user, and TLS settings.",
      );
    }
  }

  return mongoDb;
}

function getWebhookBaseUrl() {
  const envValues = getRuntimeEnvValues();
  return (
    envValues.WEBHOOK_PUBLIC_BASE_URL ||
    process.env.WEBHOOK_PUBLIC_BASE_URL ||
    defaultWebhookBaseUrl
  ).replace(/\/+$/, "");
}

function isLocalWebhookUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url || "");
}

async function safeCreateIndex(collection, key, options = {}) {
  try {
    await collection.createIndex(key, options);
  } catch (error) {
    if (
      error &&
      (error.codeName === "IndexKeySpecsConflict" ||
        error.code === 86 ||
        error.code === 11000)
    ) {
      console.warn(
        `Index already exists with different options, skipping: ${collection.collectionName} ${JSON.stringify(key)}`,
      );
      return;
    }
    // For other index errors, rethrow so initMongo can handle it
    throw error;
  }
}

function getReportPollingEnabled() {
  const envValues = getRuntimeEnvValues();
  const value =
    envValues.MSG91_REPORT_POLLING_ENABLED ||
    process.env.MSG91_REPORT_POLLING_ENABLED ||
    "false";
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function assertPublicWebhookConfigured() {
  const webhookBaseUrl = getWebhookBaseUrl();
  if (isLocalWebhookUrl(webhookBaseUrl)) {
    throw new Error(
      "Set WEBHOOK_PUBLIC_BASE_URL to https://crm.ipkwealth.com before sending. MSG91 cannot send reports or replies to localhost/127.0.0.1.",
    );
  }
  if (!/^https:\/\//i.test(webhookBaseUrl)) {
    throw new Error(
      "WEBHOOK_PUBLIC_BASE_URL must be a public HTTPS URL, for example https://crm.ipkwealth.com.",
    );
  }
  return webhookBaseUrl;
}

async function mirrorMongo(collectionName, operation) {
  if (!mongoDb) return;
  try {
    await operation(mongoDb.collection(collectionName));
  } catch (error) {
    console.warn(
      `MongoDB mirror failed for ${collectionName}:`,
      error.message || error,
    );
  }
}

async function getRuntimeMsg91Config() {
  const config = loadMsg91Config();
  return hydrateMsg91Templates(config);
}

async function getPublicMsg91Config() {
  const config = await getRuntimeMsg91Config();
  const mongoConfig = getMongoConfig();
  const webhookBaseUrl = getWebhookBaseUrl();

  return {
    hasAuthKey: Boolean(config.authKey),
    integratedNumber: config.integratedNumber,
    webhookBaseUrl,
    webhookUrl: `${webhookBaseUrl}/webhook`,
    webhookIsLocalOnly: isLocalWebhookUrl(webhookBaseUrl),
    reportPollingEnabled: getReportPollingEnabled(),

    integratedNumbers: config.integratedNumbers.map((entry) => ({
      id: entry.id || entry.number,
      number: entry.number,
      label: entry.label || entry.number,
      namespace: entry.namespace || config.namespace,
      templateFetchError: entry.templateFetchError || "",

      // IMPORTANT: each sender gets only its own templates
      templates: Array.isArray(entry.templates)
        ? entry.templates.map((template) => ({
            id: template.id || template.name,
            name: template.name,
            label: template.label || template.name,
            language: template.language || "en",
            namespace:
              template.namespace || entry.namespace || config.namespace,
            description: template.description || "",
            status: template.status || "",
            category: template.category || "",
            components: Array.isArray(template.components)
              ? template.components
              : [],
          }))
        : [],
    })),

    namespace: config.namespace,
    hasMongoUri: Boolean(mongoConfig.uri),
    mongoConnected: Boolean(mongoDb),

    // fallback global templates
    templates: config.templates.map((template) => ({
      id: template.id || template.name,
      name: template.name,
      label: template.label || template.name,
      language: template.language || "en",
      namespace: template.namespace || config.namespace,
      description: template.description || "",
      // components: Array.isArray(template.components) ? template.components : [],
      components: (template.components || []).filter(
        (component) => !isButtonComponent(component),
      ),
    })),
  };
}

function findTemplateForSender(senderNumber, templateId) {
  const config = loadMsg91Config();

  if (!senderNumber) {
    throw new Error("Sender number not found.");
  }

  const senderTemplates = Array.isArray(senderNumber.templates)
    ? senderNumber.templates
    : [];

  let template = senderTemplates.find(
    (tpl) => tpl.id === templateId || tpl.name === templateId,
  );

  if (!template) {
    template = config.templates.find(
      (tpl) => tpl.id === templateId || tpl.name === templateId,
    );
  }

  if (!template) {
    throw new Error(
      `Template "${templateId}" is not allowed for sender number ${senderNumber.number}`,
    );
  }

  return template;
}

function findTemplate(templateId) {
  const config = loadMsg91Config();
  return config.templates.find(
    (template) =>
      (template.id || template.name) === templateId ||
      template.name === templateId,
  );
}

function findIntegratedNumber(numberId) {
  const config = loadMsg91Config();
  return (
    config.integratedNumbers.find(
      (entry) => entry.id === numberId || entry.number === numberId,
    ) ||
    config.integratedNumbers.find(
      (entry) => entry.number === config.integratedNumber,
    ) ||
    (config.integratedNumber
      ? {
          id: config.integratedNumber,
          number: config.integratedNumber,
          label: config.integratedNumber,
          namespace: config.namespace,
          templateNamespaces: {},
        }
      : null)
  );
}

function findIntegratedNumberInConfig(config, numberId) {
  return (
    config.integratedNumbers.find(
      (entry) => entry.id === numberId || entry.number === numberId,
    ) ||
    config.integratedNumbers.find(
      (entry) => entry.number === config.integratedNumber,
    ) ||
    null
  );
}

function getTemplateNamespace(template, senderNumber, config) {
  return (
    senderNumber?.templateNamespaces?.[template.id || template.name] ||
    senderNumber?.templateNamespaces?.[template.name] ||
    template.namespaces?.[senderNumber?.id] ||
    template.namespaces?.[senderNumber?.number] ||
    senderNumber?.namespace ||
    template.namespace ||
    config.namespace ||
    undefined
  );
}

function getTeamLabelForSender(senderNumber) {
  const config = loadMsg91Config();
  const sender = config.integratedNumbers.find(
    (entry) => entry.number === senderNumber || entry.id === senderNumber,
  );
  return sender?.label || senderNumber || "";
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;

  const trayIcon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR4AWMYmWH8z0ABYBxVSFUBCzAqmkGNgYGBYVQ0gHqgGmDUBHKAaRV5AVgDAFTSDxHizHctAAAAAElFTkSuQmCC",
  );
  tray = new Tray(trayIcon);
  tray.setToolTip("WhatsApp Bulk Sender server is running");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open WhatsApp Bulk Sender", click: showMainWindow },
      {
        label: `Webhook: http://127.0.0.1:${webhookPort}/webhook`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", showMainWindow);
}

function enableRunAtLogin() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
  });
}

function createWindow() {
  if (mainWindow) {
    showMainWindow();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 850,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, "index_modern_saas_complete.html"));
}

async function getCounterMaxConfig(name) {
  if (name === "uploads") {
    return { collectionName: "whatsapp_uploads", fields: ["uploadId", "id"] };
  }
  if (name === "numbers") {
    return { collectionName: "whatsapp_numbers", fields: ["numberId", "id"] };
  }
  if (name === "webhook_events") {
    return {
      collectionName: "whatsapp_webhook_events",
      fields: ["eventId", "id"],
    };
  }
  return null;
}

async function getExistingMaxCounterValue(name) {
  const config = await getCounterMaxConfig(name);
  if (!config) return 0;

  let maxValue = 0;
  const collection = mongoDb.collection(config.collectionName);

  for (const field of config.fields) {
    const row = await collection
      .find({ [field]: { $type: "number" } }, { projection: { [field]: 1 } })
      .sort({ [field]: -1 })
      .limit(1)
      .next();

    const value = Number(row?.[field] || 0);
    if (Number.isFinite(value) && value > maxValue) {
      maxValue = value;
    }
  }

  return maxValue;
}

async function getCounter(name) {
  if (!mongoDb) throw new Error("MongoDB is not connected.");

  const counters = mongoDb.collection("whatsapp_counters");
  const existingMax = await getExistingMaxCounterValue(name);

  let result = await counters.findOneAndUpdate(
    { _id: name },
    {
      $inc: { seq: 1 },
      $setOnInsert: { createdAt: new Date().toISOString() },
      $set: { updatedAt: new Date().toISOString() },
    },
    { upsert: true, returnDocument: "after" },
  );

  let seq = Number(result.value?.seq || result.seq || 1);

  // Self-heal old counters. If Mongo already has uploadId/numberId/eventId
  // greater than the counter value, jump the counter forward instead of
  // reusing an existing unique key. This fixes E11000 duplicate uploadId errors.
  if (existingMax >= seq) {
    const nextSeq = existingMax + 1;
    result = await counters.findOneAndUpdate(
      { _id: name },
      {
        $set: { seq: nextSeq, updatedAt: new Date().toISOString() },
        $setOnInsert: { createdAt: new Date().toISOString() },
      },
      { upsert: true, returnDocument: "after" },
    );
    seq = Number(result.value?.seq || result.seq || nextSeq);
  }

  return seq;
}

function makeRunResult(lastID = null, changes = 0) {
  return { lastID, changes };
}

async function getUploadsCollection() {
  if (!mongoDb) throw new Error("MongoDB is not connected.");
  return mongoDb.collection("whatsapp_uploads");
}

async function getNumbersCollection() {
  if (!mongoDb) throw new Error("MongoDB is not connected.");
  return mongoDb.collection("whatsapp_numbers");
}

async function getWebhookEventsCollection() {
  if (!mongoDb) throw new Error("MongoDB is not connected.");
  return mongoDb.collection("whatsapp_webhook_events");
}

function normalizeMongoDoc(doc) {
  if (!doc) return doc;
  const clone = { ...doc };
  delete clone._id;
  return clone;
}

function toRegexSearch(value) {
  return new RegExp(
    String(value || "")
      .replace(/^%|%$/g, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );
}

async function listNumbersByUpload(uploadId, options = {}) {
  await requireMongoDb();
  const query = { uploadId: Number(uploadId) };
  if (options.validOnly) query.valid = { $in: [1, true] };
  if (options.deliveryStatus) query.deliveryStatus = options.deliveryStatus;
  const cursor = mongoDb
    .collection("whatsapp_numbers")
    .find(query, options.projection ? { projection: options.projection } : {})
    .sort(
      options.desc
        ? { id: -1, numberId: -1, _id: -1 }
        : { id: 1, numberId: 1, _id: 1 },
    );
  const rows = await cursor.toArray();
  return rows.map(normalizeMongoDoc);
}

async function getNumberById(numberId, projection = null) {
  await requireMongoDb();
  const n = Number(numberId);
  const row = await mongoDb
    .collection("whatsapp_numbers")
    .findOne(
      { $or: [{ id: n }, { numberId: n }] },
      projection ? { projection } : {},
    );
  return row ? normalizeMongoDoc(row) : null;
}

async function getUploadById(uploadId) {
  await requireMongoDb();
  const n = Number(uploadId);
  const row = await mongoDb.collection("whatsapp_uploads").findOne({
    $or: [{ id: n }, { uploadId: n }],
  });
  return row ? normalizeMongoDoc(row) : null;
}

async function getNumberWithUploadById(numberId) {
  const number = await getNumberById(numberId);
  if (!number) return null;
  const upload = await getUploadById(number.uploadId);
  return {
    ...number,
    senderId: upload?.senderId || "",
    templateId: upload?.templateId || "",
    templateName: upload?.templateName || "",
    templateLabel: upload?.templateLabel || "",
  };
}

async function findLatestNumberByMobile(mobile, uploadId = null) {
  await requireMongoDb();
  const query = { cleaned: String(mobile || "") };
  if (uploadId !== undefined && uploadId !== null && uploadId !== "") {
    query.uploadId = Number(uploadId);
  }
  const row = await mongoDb
    .collection("whatsapp_numbers")
    .find(query)
    .sort({ lastUpdated: -1, updatedAt: -1, id: -1, numberId: -1, _id: -1 })
    .limit(1)
    .next();
  return row ? { id: row.id, uploadId: row.uploadId } : null;
}

async function findNumberByMessageKey(normalized, context = {}) {
  await requireMongoDb();
  const requestId = normalized?.requestId ? String(normalized.requestId) : "";
  if (!requestId) return null;

  const query = {
    $or: [{ responseId: requestId }, { messageId: requestId }],
  };

  if (normalized?.normalizedMobile) {
    query.cleaned = String(normalized.normalizedMobile);
  }

  const uploadId = normalized?.uploadId || context.uploadId || null;
  if (uploadId !== undefined && uploadId !== null && uploadId !== "") {
    query.uploadId = Number(uploadId);
  }
  const candidates = await mongoDb
    .collection("whatsapp_numbers")
    .find(query)
    .sort({ id: 1, numberId: 1, _id: 1 })
    .toArray();

  // When the same wamid was written to multiple rows (same phone, multiple
  // orders in one batch — the pre-fix behaviour), prefer the oldest row that
  // hasn't received a reply yet so each order gets its own reply instead of
  // all replies collapsing onto the first row.
  const row =
    candidates.find((r) => !r.customReply && !r.lastReplyAt) ||
    candidates[0] ||
    null;

  return row ? { id: row.id, uploadId: row.uploadId } : null;
}

function extractWebhookContentValues(item = {}) {
  const content = parseMaybeJson(item.content);
  if (!content || typeof content !== "object") return [];

  return Object.values(content)
    .map((entry) => {
      if (entry && typeof entry === "object")
        return entry.text || entry.value || "";
      return entry;
    })
    .map((value) => String(value || "").trim())
    .filter((value) => value && value.length > 1);
}

function scoreWebhookNumberMatch(row, values) {
  if (!values.length) return 0;
  const rowText = [
    row.sentMessage,
    row.original,
    row.cleaned,
    typeof row.data === "string" ? row.data : JSON.stringify(row.data || {}),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return values.reduce((score, value) => {
    const text = value.toLowerCase();
    return rowText.includes(text) ? score + 1 : score;
  }, 0);
}

async function findNumberByWebhookContent(normalized, context = {}) {
  if (normalized?.eventType !== "outbound") return null;
  const uploadId = normalized?.uploadId || context.uploadId || null;
  if (!uploadId || !normalized?.normalizedMobile) return null;

  const values = extractWebhookContentValues(normalized.raw);
  if (!values.length) return null;

  const candidates = await mongoDb
    .collection("whatsapp_numbers")
    .find({
      uploadId: Number(uploadId),
      cleaned: String(normalized.normalizedMobile),
    })
    .toArray();

  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreWebhookNumberMatch(candidate, values);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best && bestScore >= 2
    ? { id: best.id, uploadId: best.uploadId }
    : null;
}

async function findLatestNumberForWebhook(normalized, context = {}) {
  if (!normalized?.normalizedMobile) return null;
  const directMatch = await findNumberByMessageKey(normalized, context);
  if (directMatch) return directMatch;

  const contentMatch = await findNumberByWebhookContent(normalized, context);
  if (contentMatch) return contentMatch;

  // For inbound events that carry a requestId (replyMsgId), do NOT fall back to
  // the mobile-only lookup. Multiple sent messages can share the same mobile and
  // the fallback would always pick the most-recent one, causing all replies to
  // appear on a single row instead of the correct one.
  if (normalized?.eventType === "inbound" && normalized?.requestId) return null;

  return findLatestNumberByMobile(
    normalized.normalizedMobile,
    context.uploadId || null,
  );
}

async function getNumberIdsByUploadAndMobile(uploadId, cleaned) {
  await requireMongoDb();
  const rows = await mongoDb
    .collection("whatsapp_numbers")
    .find(
      { uploadId: Number(uploadId), cleaned: String(cleaned || "") },
      { projection: { id: 1, numberId: 1, cleaned: 1, uploadId: 1 } },
    )
    .sort({ id: 1, numberId: 1, _id: 1 })
    .toArray();
  return rows
    .filter((r) => String(r.cleaned) === String(cleaned))
    .map(normalizeMongoDoc);
}

async function insertUploadDoc(upload) {
  await requireMongoDb();
  const id = await getCounter("uploads");
  const doc = {
    id,
    uploadId: id,
    ...upload,
    reportPollFailureCount: 0,
    reportPollNextAt: null,
    reportPollError: null,
    updatedAt: new Date().toISOString(),
  };
  const { createdAt: uploadCreatedAt, ...uploadSetDoc } = doc;

  await mongoDb
    .collection("whatsapp_uploads")
    .updateOne(
      { uploadId: id },
      {
        $set: uploadSetDoc,
        $setOnInsert: {
          createdAt: uploadCreatedAt || new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  return makeRunResult(id, 1);
}

async function insertNumberDoc(number) {
  await requireMongoDb();
  const id = await getCounter("numbers");
  const now = new Date().toISOString();
  const doc = {
    id,
    numberId: id,
    responseDetails: null,
    replyHistory: [],
    sentMessage: null,
    customReply: null,
    lastReplyAt: null,
    ...number,
    createdAt: now,
    updatedAt: now,
  };
  const { createdAt: numberCreatedAt, ...numberSetDoc } = doc;

  await mongoDb
    .collection("whatsapp_numbers")
    .updateOne(
      { uploadId: doc.uploadId, numberId: id },
      {
        $set: numberSetDoc,
        $setOnInsert: { createdAt: numberCreatedAt || now },
      },
      { upsert: true },
    );
  return makeRunResult(id, 1);
}

async function updateUploadFields(uploadId, fields) {
  await requireMongoDb();
  const n = Number(uploadId);
  await mongoDb
    .collection("whatsapp_uploads")
    .updateOne(
      { $or: [{ id: n }, { uploadId: n }] },
      { $set: { ...fields, updatedAt: new Date().toISOString() } },
    );
  return makeRunResult(null, 1);
}

async function updateNumberFields(numberId, fields) {
  await requireMongoDb();
  const n = Number(numberId);
  await mongoDb
    .collection("whatsapp_numbers")
    .updateOne(
      { $or: [{ id: n }, { numberId: n }] },
      {
        $set: { ...compactObject(fields), updatedAt: new Date().toISOString() },
      },
    );
  return makeRunResult(null, 1);
}

async function updateNumberFieldsWithInc(numberId, fields, inc = null) {
  await requireMongoDb();
  const update = {
    $set: { ...compactObject(fields), updatedAt: new Date().toISOString() },
  };
  if (inc) update.$inc = inc;
  await mongoDb
    .collection("whatsapp_numbers")
    .updateOne({ id: Number(numberId) }, update);
  return makeRunResult(null, 1);
}

async function hasProcessedRemoteEvent(sourceEventId) {
  if (!sourceEventId) return false;
  await requireMongoDb();
  const row = await mongoDb
    .collection("whatsapp_webhook_events")
    .findOne(
      { sourceEventId: String(sourceEventId) },
      { projection: { id: 1, eventId: 1 } },
    );
  return Boolean(row);
}

async function upsertWebhookEventDoc(doc) {
  await requireMongoDb();
  const webhooks = mongoDb.collection("whatsapp_webhook_events");
  const now = new Date().toISOString();

  if (doc.rawPayload && typeof doc.rawPayload === "string") {
    try {
      const raw = JSON.parse(doc.rawPayload);
      doc.rawPayload = raw;
      doc.text = doc.text || raw.text || null;
      doc.button = doc.button || raw.button || null;
      doc.interactive = doc.interactive || raw.interactive || null;
      doc.messages = doc.messages || raw.messages || null;
    } catch {}
  }

  if (doc.source === "crm-webhook" && doc.sourceEventId) {
    const sourceEventId = String(doc.sourceEventId);
    const existing = await webhooks.findOne(
      { sourceEventId },
      { projection: { id: 1, eventId: 1 } },
    );
    if (existing) {
      await webhooks.updateOne(
        { sourceEventId },
        {
          $set: {
            rawPayload: doc.rawPayload || null,
            updatedAt: now,
            modifiedAt: now,
            lastSeenAt: now,
          },
          $inc: { seenCount: 1 },
        },
      );
      return makeRunResult(existing.id || existing.eventId || null, 0);
    }

    const id = await getCounter("webhook_events");
    const eventDoc = {
      ...doc,
      id,
      eventId: id,
      sourceEventId,
      createdAt: doc.createdAt || now,
      updatedAt: now,
      modifiedAt: now,
      lastSeenAt: now,
      seenCount: 1,
    };
    await webhooks.updateOne(
      { sourceEventId },
      { $setOnInsert: eventDoc },
      { upsert: true },
    );
    return makeRunResult(id, 1);
  }

  // Use matchedUploadId instead of a raw timestamp so repeated delivery-status
  // polls for the same phone+upload produce one document (updated) not one per call.
  const keyParts = [
    doc.source || "local",
    doc.requestId || "",
    doc.uuid || "",
    doc.replyMsgId || "",
    doc.normalizedMobile || "",
    doc.eventType || "",
    doc.normalizedStatus || "",
    String(doc.matchedUploadId ?? ""),
    doc.text || "",
  ];
  const eventKey = keyParts.join("|");
  const stableKey = doc.stableKey || null;
  const existingByEventKey = await webhooks.findOne(
    { eventKey },
    { projection: { id: 1, eventId: 1, eventKey: 1, stableKey: 1 } },
  );
  const existingByStableKey =
    !existingByEventKey && stableKey
      ? await webhooks.findOne(
          { stableKey },
          { projection: { id: 1, eventId: 1, eventKey: 1, stableKey: 1 } },
        )
      : null;
  const existing = existingByEventKey || existingByStableKey;
  if (existing) {
    const setFields = {
      stableKey: stableKey || existing.stableKey || null,
      rawPayload: doc.rawPayload || null,
      updatedAt: now,
      modifiedAt: now,
      lastSeenAt: now,
    };
    if (existingByEventKey || !existing.eventKey) {
      setFields.eventKey = eventKey;
    }
    await webhooks.updateOne(
      { _id: existing._id },
      {
        $set: setFields,
        $inc: { seenCount: 1 },
      },
    );
    return makeRunResult(existing.id || existing.eventId || null, 0);
  }

  const id = await getCounter("webhook_events");
  const eventDoc = {
    ...doc,
    eventKey,
    stableKey,
    id,
    eventId: id,
    createdAt: doc.createdAt || now,
    updatedAt: now,
    modifiedAt: now,
    lastSeenAt: now,
    seenCount: 1,
  };
  await webhooks.updateOne(
    { eventKey },
    { $setOnInsert: eventDoc },
    { upsert: true },
  );
  return makeRunResult(id, 1);
}

async function listUploadsWithCountsForDateRange(startIso, endIso) {
  await requireMongoDb();
  const uploadQuery = {};
  if (startIso || endIso) {
    uploadQuery.createdAt = {};
    if (startIso) uploadQuery.createdAt.$gte = startIso;
    if (endIso) uploadQuery.createdAt.$lte = endIso;
  }
  const uploadRows = await mongoDb
    .collection("whatsapp_uploads")
    .find(uploadQuery)
    .sort({ createdAt: -1, id: -1, uploadId: -1, _id: -1 })
    .limit(200)
    .toArray();

  const output = [];
  for (const upload of uploadRows) {
    const effectiveUploadId = Number(upload.uploadId || upload.id);
    const rows = await mongoDb
      .collection("whatsapp_numbers")
      .find({ uploadId: effectiveUploadId })
      .toArray();

    output.push({
      ...normalizeMongoDoc(upload),
      id: upload.id || upload.uploadId,
      uploadId: upload.uploadId || upload.id,
      validCount: rows.filter((r) => Number(r.valid) === 1 || r.valid === true)
        .length,
      invalidCount: rows.filter(
        (r) => !(Number(r.valid) === 1 || r.valid === true),
      ).length,
      deliveredCount: rows.filter((r) => r.deliveryStatus === "delivered")
        .length,
      failedCount: rows.filter((r) => r.deliveryStatus === "failed").length,
    });
  }
  return output;
}

async function listPendingReportUploads(nowIso) {
  await requireMongoDb();
  return (
    await mongoDb
      .collection("whatsapp_uploads")
      .find({
        apiMessageId: { $nin: [null, ""] },
        apiKey: { $nin: [null, ""] },
        status: { $in: ["sent", "reporting", "partial", "completed"] },
        $or: [
          { reportPollNextAt: null },
          { reportPollNextAt: { $lte: nowIso } },
          { reportPollNextAt: { $exists: false } },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray()
  ).map(normalizeMongoDoc);
}

function addReportOrCondition(query, orConditions) {
  if (!orConditions.length) return;
  if (query.$and) {
    query.$and.push({ $or: orConditions });
  } else if (query.$or) {
    query.$and = [{ $or: query.$or }, { $or: orConditions }];
    delete query.$or;
  } else {
    query.$or = orConditions;
  }
}

function normalizeSenderFilterValue(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D+/g, "");
  return digits.length >= 10 ? digits : raw;
}

function getTemplateFilterCandidates(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "all") return [];
  const withoutLanguage = raw.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  const beforeColon = raw.split(":")[0].trim();
  const normalized = withoutLanguage
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return [
    ...new Set([raw, beforeColon, withoutLanguage, normalized].filter(Boolean)),
  ];
}

async function listCustomReportRowsFromMongo(filters = {}) {
  await requireMongoDb();
  const query = {};
  const dateQuery = {};
  if (filters.startDateTime) dateQuery.$gte = filters.startDateTime;
  if (filters.endDateTime) dateQuery.$lt = filters.endDateTime;
  if (Object.keys(dateQuery).length) {
    query.$or = [
      { receivedAt: dateQuery },
      { statusUpdatedAt: dateQuery },
      { requestedAt: dateQuery },
      { updatedAt: dateQuery },
    ];
  }
  if (filters.eventType && filters.eventType !== "all")
    query.eventType = filters.eventType;
  if (filters.status && filters.status !== "all") {
    if (filters.status === "inbound") query.eventType = "inbound";
    else query.normalizedStatus = filters.status;
  }
  if (filters.filteredNumberId && filters.filteredNumberId !== "all") {
    const sender = normalizeSenderFilterValue(filters.filteredNumberId);
    query.$and = [
      ...(query.$and || []),
      {
        $or: [
          { integratedNumber: sender },
          { integrated_number: sender },
          { senderNumber: sender },
          { "rawPayload.integratedNumber": sender },
          { "rawPayload.integrated_number": sender },
        ],
      },
    ];
  }
  if (filters.templateName && filters.templateName !== "all") {
    const candidates = getTemplateFilterCandidates(filters.templateName);
    query.$and = [
      ...(query.$and || []),
      {
        $or: candidates.flatMap((candidate) => [
          { templateName: candidate },
          { "rawPayload.templateName": candidate },
          { "rawPayload.template_name": candidate },
          { campaignName: candidate },
          { "rawPayload.campaignName": candidate },
        ]),
      },
    ];
  }

  const events = await mongoDb
    .collection("whatsapp_webhook_events")
    .find(query)
    .sort({ receivedAt: -1, statusUpdatedAt: -1, updatedAt: -1, _id: -1 })
    .limit(5000)
    .toArray();

  const rows = events.map((event, index) => {
    const raw = parseJsonField(event.rawPayload, event.rawPayload || {});
    const text =
      event.text ||
      event.customReply ||
      extractWebhookMessageText(raw || event);
    return {
      ...normalizeMongoDoc(event),
      id: event.id || event.eventId || event.eventKey || `event-${index}`,
      eventType: event.eventType || inferMsg91EventType(raw || event),
      normalizedStatus:
        event.normalizedStatus ||
        (event.eventType === "inbound"
          ? "inbound"
          : createStatusLabel(
              event.eventName || event.statusCode || event.reason,
            )),
      normalizedMobile:
        formatPhoneForCall(
          event.normalizedMobile ||
            event.customerNumber ||
            raw.customerNumber ||
            raw.mobile ||
            raw.to ||
            extractMobileFromWebhookMessages(raw.messages),
        ) || "",
      customerNumber:
        event.customerNumber ||
        raw.customerNumber ||
        raw.customer_number ||
        event.normalizedMobile ||
        "",
      integratedNumber:
        event.integratedNumber ||
        event.integrated_number ||
        raw.integratedNumber ||
        raw.integrated_number ||
        "",
      integrated_number:
        event.integrated_number ||
        event.integratedNumber ||
        raw.integrated_number ||
        raw.integratedNumber ||
        "",
      templateName:
        event.templateName || raw.templateName || raw.template_name || "",
      campaignName:
        event.campaignName || raw.campaignName || raw.campaign_name || "",
      receivedAt:
        event.receivedAt ||
        event.statusUpdatedAt ||
        event.requestedAt ||
        event.createdAt ||
        "",
      requestedAt: event.requestedAt || raw.requestedAt || "",
      statusUpdatedAt: event.statusUpdatedAt || raw.statusUpdatedAt || "",
      requestId:
        event.requestId ||
        raw.requestId ||
        raw.replyMsgId ||
        raw.oneApiRequestId ||
        raw.uuid ||
        "",
      text,
      customReply:
        event.customReply || (event.eventType === "inbound" ? text : ""),
      lastReplyAt:
        event.lastReplyAt ||
        (event.eventType === "inbound" ? event.receivedAt : ""),
      rawPayload: raw || {},
      reason:
        event.reason ||
        raw.reason ||
        raw.cleverTapErrorReason ||
        raw.cleverTapErrorCode ||
        "",
      price: event.price || raw.price || "",
      numberCurrentStatus: event.numberCurrentStatus || "",
      numberDeliveryStatus: event.numberDeliveryStatus || "",
      uploadFileName: event.uploadFileName || "",
      uploadTemplateLabel: event.uploadTemplateLabel || "",
      csvRowData: event.csvRowData || {},
    };
  });

  return rows.filter((row) => reportRowMatchesSearch(row, filters.search));
}
async function ensureColumn() {
  // MongoDB is schemaless; no action required.
}

async function initDb() {
  await initMongo();
  if (!mongoDb) {
    throw new Error(
      "MongoDB connection is required. Set DATABASE_URL or MONGODB_URI in .env.",
    );
  }
  db = {
    close: (callback) => {
      if (typeof callback === "function") callback();
    },
  };
}

function normalizeCellText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/^\uFEFF/, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function expandScientificNumber(value) {
  const raw = normalizeCellText(value).replace(/,/g, "");
  if (!/^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(raw)) return raw;
  const [coefficient, exponentText] = raw.toLowerCase().split("e");
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 30) return raw;
  const negative = coefficient.startsWith("-");
  const unsigned = coefficient.replace(/^[+-]/, "");
  const [whole, decimal = ""] = unsigned.split(".");
  const digits = `${whole}${decimal}`;
  const decimalPlaces = decimal.length;
  const zeroCount = exponent - decimalPlaces;
  if (zeroCount >= 0)
    return `${negative ? "-" : ""}${digits}${"0".repeat(zeroCount)}`;
  const splitAt = digits.length + zeroCount;
  return `${negative ? "-" : ""}${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
}

function formatPhoneForCall(input) {
  if (input === null || input === undefined) return "";
  const raw = expandScientificNumber(input).replace(/\.0+$/, "");
  let cleaned = raw.replace(/\D+/g, "");

  if (raw.startsWith("+")) return cleaned;

  if (cleaned.startsWith("00") && cleaned.length > 10) {
    cleaned = cleaned.slice(2);
  }

  if (cleaned.length === 10 && cleaned.startsWith("65")) {
    return cleaned;
  }

  if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
    return `91${cleaned}`;
  }

  if (
    cleaned.length === 11 &&
    cleaned.startsWith("0") &&
    /^[6-9]/.test(cleaned.slice(1))
  ) {
    return `91${cleaned.slice(1)}`;
  }

  if (cleaned.length === 12 && cleaned.startsWith("091")) {
    return cleaned.slice(1);
  }

  if (cleaned.length > 10) {
    return cleaned;
  }

  return cleaned;
}

function isValidWhatsappNumber(cleaned) {
  if (!cleaned) return false;
  if (/^91[6-9]\d{9}$/.test(cleaned)) return true; // Indian mobile (91 + 6/7/8/9 + 9 digits)
  if (/^91\d{10}$/.test(cleaned)) return false; // Indian non-mobile — WhatsApp unsupported
  if (/^65[89]\d{7}$/.test(cleaned)) return true; // Singapore mobile (65 + 8/9 + 7 digits)
  if (/^65\d{8}$/.test(cleaned)) return false; // Singapore landline — WhatsApp unsupported
  return /^[1-9]\d{7,14}$/.test(cleaned);
}

function findMobileField(headers) {
  const normalized = headers.map((header) =>
    normalizeCellText(header).toLowerCase().replace(/[_-]+/g, " ").trim(),
  );
  const mobileHeader = normalized.find((header) =>
    /\b(mobile|phone|whatsapp|wa|contact|number)\b/.test(header),
  );
  if (!mobileHeader) return headers[0] || "";
  return headers[normalized.indexOf(mobileHeader)];
}

async function parseCsvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error("Import file not found.");
  }

  const rows = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(
        csvParser({ mapHeaders: ({ header }) => normalizeCellText(header) }),
      )
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

async function parseSpreadsheetFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".csv") return parseCsvFile(filePath);
  if (![".xlsx", ".xls"].includes(extension)) {
    throw new Error("Only CSV, XLS, and XLSX files are supported.");
  }

  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    defval: "",
    raw: true,
  });
}

function normalizeRow(row) {
  const normalized = {};
  Object.entries(row).forEach(([key, value]) => {
    normalized[normalizeCellText(key)] = normalizeCellText(value);
  });
  return normalized;
}

async function storeUpload(filePath, fileName, rawRows) {
  const rows = rawRows
    .map((rowData) => {
      const row = normalizeRow(rowData);
      const headers = Object.keys(row);
      const mobileKey = findMobileField(headers);
      const original = normalizeCellText(row[mobileKey]);
      const cleaned = formatPhoneForCall(original);
      const valid = isValidWhatsappNumber(cleaned);
      return {
        original,
        cleaned,
        valid,
        data: JSON.stringify(row),
        currentStatus: valid ? "pending" : "invalid",
        deliveryStatus: valid ? "pending" : "invalid",
        retryCount: 0,
        responseId: null,
        messageId: null,
        lastUpdated: new Date().toISOString(),
      };
    })
    .filter((row) => {
      const data = parseJsonField(row.data, {});
      return (
        row.original ||
        Object.values(data).some((value) => normalizeCellText(value))
      );
    });

  if (!rows.length) {
    throw new Error("No recipient rows found in the selected CSV/Excel file.");
  }

  const totalRecords = rows.length;
  const validCount = rows.filter((row) => row.valid).length;
  const invalidCount = totalRecords - validCount;
  const createdAt = new Date().toISOString();

  const uploadResult = await insertUploadDoc({
    fileName,
    filePath,
    totalRecords,
    validCount,
    invalidCount,
    apiMessageId: null,
    apiResponse: null,
    apiKey: null,
    senderId: null,
    status: "new",
    createdAt,
  });

  const uploadId = uploadResult.lastID;
  for (const row of rows) {
    await insertNumberDoc({
      uploadId,
      original: row.original,
      cleaned: row.cleaned,
      valid: row.valid ? 1 : 0,
      data: row.data,
      currentStatus: row.currentStatus,
      deliveryStatus: row.deliveryStatus,
      retryCount: row.retryCount,
      responseId: row.responseId,
      messageId: row.messageId,
      lastUpdated: row.lastUpdated,
    });
  }

  const storedNumbers = await listNumbersByUpload(uploadId);

  const previewRows = storedNumbers.map((row) => ({
    ...row,
    data: parseRowData(row),
    valid: Boolean(row.valid),
    currentStatus: row.currentStatus || (row.valid ? "pending" : "invalid"),
    deliveryStatus: row.deliveryStatus || (row.valid ? "pending" : "invalid"),
  }));

  return {
    upload: {
      id: uploadId,
      uploadId,
      fileName,
      filePath,
      totalRecords,
      validCount,
      invalidCount,
      status: "new",
      apiMessageId: null,
    },
    rows: previewRows,
  };
}

async function updateUploadStatus(uploadId) {
  const rows = await listNumbersByUpload(uploadId, {
    validOnly: true,
    projection: { deliveryStatus: 1 },
  });
  if (!rows.length) {
    await updateUploadFields(uploadId, { status: "new" });
    return;
  }

  const delivered = rows.filter(
    (row) => row.deliveryStatus === "delivered",
  ).length;
  const failed = rows.filter((row) => row.deliveryStatus === "failed").length;
  const pending = rows.filter((row) => row.deliveryStatus === "pending").length;
  let status = "sent";

  if (delivered === rows.length) {
    status = "completed";
  } else if (failed > 0 && pending === 0) {
    status = "partial";
  } else if (pending > 0) {
    status = "reporting";
  }

  await updateUploadFields(uploadId, { status });
}

function parseRowData(row) {
  if (!row?.data) return {};
  if (typeof row.data === "object") return row.data;
  try {
    return JSON.parse(row.data);
  } catch (error) {
    return {};
  }
}

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function stringifyResponseDetails(value) {
  if (value === undefined || value === null || value === "") return null;
  return JSON.stringify(value);
}

function appendReplyHistory(existingValue, reply) {
  const parsedHistory = parseJsonField(existingValue, []);
  const history = Array.isArray(parsedHistory) ? parsedHistory : [];
  history.push(reply);
  return JSON.stringify(history.slice(-50));
}

async function mirrorNumberById(numberId) {
  if (!numberId) return;
  const row = await getNumberById(numberId);
  if (!row) return;
  await mirrorMongo("whatsapp_numbers", (collection) =>
    collection.updateOne(
      { uploadId: row.uploadId, numberId: row.id },
      {
        $set: {
          uploadId: row.uploadId,
          numberId: row.id,
          original: row.original,
          cleaned: row.cleaned,
          valid: Boolean(row.valid),
          data: parseRowData(row),
          currentStatus: row.currentStatus,
          deliveryStatus: row.deliveryStatus,
          retryCount: row.retryCount || 0,
          responseId: row.responseId,
          messageId: row.messageId,
          responseDetails: parseJsonField(row.responseDetails, null),
          sentMessage: row.sentMessage || null,
          customReply: row.customReply || null,
          replyHistory: parseJsonField(row.replyHistory, []),
          lastReplyAt: row.lastReplyAt || null,
          lastUpdated: row.lastUpdated,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    ),
  );
}

function getTemplateComponentValue(rowData, component, mapping) {
  const staticValue =
    mapping?.[`${component.key}:staticValue`] ||
    mapping?.[`${component.parameterName}:staticValue`];
  if (
    staticValue !== undefined &&
    staticValue !== null &&
    String(staticValue).trim()
  ) {
    return String(staticValue).trim();
  }

  const mappedColumn =
    mapping?.[component.key] ||
    mapping?.[component.parameterName] ||
    component.defaultColumn;
  if (
    mappedColumn &&
    rowData[mappedColumn] !== undefined &&
    rowData[mappedColumn] !== null
  ) {
    return String(rowData[mappedColumn]);
  }
  const alternatives = [
    component.parameterName,
    component.key,
    String(component.defaultColumn || "").replace(/^body_body_/, ""),
    String(component.defaultColumn || "").replace(/^body_/, ""),
    String(component.parameterName || "").replace(/^body_/, ""),
    String(component.key || "")
      .replace(/^body_body_/, "")
      .replace(/^body_/, ""),
  ].filter(Boolean);
  const normalizedEntries = Object.entries(rowData).map(([key, value]) => [
    key.toLowerCase().replace(/[^a-z0-9]/g, ""),
    value,
  ]);
  for (const alternative of alternatives) {
    const normalized = alternative.toLowerCase().replace(/[^a-z0-9]/g, "");
    const match = normalizedEntries.find(([key]) => key === normalized);
    if (match && match[1] !== undefined && match[1] !== null) {
      return String(match[1]);
    }
  }
  if (component.defaultValue !== undefined && component.defaultValue !== null) {
    return String(component.defaultValue);
  }
  return "";
}

function getTemplateComponentFilename(rowData, component, mapping) {
  const mappedColumn =
    mapping?.[`${component.key}:filename`] || component.filenameColumn;
  if (
    mappedColumn &&
    rowData[mappedColumn] !== undefined &&
    rowData[mappedColumn] !== null &&
    String(rowData[mappedColumn]).trim()
  ) {
    return String(rowData[mappedColumn]).trim();
  }
  return component.defaultFilename || "document.pdf";
}
function isButtonComponent(component = {}) {
  const type = String(component.type || "").toLowerCase();
  const subType = String(
    component.sub_type || component.subType || "",
  ).toLowerCase();
  const key = String(component.key || component.name || "").toLowerCase();

  return (
    type.includes("button") ||
    type.includes("quick_reply") ||
    subType.includes("quick_reply") ||
    key.includes("button") ||
    key.includes("quick_reply") ||
    key.includes("execute") ||
    key.includes("deny")
  );
}
function buildTemplateComponents(rowData, template, mapping) {
  const components = {};

  const templateComponents = Array.isArray(template.components)
    ? template.components
    : [];

  templateComponents
    .filter((component) => !isButtonComponent(component))
    .forEach((component) => {
      if (!component.key) return;

      const type = String(component.type || "text").toLowerCase();
      const value = getTemplateComponentValue(rowData, component, mapping);

      if (type === "document") {
        components[component.key] = {
          filename: getTemplateComponentFilename(rowData, component, mapping),
          type,
          value,
        };
        return;
      }

      if (!component.parameterName) return;

      components[component.key] = {
        type: "text",
        value,
        parameter_name: component.parameterName,
      };
    });

  return components;
}

function buildReadableMessage(rowData, template, mapping) {
  const parts = (template.components || []).map((component) => {
    const label = component.label || component.parameterName || component.key;
    return `${label}: ${getTemplateComponentValue(rowData, component, mapping) || "-"}`;
  });
  return parts.join(" | ");
}

function getSenderReportFilter(uploadId, numberId) {
  return { uploadId, numberId };
}

async function mirrorSenderReport(update) {
  await mirrorMongo("whatsapp_sender_reports", (collection) =>
    collection.updateOne(
      getSenderReportFilter(update.uploadId, update.numberId),
      {
        $set: compactObject({
          senderNumber: update.senderNumber,
          teamLabel: update.teamLabel,
          uploadId: update.uploadId,
          numberId: update.numberId,
          mobile: update.mobile,
          templateId: update.templateId,
          templateName: update.templateName,
          templateLabel: update.templateLabel,
          sentMessage: update.sentMessage,
          sentAt: update.sentAt,
          currentStatus: update.currentStatus,
          deliveryStatus: update.deliveryStatus,
          responseId: update.responseId,
          messageId: update.messageId,
          responseDetails: update.responseDetails,
          customReply: update.customReply,
          replyHistory: update.replyHistory,
          lastReplyAt: update.lastReplyAt,
          webhook: update.webhook,
          report: update.report,
          csvRowData: update.csvRowData,
          updatedAt: new Date().toISOString(),
        }),
        $setOnInsert: { createdAt: new Date().toISOString() },
      },
      { upsert: true },
    ),
  );
}

function getApiMessageId(responseData) {
  return (
    responseData.message_id ||
    responseData.id ||
    responseData.data?.message_id ||
    responseData.request_id ||
    null
  );
}

function getBulkResponseItems(responseData) {
  const items =
    responseData?.result?.data ||
    responseData?.data ||
    responseData?.messages ||
    [];
  return Array.isArray(items) ? items : [items];
}

function normalizeWebhookItem(item) {
  if (!item) return null;
  return {
    uploadId:
      item.upload_id || item.uploadId || item.metadata?.upload_id || null,
    mobile:
      item.mobile ||
      item.to ||
      item.number ||
      item.phone ||
      item.customerNumber ||
      item.customer_number ||
      item.customerMobile ||
      item.customer_mobile ||
      item.recipient ||
      item.wa_id ||
      null,
    status:
      item.status ||
      item.state ||
      item.delivery_status ||
      item.deliveryStatus ||
      item.message_status ||
      item.messageStatus ||
      item.report_status ||
      item.status_text ||
      null,
    responseId:
      item.response_id ||
      item.responseId ||
      item.message_id ||
      item.messageId ||
      item.message_uuid ||
      item.messageUuid ||
      item.uuid ||
      item.request_id ||
      item.requestId ||
      item.one_api_request_id ||
      item.oneApiRequestId ||
      item["Request ID"] ||
      item["Message ID"] ||
      item.id ||
      null,
    senderNumber:
      item.integratedNumber ||
      item.integrated_number ||
      item.senderNumber ||
      item.sender_number ||
      item.from ||
      item["Integrated Number"] ||
      null,
    templateName:
      item.templateName ||
      item.template_name ||
      item.template ||
      item.campaignName ||
      item.campaign_name ||
      item["Template Name"] ||
      null,
    statusUpdatedAt:
      item.statusUpdatedAt ||
      item.status_updated_at ||
      item.deliveredAt ||
      item.delivered_at ||
      item.readAt ||
      item.read_at ||
      item.updatedAt ||
      item.updated_at ||
      item["Delivered Time"] ||
      item["Sent Time"] ||
      null,
    raw: item,
  };
}

function createStatusLabel(statusText) {
  if (!statusText) return "reporting";
  const normalized = String(statusText).toLowerCase();
  // MSG91 explicit status codes / reason strings
  if (normalized === "deny" || normalized === "denied") return "failed";
  if (normalized === "read") return "delivered";
  if (normalized.includes("deliver")) return "delivered";
  if (
    normalized.includes("fail") ||
    normalized.includes("undel") ||
    normalized.includes("reject")
  )
    return "failed";
  if (normalized.includes("read")) return "delivered";
  if (normalized.includes("sent") || normalized.includes("submit"))
    return "sent";
  return "reporting";
}

function parseMaybeJson(value) {
  if (value === undefined || value === null || value === "") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return value;
    }
  }
  return value;
}

function getPayloadItems(body) {
  const parsedBody = parseMaybeJson(body);
  if (Array.isArray(parsedBody)) return parsedBody;
  const data = parseMaybeJson(parsedBody?.data);
  if (Array.isArray(parsedBody?.reports)) return parsedBody.reports;
  if (Array.isArray(data)) return data;
  if (Array.isArray(parsedBody?.payload)) return parsedBody.payload;
  if (Array.isArray(parsedBody?.entry)) return parsedBody.entry;

  // MSG91 inbound payload has `messages` as a stringified array. Do not split it
  // into separate events here; keep the original wrapper so customerNumber,
  // integratedNumber, button, text, etc. remain available for matching.
  return parsedBody && typeof parsedBody === "object" ? [parsedBody] : [];
}

function toDbValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function inferMsg91EventType(item) {
  const direction = String(item.direction || item.direction_type || "").trim();
  if (direction === "0") return "inbound";
  if (direction === "1") return "outbound";

  const webhookType = String(
    item.webhookType ||
      item.webhook_type ||
      item.eventType ||
      item.event_type ||
      "",
  ).toLowerCase();

  if (webhookType.includes("inbound") || webhookType.includes("incoming"))
    return "inbound";
  if (webhookType.includes("outbound") || webhookType.includes("report"))
    return "outbound";

  const contentType = String(
    item.contentType || item.content_type || "",
  ).toLowerCase();
  const messageType = String(
    item.messageType || item.message_type || "",
  ).toLowerCase();

  if (
    item.replyMsgId ||
    item.reply_msg_id ||
    item.customerName ||
    item.customer_name ||
    item.text ||
    item.button ||
    item.interactive ||
    item.reaction ||
    item.contacts ||
    contentType ||
    [
      "text",
      "button",
      "interactive",
      "reaction",
      "image",
      "document",
      "audio",
      "video",
    ].includes(messageType)
  ) {
    return "inbound";
  }

  return "outbound";
}

function normalizeMsg91WebhookItem(item) {
  const eventType = inferMsg91EventType(item);
  const normalizedMobile = formatPhoneForCall(
    item.customerNumber ||
      item.customer_number ||
      item.mobile ||
      item.to ||
      item.number ||
      item.phone ||
      item.recipient ||
      "",
  );
  const statusSource =
    item.eventName ||
    item.event_name ||
    item.statusCode ||
    item.status_code ||
    item.reason ||
    item.status ||
    item.delivery_status ||
    item.messageType ||
    item.message_type ||
    item.webhookType;
  return {
    eventType,
    uploadId:
      item.upload_id || item.uploadId || item.metadata?.upload_id || null,
    normalizedMobile,
    normalizedStatus:
      eventType === "inbound" ? "inbound" : createStatusLabel(statusSource),
    requestId: getMsg91CorrelationId(item, eventType),
    raw: item,
  };
}

function extractButtonText(button) {
  const parsed = parseMaybeJson(button);
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed;
  return (
    parsed.text ||
    parsed.title ||
    parsed.payload ||
    parsed.button?.text ||
    parsed.button?.payload ||
    ""
  );
}

function extractInteractiveText(interactive) {
  const parsed = parseMaybeJson(interactive);
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed;
  return (
    parsed.button_reply?.title ||
    parsed.button_reply?.id ||
    parsed.list_reply?.title ||
    parsed.list_reply?.id ||
    parsed.nfm_reply?.body ||
    parsed.type ||
    ""
  );
}

function extractMessagesText(messages) {
  const parsed = parseMaybeJson(messages);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return list
    .map((message) => {
      if (!message || typeof message !== "object") return String(message || "");
      return (
        message.text?.body ||
        message.button?.text ||
        message.button?.payload ||
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        message.image?.caption ||
        message.video?.caption ||
        message.document?.caption ||
        message.reaction?.emoji ||
        ""
      );
    })
    .filter(Boolean)
    .join(" | ");
}

function extractMobileFromWebhookMessages(messages) {
  const parsed = parseMaybeJson(messages);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  for (const message of list) {
    const candidate =
      message?.from ||
      message?.customerNumber ||
      message?.mobile ||
      message?.wa_id ||
      message?.contacts?.[0]?.wa_id ||
      "";
    const mobile = formatPhoneForCall(candidate);
    if (mobile) return mobile;
  }
  return "";
}

function extractMessageContextId(messages) {
  const parsed = parseMaybeJson(messages);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  for (const message of list) {
    const contextId = message?.context?.id || message?.reply_context?.id || "";
    if (contextId) return contextId;
  }
  return "";
}

function getMsg91CorrelationId(item, eventType) {
  if (eventType === "inbound") {
    return (
      item.replyMsgId ||
      item.reply_msg_id ||
      extractMessageContextId(item.messages) ||
      item.message_id ||
      item.messageId ||
      item.message_uuid ||
      item.uuid ||
      item.id ||
      item.requestId ||
      item.request_id ||
      item.oneApiRequestId ||
      item.one_api_request_id ||
      null
    );
  }

  return (
    item.uuid ||
    item.message_uuid ||
    item.message_id ||
    item.messageId ||
    item.id ||
    item.requestId ||
    item.request_id ||
    item.oneApiRequestId ||
    item.one_api_request_id ||
    null
  );
}

function extractWebhookMessageText(item) {
  const content = parseMaybeJson(item.content);
  if (content && typeof content === "object") {
    const contentText =
      content.text ||
      content.text?.body ||
      content.button?.text ||
      content.button?.payload ||
      content.interactive?.button_reply?.title ||
      content.interactive?.list_reply?.title ||
      content.caption ||
      "";
    if (contentText) return String(contentText);
  }

  return String(
    item.text ||
      extractButtonText(item.button) ||
      extractInteractiveText(item.interactive) ||
      extractMessagesText(item.messages) ||
      item.caption ||
      item.reaction ||
      item.url ||
      "",
  );
}

function buildStableWebhookKey(item, normalized, text) {
  if (normalized.eventType !== "inbound" || !normalized.requestId) return null;
  return [
    "msg91-stable",
    "inbound",
    normalized.normalizedMobile || "",
    item.integratedNumber || item.integrated_number || "",
    normalized.requestId || "",
    text || "",
  ].join("|");
}

async function findWebhookMatch(normalized, context = {}) {
  const row = await findLatestNumberForWebhook(normalized, context);
  if (!row) return { uploadId: null, numberId: null };
  return { uploadId: row.uploadId, numberId: row.id };
}

async function storeWebhookEvent(item, normalized, match, context = {}) {
  const receivedAt = context.receivedAt || new Date().toISOString();
  if (!item.text && normalized.eventType === "inbound") {
    item.text = extractWebhookMessageText(item);
  }

  const doc = {
    eventType: normalized.eventType,
    normalizedStatus: normalized.normalizedStatus,
    normalizedMobile: normalized.normalizedMobile || null,
    matchedUploadId: match.uploadId,
    matchedNumberId: match.numberId,
    source: context.source || "local",
    sourceEventId: context.sourceEventId || null,
    stableKey: buildStableWebhookKey(item, normalized, item.text || ""),
    rawPayload: item,
    receivedAt,
  };

  WEBHOOK_EVENT_COLUMNS.forEach((column) => {
    doc[column] = item[column] ?? null;
  });

  return upsertWebhookEventDoc(doc);
}

async function updateNumberFromWebhook(item, normalized, match) {
  if (!match.numberId) return;

  const responseId =
    normalized.requestId ||
    item.requestId ||
    item.replyMsgId ||
    item.oneApiRequestId ||
    item.uuid ||
    null;

  if (normalized.eventType === "inbound") {
    const replyText = extractWebhookMessageText(item);
    const existingNumber = await getNumberById(match.numberId, {
      replyHistory: 1,
    });
    const replyAt = new Date().toISOString();
    const replyHistory = appendReplyHistory(existingNumber?.replyHistory, {
      text: replyText,
      receivedAt: replyAt,
      responseId,
      payload: item,
    });

    await updateNumberFields(match.numberId, {
      currentStatus: "replied",
      responseId,
      customReply: replyText,
      replyHistory,
      responseDetails: stringifyResponseDetails(item),
      lastReplyAt: replyAt,
      lastUpdated: replyAt,
    });

    const row = await getNumberWithUploadById(match.numberId);
    if (row) {
      await mirrorSenderReport({
        senderNumber: row.senderId || item.integratedNumber || "",
        teamLabel: getTeamLabelForSender(row.senderId || item.integratedNumber),
        uploadId: row.uploadId,
        numberId: row.id,
        mobile: row.cleaned,
        templateId: row.templateId,
        templateName: item.templateName || row.templateName,
        templateLabel: row.templateLabel,
        sentMessage: row.sentMessage,
        customReply: replyText,
        replyHistory: parseJsonField(replyHistory, []),
        lastReplyAt: replyAt,
        currentStatus: "replied",
        responseId,
        csvRowData: parseRowData(row),
        webhook: item,
      });
    }
    if (match.uploadId) await updateUploadStatus(match.uploadId);
    return;
  }

  const lastUpdated =
    item.statusUpdatedAt || item.requestedAt || new Date().toISOString();
  await updateNumberFields(match.numberId, {
    deliveryStatus: normalized.normalizedStatus,
    currentStatus: normalized.normalizedStatus,
    responseId,
    messageId: responseId,
    responseDetails: stringifyResponseDetails(item),
    lastUpdated,
  });

  const row = await getNumberWithUploadById(match.numberId);
  if (row) {
    await mirrorSenderReport({
      senderNumber: row.senderId || item.integratedNumber || "",
      teamLabel: getTeamLabelForSender(row.senderId || item.integratedNumber),
      uploadId: row.uploadId,
      numberId: row.id,
      mobile: row.cleaned,
      templateId: row.templateId,
      templateName: item.templateName || row.templateName,
      templateLabel: row.templateLabel,
      sentMessage: row.sentMessage,
      currentStatus: normalized.normalizedStatus,
      deliveryStatus: normalized.normalizedStatus,
      responseId,
      messageId: responseId,
      responseDetails: item,
      csvRowData: parseRowData(row),
      webhook: item,
      report: {
        status: normalized.normalizedStatus,
        reason: item.reason || item.cleverTapErrorReason || null,
        price: item.price || null,
      },
    });
  }
  if (match.uploadId) await updateUploadStatus(match.uploadId);
}

function enrichWebhookItem(item, context = {}) {
  if (!item || typeof item !== "object") return item;
  return {
    ...item,
    templateName: item.templateName || context.templateName || null,
    matchedUploadId: item.matchedUploadId || context.uploadId || null,
    uploadId: item.uploadId || item.upload_id || context.uploadId || null,
    webhookType: item.webhookType || context.webhookType || "msg91",
  };
}

async function processWebhookReport(body, context = {}) {
  const payload = getPayloadItems(body);

  for (const rawItem of payload) {
    const item = enrichWebhookItem(rawItem, context);
    const msg91Normalized = normalizeMsg91WebhookItem(item);
    const match = await findWebhookMatch(msg91Normalized, context);
    const finalMatch = {
      uploadId: match.uploadId || item.matchedUploadId || item.uploadId || null,
      numberId: match.numberId || null,
    };
    const storedEvent = await storeWebhookEvent(
      item,
      msg91Normalized,
      finalMatch,
      context,
    );
    if (!storedEvent.changes) continue;

    await updateNumberFromWebhook(item, msg91Normalized, finalMatch);
  }
}

function getRemoteEventPayload(event) {
  const payload = event.rawPayload || event.payload || event.body || event;
  if (payload && typeof payload === "object") {
    return {
      ...payload,
      text: payload.text || event.text || "",
      webhookType: payload.webhookType || event.webhookType || "msg91",
      uploadId: payload.uploadId || event.uploadId || null,
      templateName: payload.templateName || event.templateName || "",
    };
  }
  return payload;
}

async function isRemoteWebhookEventProcessed(sourceEventId) {
  return hasProcessedRemoteEvent(sourceEventId);
}

async function syncMongoWebhookEvents() {
  // The EC2 webhook-server.js writes events to whatsapp_webhook_events and
  // updates whatsapp_sender_reports and whatsapp_numbers directly in MongoDB.
  // Re-processing those events here created duplicate documents and caused
  // every reply/status to appear twice in the UI. The polling loop already
  // calls sendStateUpdate() after this function, which is sufficient to
  // refresh the UI with the latest state from MongoDB.
  if (!mongoDb) return;
}

function toMsg91Date(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime()))
    return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function extractReportItemsFromBody(body) {
  const parsed = parseMaybeJson(body);
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const candidates = [
    parsed.reports,
    parsed.report,
    parsed.logs,
    parsed.items,
    parsed.records,
    parsed.result,
    parsed.response,
    parsed.data,
    parsed.data?.reports,
    parsed.data?.logs,
    parsed.data?.items,
    parsed.data?.records,
    parsed.data?.data,
    parsed.result?.data,
    parsed.result?.logs,
  ].map(parseMaybeJson);
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [parsed];
}

function reportItemMatchesUploadContext(normalized, upload) {
  const uploadSender = formatPhoneForCall(
    upload.senderId || upload.senderNumber || "",
  );
  const itemSender = formatPhoneForCall(normalized.senderNumber || "");
  if (uploadSender && itemSender && uploadSender !== itemSender) return false;

  const uploadTemplate = String(
    upload.templateName || upload.templateLabel || "",
  )
    .trim()
    .toLowerCase();
  const itemTemplate = String(normalized.templateName || "")
    .trim()
    .toLowerCase();
  if (uploadTemplate && itemTemplate && uploadTemplate !== itemTemplate) {
    const uploadTemplateSlug = uploadTemplate
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const itemTemplateSlug = itemTemplate
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (uploadTemplateSlug !== itemTemplateSlug) return false;
  }

  return true;
}

async function applyReportItemsToUpload(
  upload,
  rawItems,
  sourceLabel = "MSG91 report",
) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const uploadRows = await mongoDb
    .collection("whatsapp_numbers")
    .find(
      { uploadId: Number(upload.id) },
      {
        projection: {
          id: 1,
          cleaned: 1,
          original: 1,
          responseId: 1,
          messageId: 1,
        },
      },
    )
    .toArray();
  const mobileCounts = new Map();
  uploadRows.forEach((row) => {
    const mobile = formatPhoneForCall(row.cleaned || row.original || "");
    if (mobile) mobileCounts.set(mobile, (mobileCounts.get(mobile) || 0) + 1);
  });

  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    const normalized = normalizeWebhookItem(item);
    if (!normalized || !reportItemMatchesUploadContext(normalized, upload)) {
      skipped += 1;
      continue;
    }

    const cleaned = formatPhoneForCall(normalized.mobile || "");
    const responseId = normalized.responseId
      ? String(normalized.responseId)
      : "";
    const candidates = uploadRows.filter((row) => {
      if (
        responseId &&
        (String(row.responseId || "") === responseId ||
          String(row.messageId || "") === responseId)
      ) {
        return true;
      }
      if (!responseId && cleaned && mobileCounts.get(cleaned) === 1) {
        return (
          formatPhoneForCall(row.cleaned || row.original || "") === cleaned
        );
      }
      return false;
    });

    if (candidates.length !== 1) {
      skipped += 1;
      console.warn("Skipped ambiguous server report update", {
        source: sourceLabel,
        uploadId: upload.id,
        cleaned,
        responseId,
        matches: candidates.length,
      });
      continue;
    }

    const deliveryStatus = createStatusLabel(normalized.status || item.status);
    const currentStatus =
      deliveryStatus === "delivered"
        ? "delivered"
        : deliveryStatus === "failed"
          ? "failed"
          : deliveryStatus === "sent"
            ? "sent"
            : "reporting";
    await updateNumberFields(candidates[0].id, {
      deliveryStatus,
      currentStatus,
      responseId: responseId || candidates[0].responseId || null,
      messageId: responseId || candidates[0].messageId || null,
      responseDetails: stringifyResponseDetails({ source: sourceLabel, item }),
      lastUpdated: normalized.statusUpdatedAt || new Date().toISOString(),
    });
    await mirrorNumberById(candidates[0].id);
    updated += 1;
  }

  await updateUploadStatus(upload.id);
  return { updated, skipped, total: items.length };
}

async function requestLogsReportForUpload(upload) {
  const startDate = toMsg91Date(
    upload.createdAt || upload.triggeredAt || new Date(),
  );
  const endDate = toMsg91Date(new Date());
  const response = await axios.get(
    "https://control.msg91.com/api/v5/report/logs/wa",
    {
      headers: {
        accept: "application/json",
        authkey: upload.apiKey,
      },
      params: { startDate, endDate },
      timeout: 30000,
    },
  );
  const items = extractReportItemsFromBody(response.data);
  const result = await applyReportItemsToUpload(
    upload,
    items,
    "MSG91 WhatsApp logs",
  );
  await updateUploadFields(upload.id, {
    reportPollFailureCount: 0,
    reportPollNextAt: null,
    reportPollError: null,
  });
  return {
    ...result,
    source: "logs",
    message: `MSG91 logs refreshed. Updated ${result.updated} row(s), skipped ${result.skipped}.`,
  };
}

async function requestReportForUpload(upload, options = {}) {
  const { throwOnError = false } = options;
  if (!upload.apiMessageId || !upload.apiKey) {
    const message =
      "This upload has no MSG91 message id/auth key yet. Send the campaign before refreshing server report data.";
    if (throwOnError) throw new Error(message);
    return { updated: 0, skipped: 0, message };
  }

  try {
    const response = await axios.get(
      "https://api.msg91.com/api/v5/whatsapp/report",
      {
        headers: {
          authkey: upload.apiKey,
          "Content-Type": "application/json",
        },
        params: {
          message_id: upload.apiMessageId,
        },
        timeout: 20000,
      },
    );

    const rawItems = extractReportItemsFromBody(response.data);
    const result = await applyReportItemsToUpload(
      upload,
      rawItems,
      "MSG91 message report",
    );

    await updateUploadFields(upload.id, {
      reportPollFailureCount: 0,
      reportPollNextAt: null,
      reportPollError: null,
    });
    return {
      ...result,
      source: "message-report",
      message: `MSG91 server report refreshed. Updated ${result.updated} row(s), skipped ${result.skipped}.`,
    };
  } catch (error) {
    if (getHttpStatus(error) === 404 && upload.apiKey) {
      try {
        return await requestLogsReportForUpload(upload);
      } catch (logsError) {
        await handleReportPollFailure(upload, logsError);
        if (throwOnError) {
          const message =
            logsError.response?.data?.message ||
            logsError.message ||
            "MSG91 logs refresh failed";
          throw new Error(message);
        }
        return {
          updated: 0,
          skipped: 0,
          error:
            logsError.response?.data?.message ||
            logsError.message ||
            "MSG91 logs refresh failed",
        };
      }
    }
    await handleReportPollFailure(upload, error);
    if (throwOnError) {
      const message =
        error.response?.data?.message ||
        error.message ||
        "MSG91 report refresh failed";
      throw new Error(message);
    }
    return {
      updated: 0,
      skipped: 0,
      error:
        error.response?.data?.message ||
        error.message ||
        "MSG91 report refresh failed",
    };
  }
}

function getHttpStatus(error) {
  return error?.response?.status || error?.status || null;
}

function getReportPollBackoffMs(status, failureCount) {
  if (status === 404) return 10 * 60 * 1000;
  if (status === 401 || status === 403) return 5 * 60 * 1000;
  return Math.min(5 * 60 * 1000, Math.max(10 * 1000, failureCount * 15 * 1000));
}

async function handleReportPollFailure(upload, error) {
  const status = getHttpStatus(error);
  const failureCount = Number(upload.reportPollFailureCount || 0) + 1;
  const retryAt = new Date(
    Date.now() + getReportPollBackoffMs(status, failureCount),
  ).toISOString();
  const message =
    status === 404
      ? "MSG91 report API returned 404. Webhook capture remains active; polling will retry later."
      : error.response?.data?.message || error.message || "Report poll failed";

  await updateUploadFields(upload.id, {
    reportPollFailureCount: failureCount,
    reportPollNextAt: retryAt,
    reportPollError: message,
  });

  if (upload.reportPollError !== message) {
    console.warn(`Report poll paused for upload ${upload.id}: ${message}`);
  }
}

function safeFilePart(value) {
  return (
    String(value || "report")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "report"
  );
}

async function exportUploadReport(uploadId) {
  const upload = await getUploadById(uploadId);
  if (!upload) {
    throw new Error("Upload not found.");
  }

  const rows = await listNumbersByUpload(uploadId);
  const reportRows = rows.map((row, index) => {
    const rowData = parseRowData(row);
    return {
      "#": index + 1,
      "File Name": upload.fileName,
      Template: upload.templateLabel || upload.templateName || "",
      "Sender Number": upload.senderId || "",
      "Original Phone": row.original || "",
      "Validated Phone": row.cleaned || "",
      "Phone Valid": row.valid ? "Yes" : "No",
      "Current Status": row.currentStatus || "",
      "Delivery Status": row.deliveryStatus || "",
      "Sent Message": row.sentMessage || "",
      "Custom Reply": row.customReply || "",
      "Reply History": row.replyHistory || "",
      "Last Reply At": row.lastReplyAt || "",
      "Retry Count": row.retryCount || 0,
      "Response ID": row.responseId || "",
      "Message ID": row.messageId || "",
      "Response Details": row.responseDetails || "",
      "Last Updated": row.lastUpdated || "",
      "MSG91 Response": upload.apiResponse || "",
      ...rowData,
    };
  });

  const workbook = XLSX.utils.book_new();
  const summaryRows = [
    ["Upload ID", upload.id],
    ["File Name", upload.fileName],
    ["Template", upload.templateLabel || upload.templateName || ""],
    ["Sender Number", upload.senderId || ""],
    ["Total Records", upload.totalRecords || rows.length],
    ["Valid", rows.filter((row) => row.valid).length],
    ["Invalid", rows.filter((row) => !row.valid).length],
    ["Status", upload.status || ""],
    ["Exported At", new Date().toISOString()],
  ];
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(summaryRows),
    "Summary",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(reportRows),
    "Delivery Report",
  );

  const exportDir = app.getPath("downloads");
  const filePath = path.join(
    exportDir,
    `msg91-report-${upload.id}-${safeFilePart(upload.fileName)}-${new Date().toISOString().slice(0, 10)}.xlsx`,
  );
  XLSX.writeFile(workbook, filePath);
  return { filePath, rowCount: reportRows.length };
}

function sendStateUpdate(payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send("state-updated", payload);
  }
}

async function startPolling() {
  if (reportPollingTimer) return;
  reportPollingTimer = setInterval(async () => {
    if (reportPollInProgress) return;
    if (!db || isDbClosing) return;
    reportPollInProgress = true;
    try {
      if (getReportPollingEnabled()) {
        const pendingUploads = await listPendingReportUploads(
          new Date().toISOString(),
        );
        for (const upload of pendingUploads) {
          await requestReportForUpload(upload);
        }
      }
      await syncMongoWebhookEvents();
      sendStateUpdate();
    } catch (error) {
      console.warn("Report refresh failed:", error.message || error);
    } finally {
      reportPollInProgress = false;
    }
  }, reportRefreshIntervalMs);
}

function startWebhookServer() {
  if (webhookServer) return Promise.resolve(webhookServer);
  ipcMain.handle("clear-app-cache", async () => {
    const windows = BrowserWindow.getAllWindows();

    for (const win of windows) {
      await win.webContents.session.clearCache();
      await win.webContents.session.clearStorageData({
        storages: ["localstorage", "indexdb", "serviceworkers", "cachestorage"],
      });
    }

    return { success: true };
  });

  const server = express();
  server.use(express.json());
  const handleWebhook = async (req, res, context = {}) => {
    try {
      await processWebhookReport(req.body, context);
      // Pass uploadId so the renderer only refreshes the affected section.
      sendStateUpdate({ uploadId: context.uploadId || null });
      res.json({ received: true });
    } catch (error) {
      console.error("Webhook processing error", error);
      res.status(500).json({ error: error.message || "failed" });
    }
  };

  server.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: "whatsapp-bulk-sender",
      webhookUrl: `http://127.0.0.1:${webhookPort}/webhook`,
    });
  });

  // EC2 webhook-server.js can POST here after it writes a new event to MongoDB
  // so the Electron UI refreshes immediately without waiting for the poll tick.
  server.post("/notify", (req, res) => {
    sendStateUpdate(req.body || {});
    res.json({ ok: true });
  });
  server.post("/webhook", (req, res) => handleWebhook(req, res));
  server.post("/webhook/msg91/:templateName/:uploadId", (req, res) =>
    handleWebhook(req, res, {
      templateName: req.params.templateName,
      uploadId: Number(req.params.uploadId) || null,
      webhookType: "outbound_report",
    }),
  );
  server.post("/webhook/msg91/:templateName", (req, res) =>
    handleWebhook(req, res, {
      templateName: req.params.templateName,
      webhookType: "outbound_report",
    }),
  );
  return new Promise((resolve, reject) => {
    webhookServer = server
      .listen(webhookPort, "127.0.0.1", () => {
        console.log(
          `Webhook endpoint listening on http://127.0.0.1:${webhookPort}/webhook`,
        );
        resolve(webhookServer);
      })
      .on("error", (error) => {
        webhookServer = null;
        if (error.code === "EADDRINUSE") {
          reject(
            new Error(
              `Port ${webhookPort} is already in use. Close the other local server or change webhookPort in main.js.`,
            ),
          );
          return;
        }
        reject(error);
      });
  });
}

async function getSenderReportMapForUpload(uploadId) {
  await requireMongoDb();
  const uploadNumberRows = await mongoDb
    .collection("whatsapp_numbers")
    .find(
      { uploadId: Number(uploadId) },
      { projection: { id: 1, numberId: 1, cleaned: 1, original: 1 } },
    )
    .toArray();
  const mobileCounts = new Map();
  uploadNumberRows.forEach((row) => {
    const mobile = formatPhoneForCall(row.cleaned || row.original || "");
    if (mobile) mobileCounts.set(mobile, (mobileCounts.get(mobile) || 0) + 1);
  });

  const senderReports = await mongoDb
    .collection("whatsapp_sender_reports")
    .find({ uploadId: Number(uploadId) })
    .sort({ updatedAt: -1, sentAt: -1, _id: -1 })
    .toArray();

  const byNumberId = new Map();
  const byMobile = new Map();

  senderReports.forEach((report) => {
    const numberKey = Number(report.numberId || report.id || 0);
    const mobileKey = formatPhoneForCall(
      report.mobile || report.cleaned || report.customerNumber || "",
    );

    if (numberKey && !byNumberId.has(numberKey))
      byNumberId.set(numberKey, report);
    if (
      mobileKey &&
      mobileCounts.get(mobileKey) === 1 &&
      !byMobile.has(mobileKey)
    )
      byMobile.set(mobileKey, report);
  });

  return { byNumberId, byMobile };
}

async function getInboundReplyMapForUpload(uploadId) {
  await requireMongoDb();
  const uploadNumberRows = await mongoDb
    .collection("whatsapp_numbers")
    .find(
      { uploadId: Number(uploadId) },
      { projection: { id: 1, numberId: 1, cleaned: 1, original: 1 } },
    )
    .toArray();

  const mobileCounts = new Map();
  uploadNumberRows.forEach((row) => {
    const mobile = formatPhoneForCall(row.cleaned || row.original || "");
    if (mobile) mobileCounts.set(mobile, (mobileCounts.get(mobile) || 0) + 1);
  });
  const mobiles = [...mobileCounts.keys()];
  if (!mobiles.length) return { byNumberId: new Map(), byMobile: new Map() };
  const mobileRegexConditions = mobiles.flatMap((mobile) => {
    const local = mobile.startsWith("91") ? mobile.slice(2) : mobile;
    return [
      { messages: { $regex: mobile } },
      { "rawPayload.messages": { $regex: mobile } },
      ...(local && local !== mobile
        ? [
            { messages: { $regex: local } },
            { "rawPayload.messages": { $regex: local } },
          ]
        : []),
    ];
  });

  const events = await mongoDb
    .collection("whatsapp_webhook_events")
    .find({
      eventType: "inbound",
      $or: [
        { matchedUploadId: Number(uploadId) },
        { uploadId: Number(uploadId) },
        { normalizedMobile: { $in: mobiles } },
        { customerNumber: { $in: mobiles } },
        { mobile: { $in: mobiles } },
        { "rawPayload.customerNumber": { $in: mobiles } },
        { "rawPayload.mobile": { $in: mobiles } },
        ...mobileRegexConditions,
      ],
    })
    .sort({ receivedAt: -1, updatedAt: -1, _id: -1 })
    .limit(2000)
    .toArray();

  const byNumberId = new Map();
  const byMobile = new Map();
  events.forEach((event) => {
    const mobile = formatPhoneForCall(
      event.normalizedMobile ||
        event.customerNumber ||
        event.mobile ||
        event.rawPayload?.customerNumber ||
        event.rawPayload?.mobile ||
        extractMobileFromWebhookMessages(
          event.rawPayload?.messages || event.messages,
        ) ||
        "",
    );
    const numberKey = Number(
      event.matchedNumberId || event.numberId || event.messageNumberId || 0,
    );
    const text =
      event.text ||
      event.customReply ||
      event.button?.text ||
      event.button?.payload ||
      event.rawPayload?.text ||
      extractButtonText(event.rawPayload?.button) ||
      extractMessagesText(event.rawPayload?.messages) ||
      event.interactive?.button_reply?.title ||
      event.interactive?.list_reply?.title ||
      "";
    const mappedEvent = { ...event, text };
    if (numberKey && !byNumberId.has(numberKey))
      byNumberId.set(numberKey, mappedEvent);
    if (mobile && mobileCounts.get(mobile) === 1 && !byMobile.has(mobile))
      byMobile.set(mobile, mappedEvent);
  });
  return { byNumberId, byMobile };
}

function mergeReportReplyFields(numberRow, senderReport, inboundEvent) {
  const existingHistory = parseJsonField(numberRow.replyHistory, []);
  const senderHistory = parseJsonField(senderReport?.replyHistory, []);
  const inboundText = inboundEvent?.text || "";
  const inboundTime =
    inboundEvent?.receivedAt ||
    inboundEvent?.statusUpdatedAt ||
    inboundEvent?.updatedAt ||
    null;
  const customReply =
    numberRow.customReply || senderReport?.customReply || inboundText || "";
  const replyHistory = Array.isArray(existingHistory)
    ? [...existingHistory]
    : [];
  if (Array.isArray(senderHistory)) {
    senderHistory.forEach((item) => replyHistory.push(item));
  }
  if (
    inboundText &&
    !replyHistory.some(
      (item) => String(item?.text || "") === String(inboundText),
    )
  ) {
    replyHistory.push({
      text: inboundText,
      receivedAt: inboundTime || new Date().toISOString(),
      customerNumber:
        inboundEvent.normalizedMobile ||
        inboundEvent.customerNumber ||
        numberRow.cleaned,
      rawPayload: inboundEvent.rawPayload || inboundEvent,
    });
  }
  const numberUpdatedAt =
    new Date(
      numberRow.lastUpdated || numberRow.updatedAt || numberRow.sentAt || 0,
    ).getTime() || 0;
  const senderUpdatedAt =
    new Date(
      senderReport?.updatedAt ||
        senderReport?.lastUpdated ||
        senderReport?.sentAt ||
        0,
    ).getTime() || 0;
  const statusSource =
    senderReport && senderUpdatedAt >= numberUpdatedAt
      ? senderReport
      : numberRow;

  return {
    customReply,
    replyHistory: replyHistory.slice(-50),
    lastReplyAt:
      numberRow.lastReplyAt || senderReport?.lastReplyAt || inboundTime || "",
    currentStatus: customReply
      ? "replied"
      : statusSource.currentStatus || numberRow.currentStatus,
    deliveryStatus: statusSource.deliveryStatus || numberRow.deliveryStatus,
    responseId: statusSource.responseId || numberRow.responseId,
    messageId: statusSource.messageId || numberRow.messageId,
    responseDetails:
      statusSource.responseDetails ||
      parseJsonField(numberRow.responseDetails, null),
    sentMessage: statusSource.sentMessage || numberRow.sentMessage || "",
    senderReport: senderReport || null,
    inboundReply: inboundEvent || null,
  };
}

ipcMain.handle("parse-csv-file", async (event, filePath) => {
  const parsedRows = await parseSpreadsheetFile(filePath);
  const result = await storeUpload(
    filePath,
    path.basename(filePath),
    parsedRows,
  );
  return result;
});

ipcMain.handle("fetch-uploads", async () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const uploads = await listUploadsWithCountsForDateRange(
    start.toISOString(),
    end.toISOString(),
  );
  return uploads;
});

ipcMain.handle("fetch-report", async (event, uploadId) => {
  // Read only. Do not sync webhook events here; this handler is called by UI refresh.
  // Delivery + custom reply are merged from whatsapp_numbers, whatsapp_sender_reports,
  // and whatsapp_webhook_events so delayed replies appear in the Delivery Report.
  if (!uploadId) return [];

  const rows = await listNumbersByUpload(uploadId, { desc: true });
  const senderReportMap = await getSenderReportMapForUpload(uploadId);
  const inboundReplyMap = await getInboundReplyMapForUpload(uploadId);

  return rows.map((row) => {
    const numberId = Number(row.numberId || row.id || 0);
    const mobile = formatPhoneForCall(row.cleaned || row.original || "");
    const senderReport =
      senderReportMap.byNumberId.get(numberId) ||
      senderReportMap.byMobile.get(mobile) ||
      null;
    const inboundEvent =
      inboundReplyMap.byNumberId.get(numberId) ||
      inboundReplyMap.byMobile.get(mobile) ||
      null;
    const mergedReply = mergeReportReplyFields(row, senderReport, inboundEvent);

    return {
      ...row,
      id: row.id || row.numberId,
      numberId: row.numberId || row.id,
      cleaned: mobile || row.cleaned,
      data: parseJsonField(row.data, {}),
      responseDetails: mergedReply.responseDetails,
      replyHistory: mergedReply.replyHistory,
      customReply: mergedReply.customReply,
      lastReplyAt: mergedReply.lastReplyAt,
      currentStatus: mergedReply.currentStatus,
      deliveryStatus: mergedReply.deliveryStatus,
      responseId: mergedReply.responseId,
      messageId: mergedReply.messageId,
      sentMessage: mergedReply.sentMessage,
      senderReport: mergedReply.senderReport,
      inboundReply: mergedReply.inboundReply,
    };
  });
});

ipcMain.handle("refresh-upload-report", async (event, uploadId) => {
  if (!uploadId) {
    throw new Error("Select an upload before refreshing server report data.");
  }
  await requireMongoDb();
  const upload = await mongoDb
    .collection("whatsapp_uploads")
    .findOne({ id: Number(uploadId) });
  if (!upload) {
    throw new Error(`Upload ${uploadId} was not found in MongoDB.`);
  }

  const result = await requestReportForUpload(normalizeMongoDoc(upload), {
    throwOnError: false,
  });
  await syncMongoWebhookEvents();
  sendStateUpdate({ uploadId: Number(uploadId), refreshedFromServer: true });
  return result;
});

ipcMain.handle("fetch-custom-report", async (event, filters = {}) => {
  // Read only. This is called every 10 seconds by the renderer.
  // Never call syncMongoWebhookEvents() here, otherwise the refresh can write duplicate rows.
  return getCustomReportRows(filters);
});

ipcMain.handle("fetch-sender-stats", async (event, filters = {}) => {
  await requireMongoDb();
  const senderReports = mongoDb.collection("whatsapp_sender_reports");

  const match = {};
  if (filters.todayOnly) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    match.sentAt = { $gte: start.toISOString(), $lt: end.toISOString() };
  } else if (filters.startDateTime || filters.endDateTime) {
    match.sentAt = {};
    if (filters.startDateTime)
      match.sentAt.$gte = new Date(filters.startDateTime).toISOString();
    if (filters.endDateTime)
      match.sentAt.$lt = new Date(filters.endDateTime).toISOString();
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: null,
        totalSends: { $sum: 1 },
        templates: { $addToSet: "$templateName" },
        responses: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $ne: ["$customReply", null] },
                  { $ne: ["$lastReplyAt", null] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ];

  const agg = await senderReports.aggregate(pipeline).toArray();
  const row = agg[0] || { totalSends: 0, templates: [], responses: 0 };
  return {
    totalSends: row.totalSends || 0,
    templatesTriggered: Array.isArray(row.templates)
      ? row.templates.filter(Boolean).length
      : 0,
    responsesReceived: row.responses || 0,
  };
});

ipcMain.handle("export-custom-report", async (event, filters = {}) => {
  // Read/export only. Do not sync webhook events from an export request.
  return exportCustomReport(filters);
});

ipcMain.handle("schedule-set", async (event, cfg = {}) => {
  // validate cfg minimally
  scheduleConfig = {
    enabled: Boolean(cfg.enabled),
    time: cfg.time || "10:00",
    mechanism: cfg.mechanism || "email",
  };
  saveScheduleConfig(scheduleConfig);
  scheduleNextRun(scheduleConfig);
  return scheduleConfig;
});

ipcMain.handle("schedule-get", async () => {
  if (!scheduleConfig) scheduleConfig = loadScheduleConfig();
  return scheduleConfig || { enabled: true, time: "10:00", mechanism: "email" };
});

ipcMain.handle("schedule-run-now", async () => {
  try {
    const cfg = scheduleConfig ||
      loadScheduleConfig() || {
        enabled: true,
        time: "10:00",
        mechanism: "email",
      };
    if (cfg && cfg.mechanism === "email") {
      console.log(
        "Manual trigger for schedule-run-now starting (Email flow with 24-hour RM/Admin split)...",
      );
      const [hh, mm] = (cfg.time || "10:00").split(":").map((v) => Number(v));
      const end = new Date();
      end.setHours(hh, mm, 0, 0);
      const start = new Date(end);
      start.setDate(start.getDate() - 1);

      const filters = {
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
      };

      const fullDayResult = await exportCustomReport(filters);
      await sendAdminReportEmailDirect(
        fullDayResult.filePath,
        start.toISOString(),
        end.toISOString(),
      );
      const rmResult = await sendRmGroupedReportsDirect(filters);
      return { success: true, adminReport: fullDayResult, rmReport: rmResult };
    } else {
      const res = await exportCustomReport({});
      if (cfg && cfg.mechanism === "sftp")
        await deliverFileBySftp(res.filePath);
      return res;
    }
  } catch (err) {
    throw err;
  }
});

ipcMain.handle("send-admin-report-email", async (event, filters = {}) => {
  console.log("IPC send-admin-report-email triggered with filters:", filters);
  const rows = await getCustomReportRows(filters);
  if (!rows.length) {
    throw new Error("No transactions found for the selected filter range.");
  }
  const prefix = "admin-custom-report";
  const { filePath } = generateExcelFromRows(rows, prefix, !filters.uploadId); // all-upload admin reports use multi-tab workbook

  const start = filters.startDateTime || null;
  const end = filters.endDateTime || null;
  return sendAdminReportEmailDirect(filePath, start, end);
});

ipcMain.handle("send-rm-reports", async (event, filters = {}) => {
  console.log("IPC send-rm-reports triggered with filters:", filters);
  return sendRmGroupedReportsDirect(filters);
});

function normalizeReportStatus(row) {
  const status = String(
    row.deliveryStatus || row.currentStatus || "",
  ).toLowerCase();
  if (status.includes("delivered") || status.includes("read"))
    return "delivered";
  if (
    status.includes("failed") ||
    status.includes("undelivered") ||
    status === "invalid"
  )
    return "failed";
  if (status.includes("sent") || status.includes("submitted")) return "sent";
  if (status.includes("reporting") || status.includes("pending"))
    return "reporting";
  return status || "reporting";
}

function reportRowMatchesSearch(row, search) {
  const needle = String(search || "")
    .trim()
    .toLowerCase();
  if (!needle) return true;
  const haystack = [
    row.normalizedMobile,
    row.customerNumber,
    row.requestId,
    row.templateName,
    row.uploadTemplateLabel,
    row.uploadFileName,
    row.sentMessage,
    row.text,
    row.customReply,
    row.reason,
    JSON.stringify(row.csvRowData || {}),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function reportRowMatchesDateRange(row, filters = {}) {
  if (!filters.startDateTime && !filters.endDateTime) return true;
  const value =
    row.receivedAt ||
    row.statusUpdatedAt ||
    row.requestedAt ||
    row.updatedAt ||
    "";
  const time = new Date(value).getTime();
  if (!time || Number.isNaN(time)) return false;
  if (filters.startDateTime) {
    const start = new Date(filters.startDateTime).getTime();
    if (!Number.isNaN(start) && time < start) return false;
  }
  if (filters.endDateTime) {
    const end = new Date(filters.endDateTime).getTime();
    if (!Number.isNaN(end) && time >= end) return false;
  }
  return true;
}

function getReplyTextFromHistory(replyHistory) {
  const history = Array.isArray(replyHistory) ? replyHistory : [];
  const latest = [...history]
    .filter((item) => item && (item.text || item.customReply))
    .sort(
      (a, b) =>
        new Date(b.receivedAt || b.updatedAt || 0).getTime() -
        new Date(a.receivedAt || a.updatedAt || 0).getTime(),
    )[0];
  return latest?.text || latest?.customReply || "";
}

function normalizeReplyHistoryItems(
  replyHistory,
  fallbackText = "",
  fallbackTime = "",
  fallbackPayload = null,
) {
  const seen = new Set();
  const items = [];
  const history = Array.isArray(replyHistory) ? replyHistory : [];

  history.forEach((reply) => {
    if (!reply) return;
    const text = String(reply.text || reply.customReply || "").trim();
    if (!text) return;
    const receivedAt =
      reply.receivedAt ||
      reply.lastReplyAt ||
      reply.updatedAt ||
      fallbackTime ||
      "";
    const key = `${receivedAt}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      text,
      receivedAt,
      rawPayload: reply.rawPayload || reply.payload || reply,
    });
  });

  const directText = String(fallbackText || "").trim();
  if (directText) {
    const key = `${fallbackTime || ""}|${directText}`;
    if (!seen.has(key)) {
      items.push({
        text: directText,
        receivedAt: fallbackTime || "",
        rawPayload: fallbackPayload || {},
      });
    }
  }

  return items.sort(
    (a, b) =>
      new Date(b.receivedAt || 0).getTime() -
      new Date(a.receivedAt || 0).getTime(),
  );
}

async function listSelectedUploadReportRows(filters = {}) {
  const uploadId = Number(filters.uploadId || 0);
  if (!uploadId) return [];

  const upload = await getUploadById(uploadId);
  if (!upload) return [];

  const rows = await listNumbersByUpload(uploadId, { desc: true });
  const senderReportMap = await getSenderReportMapForUpload(uploadId);
  const inboundReplyMap = await getInboundReplyMapForUpload(uploadId);

  const mappedRows = [];

  rows.forEach((row) => {
    const numberId = Number(row.numberId || row.id || 0);
    const mobile = formatPhoneForCall(row.cleaned || row.original || "");
    const senderReport =
      senderReportMap.byNumberId.get(numberId) ||
      senderReportMap.byMobile.get(mobile) ||
      null;
    const inboundEvent =
      inboundReplyMap.byNumberId.get(numberId) ||
      inboundReplyMap.byMobile.get(mobile) ||
      null;
    const mergedReply = mergeReportReplyFields(row, senderReport, inboundEvent);
    const latestReplyText =
      mergedReply.customReply ||
      getReplyTextFromHistory(mergedReply.replyHistory);
    const outboundPayload =
      mergedReply.responseDetails || senderReport?.responseDetails || {};
    const baseRow = {
      id: `upload-${uploadId}-${numberId || row.id}`,
      eventType: "outbound",
      normalizedStatus: normalizeReportStatus(mergedReply),
      normalizedMobile: mobile || row.cleaned || row.original || "",
      customerNumber: mobile || row.cleaned || row.original || "",
      customerName: "",
      integratedNumber:
        upload.senderId ||
        upload.senderNumber ||
        senderReport?.senderNumber ||
        "",
      integrated_number:
        upload.senderId ||
        upload.senderNumber ||
        senderReport?.senderNumber ||
        "",
      templateName: upload.templateName || senderReport?.templateName || "",
      campaignName: "",
      receivedAt:
        mergedReply.senderReport?.sentAt ||
        upload.sentAt ||
        row.lastUpdated ||
        upload.createdAt ||
        "",
      requestedAt:
        mergedReply.senderReport?.sentAt ||
        upload.sentAt ||
        upload.createdAt ||
        "",
      statusUpdatedAt: row.lastUpdated || row.updatedAt || "",
      requestId: mergedReply.responseId || mergedReply.messageId || "",
      matchedUploadId: uploadId,
      matchedNumberId: numberId || null,
      uploadFileName: upload.fileName || "",
      uploadTemplateLabel: upload.templateLabel || upload.templateName || "",
      numberCurrentStatus: mergedReply.currentStatus || row.currentStatus || "",
      numberDeliveryStatus:
        mergedReply.deliveryStatus || row.deliveryStatus || "",
      numberRetryCount: row.retryCount || 0,
      sentMessage: mergedReply.sentMessage || row.sentMessage || "",
      text: mergedReply.sentMessage || row.sentMessage || "",
      customReply: latestReplyText,
      lastReplyAt: mergedReply.lastReplyAt || "",
      csvRowData: parseRowData(row),
      rawPayload: outboundPayload,
      reason: row.validationError || senderReport?.reason || "",
      updatedAt: row.updatedAt || row.lastUpdated || "",
    };

    mappedRows.push(baseRow);

    const replyItems = normalizeReplyHistoryItems(
      mergedReply.replyHistory,
      latestReplyText,
      mergedReply.lastReplyAt,
      inboundEvent?.rawPayload || inboundEvent || null,
    );

    replyItems.forEach((reply, replyIndex) => {
      mappedRows.push({
        ...baseRow,
        id: `upload-${uploadId}-${numberId || row.id}-reply-${replyIndex + 1}`,
        eventType: "inbound",
        normalizedStatus: "inbound",
        receivedAt:
          reply.receivedAt || baseRow.lastReplyAt || baseRow.receivedAt,
        requestedAt:
          reply.receivedAt || baseRow.lastReplyAt || baseRow.requestedAt,
        statusUpdatedAt: reply.receivedAt || baseRow.statusUpdatedAt,
        text: reply.text,
        customReply: reply.text,
        lastReplyAt: reply.receivedAt || baseRow.lastReplyAt,
        rawPayload: reply.rawPayload || {},
        reason: "",
      });
    });
  });

  return mappedRows
    .filter((row) => {
      if (filters.filteredNumberId && filters.filteredNumberId !== "all") {
        const selectedSender = normalizeSenderFilterValue(
          filters.filteredNumberId,
        );
        const rowSender = normalizeSenderFilterValue(
          row.integratedNumber || row.integrated_number || "",
        );
        if (selectedSender && rowSender && selectedSender !== rowSender)
          return false;
      }

      if (filters.templateName && filters.templateName !== "all") {
        const candidates = getTemplateFilterCandidates(filters.templateName);
        const rowTemplates = getTemplateFilterCandidates(
          row.templateName || row.uploadTemplateLabel || "",
        );
        if (!rowTemplates.some((value) => candidates.includes(value)))
          return false;
      }

      if (
        filters.eventType &&
        filters.eventType !== "all" &&
        row.eventType !== filters.eventType
      ) {
        return false;
      }

      if (filters.status && filters.status !== "all") {
        if (filters.status === "inbound") {
          if (row.eventType !== "inbound") return false;
        } else if (
          row.normalizedStatus !== filters.status &&
          row.numberDeliveryStatus !== filters.status &&
          row.numberCurrentStatus !== filters.status
        ) {
          return false;
        }
      }

      return (
        reportRowMatchesSearch(row, filters.search) &&
        reportRowMatchesDateRange(row, filters)
      );
    })
    .sort((a, b) => {
      const aTime = new Date(
        a.receivedAt || a.statusUpdatedAt || a.requestedAt || 0,
      ).getTime();
      const bTime = new Date(
        b.receivedAt || b.statusUpdatedAt || b.requestedAt || 0,
      ).getTime();
      return bTime - aTime;
    });
}

async function getCustomReportRows(filters = {}) {
  const rows = filters.uploadId
    ? await listSelectedUploadReportRows(filters)
    : await listCustomReportRowsFromMongo(filters);
  return rows.map((row) => ({
    ...row,
    rawPayload: parseJsonField(row.rawPayload, {}),
    csvRowData: parseJsonField(row.csvRowData, {}),
  }));
}

function getSafeSheetName(label) {
  if (!label) return "Sheet";
  // Replace invalid Excel sheet name characters: \ / ? * : [ ]
  let clean = label.replace(/[\\\/?:*\[\]]/g, "_");
  // Excel sheet name max length is 31
  if (clean.length > 31) {
    clean = clean.slice(0, 31);
  }
  return clean.trim() || "Sheet";
}

function formatSingleRowForExcel(row, index) {
  return {
    "#": index + 1,
    Received: row.receivedAt || row.statusUpdatedAt || row.requestedAt || "",
    Type: row.eventType || "",
    Status: row.normalizedStatus || "",
    "Message Status": row.numberCurrentStatus || "",
    "Delivery Status": row.numberDeliveryStatus || "",
    Sender: row.integratedNumber || row.integrated_number || "",
    Mobile: row.normalizedMobile || row.customerNumber || "",
    Customer: row.customerName || "",
    Upload: row.uploadFileName || "",
    "Request ID":
      row.requestId || row.oneApiRequestId || row.replyMsgId || row.uuid || "",
    "Template Name": row.templateName || row.uploadTemplateLabel || "",
    Campaign: row.campaignName || "",
    Message:
      row.text ||
      extractWebhookMessageText(row.rawPayload || row) ||
      row.content ||
      row.caption ||
      row.button ||
      row.messages ||
      "",
    "Sent Message": row.sentMessage || "",
    "Custom Reply": row.customReply || "",
    "Last Reply At": row.lastReplyAt || "",
    "Dynamic Response": JSON.stringify(row.rawPayload || {}),
    Reason: row.reason || row.cleverTapErrorReason || "",
    Price: row.price || "",
    "CSV Row": JSON.stringify(row.csvRowData || {}),
    "Raw Payload": JSON.stringify(row.rawPayload || {}),
  };
}

function generateExcelFromRows(rows, filenamePrefix, isMultiSheet = false) {
  const workbook = XLSX.utils.book_new();

  if (isMultiSheet) {
    const config = loadMsg91Config();
    const rms = config.integratedNumbers || [];
    const matchedRowIds = new Set();

    // 1. Group rows by configured RMs/Team Numbers and append separate sheets
    rms.forEach((rm) => {
      const rmNumber = String(rm.number).trim();
      if (!rmNumber) return;

      const rmRows = rows.filter((row) => {
        const rowSender = String(
          row.integratedNumber || row.integrated_number || "",
        ).trim();
        const matches =
          rowSender === rmNumber || rowSender === `client-${rmNumber}`;
        if (matches) {
          matchedRowIds.add(row.id || row._id || rowSender);
        }
        return matches;
      });

      if (rmRows.length > 0) {
        const formattedRows = rmRows.map((r, index) =>
          formatSingleRowForExcel(r, index),
        );
        const worksheet = XLSX.utils.json_to_sheet(formattedRows);
        XLSX.utils.book_append_sheet(
          workbook,
          worksheet,
          getSafeSheetName(rm.label),
        );
      }
    });

    // 2. Collate any unmatched transactions and append to an "Other Event Logs" sheet
    const unmatchedRows = rows.filter((row) => {
      return !matchedRowIds.has(
        row.id ||
          row._id ||
          String(row.integratedNumber || row.integrated_number || ""),
      );
    });

    if (unmatchedRows.length > 0) {
      const formattedRows = unmatchedRows.map((r, index) =>
        formatSingleRowForExcel(r, index),
      );
      const worksheet = XLSX.utils.json_to_sheet(formattedRows);
      XLSX.utils.book_append_sheet(workbook, worksheet, "Other Event Logs");
    }

    // Fallback sheet if absolutely nothing was matched or appended
    if (workbook.SheetNames.length === 0) {
      const formattedRows = rows.map((r, index) =>
        formatSingleRowForExcel(r, index),
      );
      const worksheet = XLSX.utils.json_to_sheet(formattedRows);
      XLSX.utils.book_append_sheet(workbook, worksheet, "Webhook Report");
    }
  } else {
    // Single sheet export for isolated RM reports
    const formattedRows = rows.map((r, index) =>
      formatSingleRowForExcel(r, index),
    );
    const worksheet = XLSX.utils.json_to_sheet(formattedRows);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Webhook Report");
  }

  const filePath = path.join(
    app.getPath("downloads"),
    `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.xlsx`,
  );
  XLSX.writeFile(workbook, filePath);
  return { filePath, rowCount: rows.length };
}

async function exportCustomReport(filters = {}) {
  const rows = await getCustomReportRows(filters);
  if (!rows.length) {
    throw new Error("No webhook report rows to export.");
  }
  return generateExcelFromRows(rows, "msg91-webhook-report", !filters.uploadId); // selected upload uses a direct single-sheet report
}

ipcMain.handle("get-msg91-config", async () => {
  return getPublicMsg91Config();
});

/* ipcMain.handle("send-messages", async (event, options) => {
  const {
    uploadId,
    templateId,
    integratedNumberId,
    columnMapping = {},
  } = options;

  const upload = await getUploadById(uploadId);

  const allRows = await listNumbersByUpload(uploadId);

  console.log("TOTAL ROWS:", allRows.length);

  allRows.forEach((r) => {
    console.log({
      mobile: r.mobile,
      cleaned: r.cleaned,
      isValid: r.isValid,
      validationError: r.validationError,
    });
  });

  console.log("VALID ROWS:", validRows.length);

  const validRows = await listNumbersByUpload(uploadId, {
    validOnly: true,
  });

  if (!upload) {
    throw new Error("Upload not found.");
  }
  const config = await getRuntimeMsg91Config();
  const senderNumber = findIntegratedNumberInConfig(config, integratedNumberId);
  const template = findTemplateForSender(senderNumber, templateId);

  if (!config.authKey || !senderNumber?.number) {
    throw new Error(
      "MSG91 auth key and sender number must be configured and selected.",
    );
  }

  if (!template) {
    throw new Error("Select a configured MSG91 template before sending.");
  }

  const webhookBaseUrl = assertPublicWebhookConfigured();

  const validRows = await listNumbersByUpload(uploadId, { validOnly: true });
  console.warn(
    `No valid numbers found for upload ${uploadId}. Marking as failed.`,
  );
  console.log("Updating upload status to 'failed' due to no valid numbers.");
  if (!validRows.length) {
    throw new Error("No valid numbers found in this upload.");
  }

  const webhookUrl = `${webhookBaseUrl}/webhook/msg91/${encodeURIComponent(template.name)}/${uploadId}`;
  const templateNamespace = getTemplateNamespace(
    template,
    senderNumber,
    config,
  );
  const payload = {
    integrated_number: senderNumber.number,
    content_type: "template",
    callback_url: webhookUrl,
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: template.name,
        language: {
          code: template.language || "en",
          policy: template.languagePolicy || "deterministic",
        },
        to_and_components: validRows.map((row) => ({
          to: [row.cleaned],
          components: buildTemplateComponents(
            parseRowData(row),
            template,
            columnMapping,
          ),
        })),
      },
    },
    metadata: {
      upload_id: uploadId,
      template_id: template.id || template.name,
      integrated_number: senderNumber.number,
    },
  };

  if (templateNamespace) {
    payload.payload.template.namespace = templateNamespace;
  }

  const response = await axios.post(
    "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
    payload,
    {
      headers: {
        authkey: config.authKey,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    },
  );
  const responseData = response.data || {};
  const apiMessageId = getApiMessageId(responseData);
  const responseItems = getBulkResponseItems(responseData);

  for (const row of validRows) {
    const rowData = parseRowData(row);
    const responseItem =
      responseItems.find((item) => {
        const itemNumber = formatPhoneForCall(
          item?.mobile || item?.to || item?.number || "",
        );
        return itemNumber && itemNumber === row.cleaned;
      }) || {};
    const rowMessageId = getApiMessageId(responseItem) || apiMessageId;
    const sentMessage = buildReadableMessage(rowData, template, columnMapping);
    const responseDetails =
      responseItem && Object.keys(responseItem).length
        ? responseItem
        : responseData;
    await updateNumberFields(row.id, {
      currentStatus: "sent",
      deliveryStatus: "sent",
      responseId: rowMessageId,
      messageId: rowMessageId,
      sentMessage,
      responseDetails: stringifyResponseDetails(responseDetails),
      lastUpdated: new Date().toISOString(),
    });
    await mirrorNumberById(row.id);
    await mirrorSenderReport({
      senderNumber: senderNumber.number,
      teamLabel: senderNumber.label || senderNumber.number,
      uploadId,
      numberId: row.id,
      mobile: row.cleaned,
      templateId: template.id || template.name,
      templateName: template.name,
      templateLabel: template.label || template.name,
      sentMessage,
      sentAt: new Date().toISOString(),
      currentStatus: "sent",
      deliveryStatus: "sent",
      responseId: rowMessageId,
      messageId: rowMessageId,
      responseDetails,
      csvRowData: rowData,
      report: {
        apiResponse: responseDetails,
      },
    });
  }

  await updateUploadFields(uploadId, {
    apiMessageId,
    apiResponse: JSON.stringify(responseData),
    apiKey: config.authKey,
    senderId: senderNumber.number,
    status: "sent",
    templateId: template.id || template.name,
    templateName: template.name,
    templateLabel: template.label || template.name,
    templateMapping: JSON.stringify(columnMapping || {}),
    reportPollFailureCount: 0,
    reportPollNextAt: null,
    reportPollError: null,
  });
  await mirrorMongo("whatsapp_uploads", (collection) =>
    collection.updateOne(
      { uploadId },
      {
        $set: {
          apiMessageId,
          apiResponse: responseData,
          senderId: senderNumber.number,
          status: "sent",
          templateId: template.id || template.name,
          templateName: template.name,
          templateLabel: template.label || template.name,
          templateMapping: columnMapping || {},
          reportPollFailureCount: 0,
          reportPollNextAt: null,
          reportPollError: null,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: false },
    ),
  );

  await updateUploadStatus(uploadId);
  sendStateUpdate();
  return {
    message: `${validRows.length} message(s) sent to MSG91.`,
    apiMessageId,
    responseData,
  };
}); */
ipcMain.handle("send-messages", async (event, options) => {
  const {
    uploadId,
    templateId,
    integratedNumberId,
    columnMapping = {},
  } = options;

  const upload = await getUploadById(uploadId);

  if (!upload) {
    throw new Error("Upload not found.");
  }

  const allRows = await listNumbersByUpload(uploadId);

  console.log("TOTAL ROWS:", allRows.length);

  allRows.forEach((r) => {
    console.log({
      id: r.id,
      mobile: r.mobile || r.original,
      cleaned: r.cleaned,
      isValid: r.isValid ?? r.valid,
      validationError: r.validationError,
    });
  });

  const validRows = allRows.filter((row) => {
    const isValid =
      row.valid === 1 ||
      row.valid === true ||
      row.isValid === 1 ||
      row.isValid === true ||
      row.currentStatus === "pending" ||
      row.deliveryStatus === "pending";

    return isValid && row.cleaned;
  });

  console.log("VALID ROWS:", validRows.length);

  if (!validRows.length) {
    console.warn(`No valid numbers found for upload ${uploadId}.`);
    await updateUploadFields(uploadId, {
      status: "failed",
      reportPollError: "No valid numbers found in this upload.",
    });
    sendStateUpdate();
    throw new Error("No valid numbers found in this upload.");
  }

  const config = await getRuntimeMsg91Config();
  const senderNumber = findIntegratedNumberInConfig(config, integratedNumberId);
  const template = findTemplateForSender(senderNumber, templateId);

  if (!config.authKey || !senderNumber?.number) {
    throw new Error(
      "MSG91 auth key and sender number must be configured and selected.",
    );
  }

  if (!template) {
    throw new Error("Select a configured MSG91 template before sending.");
  }

  const webhookBaseUrl = assertPublicWebhookConfigured();

  const webhookUrl = `${webhookBaseUrl}/webhook/msg91/${encodeURIComponent(template.name)}/${uploadId}`;

  const templateNamespace = getTemplateNamespace(
    template,
    senderNumber,
    config,
  );

  const payload = {
    integrated_number: senderNumber.number,
    content_type: "template",
    callback_url: webhookUrl,
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: template.name,
        language: {
          code: template.language || "en",
          policy: template.languagePolicy || "deterministic",
        },
        to_and_components: validRows.map((row) => ({
          to: [row.cleaned],
          components: buildTemplateComponents(
            parseRowData(row),
            template,
            columnMapping,
          ),
        })),
      },
    },
    metadata: {
      upload_id: uploadId,
      template_id: template.id || template.name,
      integrated_number: senderNumber.number,
    },
  };

  if (templateNamespace) {
    payload.payload.template.namespace = templateNamespace;
  }

  const response = await axios.post(
    "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
    payload,
    {
      headers: {
        authkey: config.authKey,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    },
  );

  const responseData = response.data || {};
  const apiMessageId = getApiMessageId(responseData);
  const responseItems = getBulkResponseItems(responseData);

  // Use index-based matching: MSG91 returns result items in the same order as
  // to_and_components. Phone-number matching is wrong when the same number
  // appears multiple times (e.g. one customer placed several orders in one
  // upload) because Array.find always returns the first hit, giving every row
  // the same wamid and making reply matching impossible.
  for (let rowIndex = 0; rowIndex < validRows.length; rowIndex++) {
    const row = validRows[rowIndex];
    const rowData = parseRowData(row);
    const responseItem = responseItems[rowIndex] || {};
    const rowMessageId = getApiMessageId(responseItem) || apiMessageId || null;

    const sentMessage = buildReadableMessage(rowData, template, columnMapping);

    const responseDetails =
      responseItem && Object.keys(responseItem).length
        ? responseItem
        : responseData;

    await updateNumberFields(row.id, {
      currentStatus: "sent",
      deliveryStatus: "sent",
      responseId: rowMessageId,
      messageId: rowMessageId,
      sentMessage,
      responseDetails: stringifyResponseDetails(responseDetails),
      lastUpdated: new Date().toISOString(),
    });

    await mirrorSenderReport({
      senderNumber: senderNumber.number,
      teamLabel: senderNumber.label || senderNumber.number,
      uploadId,
      numberId: row.id,
      mobile: row.cleaned,
      templateId: template.id || template.name,
      templateName: template.name,
      templateLabel: template.label || template.name,
      sentMessage,
      sentAt: new Date().toISOString(),
      currentStatus: "sent",
      deliveryStatus: "sent",
      responseId: rowMessageId,
      messageId: rowMessageId,
      responseDetails,
      csvRowData: rowData,
      report: {
        apiResponse: responseDetails,
      },
    });
  }

  await updateUploadFields(uploadId, {
    apiMessageId,
    apiResponse: JSON.stringify(responseData),
    apiKey: config.authKey,
    senderId: senderNumber.number,
    status: "sent",
    templateId: template.id || template.name,
    templateName: template.name,
    templateLabel: template.label || template.name,
    templateMapping: JSON.stringify(columnMapping || {}),
    reportPollFailureCount: 0,
    reportPollNextAt: null,
    reportPollError: null,
  });

  await mirrorMongo("whatsapp_uploads", (collection) =>
    collection.updateOne(
      { uploadId },
      {
        $set: {
          apiMessageId,
          apiResponse: responseData,
          senderId: senderNumber.number,
          status: "sent",
          templateId: template.id || template.name,
          templateName: template.name,
          templateLabel: template.label || template.name,
          templateMapping: columnMapping || {},
          reportPollFailureCount: 0,
          reportPollNextAt: null,
          reportPollError: null,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: false },
    ),
  );

  await updateUploadStatus(uploadId);
  sendStateUpdate();

  return {
    message: `${validRows.length} message(s) sent to MSG91.`,
    apiMessageId,
    responseData,
  };
});
ipcMain.handle("retry-failed", async (event, uploadId) => {
  const upload = await getUploadById(uploadId);
  if (!upload) {
    throw new Error("Upload not found.");
  }
  const config = await getRuntimeMsg91Config();
  const senderNumber = findIntegratedNumberInConfig(
    config,
    upload.senderId || config.integratedNumber,
  );

  const template = findTemplateForSender(
    senderNumber,
    upload.templateId || upload.templateName,
  );
  if (!config.authKey || !senderNumber?.number || !template) {
    throw new Error(
      "Cannot retry until MSG91 auth, integrated number, and the original template are configured.",
    );
  }
  const webhookBaseUrl = assertPublicWebhookConfigured();
  const failedRows = await listNumbersByUpload(uploadId, {
    deliveryStatus: "failed",
    projection: { id: 1, cleaned: 1, data: 1, retryCount: 1 },
  });
  if (!failedRows.length) {
    return { message: "No failed numbers to retry." };
  }
  const webhookUrl = `${webhookBaseUrl}/webhook/msg91/${encodeURIComponent(template.name)}/${uploadId}`;
  const columnMapping = upload.templateMapping
    ? JSON.parse(upload.templateMapping)
    : {};
  const templateNamespace = getTemplateNamespace(
    template,
    senderNumber,
    config,
  );
  const payload = {
    integrated_number: senderNumber.number,
    content_type: "template",
    callback_url: webhookUrl,
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: template.name,
        language: {
          code: template.language || "en",
          policy: template.languagePolicy || "deterministic",
        },
        to_and_components: failedRows.map((row) => ({
          to: [row.cleaned],
          components: buildTemplateComponents(
            parseRowData(row),
            template,
            columnMapping,
          ),
        })),
      },
    },
    metadata: {
      upload_id: uploadId,
      retry: true,
      template_id: template.id || template.name,
      integrated_number: senderNumber.number,
    },
  };

  if (templateNamespace) {
    payload.payload.template.namespace = templateNamespace;
  }

  const response = await axios.post(
    "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
    payload,
    {
      headers: {
        authkey: config.authKey,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    },
  );
  const responseData = response.data || {};
  const apiMessageId = getApiMessageId(responseData) || upload.apiMessageId;
  const responseItems = getBulkResponseItems(responseData);
  for (let rowIndex = 0; rowIndex < failedRows.length; rowIndex++) {
    const row = failedRows[rowIndex];
    const rowData = parseRowData(row);
    // Index-based: same fix as send-messages so retried rows each get their own wamid.
    const responseItem = responseItems[rowIndex] || {};
    const rowMessageId = getApiMessageId(responseItem) || apiMessageId;
    const responseDetails =
      responseItem && Object.keys(responseItem).length
        ? responseItem
        : responseData;
    const sentMessage = buildReadableMessage(rowData, template, columnMapping);
    await updateNumberFieldsWithInc(
      row.id,
      {
        currentStatus: "retrying",
        deliveryStatus: "sent",
        responseId: rowMessageId,
        messageId: rowMessageId,
        sentMessage,
        responseDetails: stringifyResponseDetails(responseDetails),
        lastUpdated: new Date().toISOString(),
      },
      { retryCount: 1 },
    );
    await mirrorSenderReport({
      senderNumber: senderNumber.number,
      teamLabel: senderNumber.label || senderNumber.number,
      uploadId,
      numberId: row.id,
      mobile: row.cleaned,
      templateId: template.id || template.name,
      templateName: template.name,
      templateLabel: template.label || template.name,
      sentMessage,
      currentStatus: "retrying",
      deliveryStatus: "sent",
      responseId: rowMessageId,
      messageId: rowMessageId,
      responseDetails,
      csvRowData: rowData,
      report: { retry: true, apiResponse: responseData },
    });
  }
  await updateUploadFields(uploadId, {
    apiMessageId,
    apiResponse: JSON.stringify(responseData),
    status: "sent",
    reportPollFailureCount: 0,
    reportPollNextAt: null,
    reportPollError: null,
  });
  await mirrorMongo("whatsapp_uploads", (collection) =>
    collection.updateOne(
      { uploadId },
      {
        $set: {
          apiMessageId,
          apiResponse: responseData,
          status: "sent",
          reportPollFailureCount: 0,
          reportPollNextAt: null,
          reportPollError: null,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: false },
    ),
  );
  await updateUploadStatus(uploadId);
  sendStateUpdate();
  return { message: "Retry request sent.", apiMessageId, responseData };
});

ipcMain.handle("get-webhook-url", async () => {
  return `${getWebhookBaseUrl()}/webhook`;
});

ipcMain.handle("export-upload-report", async (event, uploadId) => {
  return exportUploadReport(Number(uploadId));
});
ipcMain.on("capture-full-page", async (event, winId) => {
  const win = BrowserWindow.fromId(winId);

  // 1. Get the real width and scroll height of the inner webpage
  const metrics = await win.webContents.executeJavaScript(`(() => {
        return {
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight
        };
    })()`);

  // 2. Cache original window bounds to restore them later
  const originalBounds = win.getBounds();

  // 3. Resize window to fit the entire scrollable canvas
  win.setBounds({
    x: originalBounds.x,
    y: originalBounds.y,
    width: metrics.width,
    height: metrics.height,
  });

  // Small delay to ensure layouts re-render correctly
  setTimeout(async () => {
    // 4. Capture the full un-cropped page
    const image = await win.webContents.capturePage();

    // 5. Save the file to user's desktop
    const savePath = path.join(app.getPath("desktop"), "full-screenshot.png");
    fs.writeFileSync(savePath, image.toPNG());

    // 6. Restore the window back to its original user size
    win.setBounds(originalBounds);

    event.reply("capture-success", savePath);
  }, 500);
});
app.on("second-instance", () => {
  showMainWindow();
});

app.whenReady().then(async () => {
  try {
    enableRunAtLogin();
    await initDb();
    await initMongo();
    await startWebhookServer();
    createTray();
    createWindow();
    startPolling();
    // load schedule config and schedule export if enabled
    try {
      scheduleConfig = loadScheduleConfig();
      if (!scheduleConfig) {
        // Automatically default to 10:00 AM daily emailing when the app is first installed!
        scheduleConfig = {
          enabled: true,
          time: "10:00",
          mechanism: "email",
        };
        saveScheduleConfig(scheduleConfig);
        console.log(
          "Initialized default 10:00 AM daily email schedule on first-time launch.",
        );
      }
      if (scheduleConfig && scheduleConfig.enabled)
        scheduleNextRun(scheduleConfig);
    } catch (err) {
      console.warn("Failed to initialize schedule:", err.message);
    }
  } catch (error) {
    console.error("Application startup failed:", error);
    dialog.showErrorBox(
      "WhatsApp Bulk Sender startup failed",
      error.message || "The local server could not be started.",
    );
    createWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents.send("state-updated");
    });
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  isDbClosing = true;
  if (reportPollingTimer) {
    clearInterval(reportPollingTimer);
    reportPollingTimer = null;
  }
  if (webhookServer) {
    webhookServer.close();
    webhookServer = null;
  }
  if (db) {
    db.close((error) => {
      if (error) console.warn("Database close failed:", error.message || error);
    });
    db = null;
  }
  if (mongoClient) {
    mongoClient.close().catch(() => {});
    mongoClient = null;
    mongoDb = null;
  }
});

app.on("window-all-closed", () => {
  // Keep the local webhook server running in the tray after the UI is closed.
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
