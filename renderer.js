const chooseFileButton = document.getElementById("chooseFileButton");
const csvInput = document.getElementById("csvInput");
const currentUploadLabel = document.getElementById("currentUploadLabel");
const webhookInfo = document.getElementById("webhookInfo");
const uploadTableBody = document.getElementById("uploadTableBody");
const previewSummary = document.getElementById("previewSummary");
const validationPanel = document.getElementById("validationPanel");
const validationTotalCount = document.getElementById("validationTotalCount");
const validationValidCount = document.getElementById("validationValidCount");
const validationInvalidCount = document.getElementById(
  "validationInvalidCount",
);
const validationLists = document.getElementById("validationLists");
const invalidNumberTableBody = document.getElementById(
  "invalidNumberTableBody",
);
const previewPhoneSearch = document.getElementById("previewPhoneSearch");
const numberSplitPanel = document.getElementById("numberSplitPanel");
const indianSplitCount = document.getElementById("indianSplitCount");
const foreignSplitCount = document.getElementById("foreignSplitCount");
const exportIndianCsvButton = document.getElementById("exportIndianCsvButton");
const exportForeignCsvButton = document.getElementById(
  "exportForeignCsvButton",
);
const previewTableBody = document.getElementById("previewTableBody");
const reportTableBody = document.getElementById("reportTableBody");
const uploadPhoneSearch = document.getElementById("uploadPhoneSearch");
const deliveryPhoneSearch = document.getElementById("deliveryPhoneSearch");
const configStatus = document.getElementById("configStatus");
const numberSelect = document.getElementById("numberSelect");
const templateSelect = document.getElementById("templateSelect");
const templateDescription = document.getElementById("templateDescription");
const mappingSummary = document.getElementById("mappingSummary");
const mappingTableBody = document.getElementById("mappingTableBody");
const deliveryReplySummary = document.getElementById("deliveryReplySummary");
const deliveryContextSummary = document.getElementById(
  "deliveryContextSummary",
);
const customScope = document.getElementById("customScope");
const customNumberFilter = document.getElementById("customNumberFilter");
const customTemplateFilter = document.getElementById("customTemplateFilter");
const customStartDateTime = document.getElementById("customStartDateTime");
const customEndDateTime = document.getElementById("customEndDateTime");
const customRangePreset = document.getElementById("customRangePreset");
const customDateTimeDisplay = document.getElementById("customDateTimeDisplay");
const customDateTimeOpen = document.getElementById("customDateTimeOpen");
const customStartDateInput = document.getElementById("customStartDateInput");
const customStartTimeInput = document.getElementById("customStartTimeInput");
const customEndDateInput = document.getElementById("customEndDateInput");
const customEndTimeInput = document.getElementById("customEndTimeInput");
const customDateTimeOk = document.getElementById("customDateTimeOk");
const customDateTimeCancel = document.getElementById("customDateTimeCancel");
const dateTimePickerBackdrop = document.getElementById(
  "dateTimePickerBackdrop",
);
const dateTimePickerClose = document.getElementById("dateTimePickerClose");
const customEventType = document.getElementById("customEventType");
const customStatus = document.getElementById("customStatus");
const customSearch = document.getElementById("customSearch");
const customReportRefresh = document.getElementById("customReportRefresh");
const customReportExport = document.getElementById("customReportExport");
const customReportEmailAdmin = document.getElementById(
  "customReportEmailAdmin",
);
const customReportEmailRMs = document.getElementById("customReportEmailRMs");
const customReportSchedule = document.getElementById("customReportSchedule");
const schedulePanel = document.getElementById("schedulePanel");
const scheduleEnabled = document.getElementById("scheduleEnabled");
const deliveryReportExport = document.getElementById("deliveryReportExport");
const deliveryReportEmailAdmin = document.getElementById("deliveryReportEmailAdmin");
const deliveryReportEmailRMs = document.getElementById("deliveryReportEmailRMs");
const scheduleTime = document.getElementById("scheduleTime");
const scheduleMechanism = document.getElementById("scheduleMechanism");
const scheduleSave = document.getElementById("scheduleSave");
const scheduleRunNow = document.getElementById("scheduleRunNow");
const scheduleClose = document.getElementById("scheduleClose");
const customReportSummary = document.getElementById("customReportSummary");
const customReportSummaryGrid = document.getElementById(
  "customReportSummaryGrid",
);
const customReportTableBody = document.getElementById("customReportTableBody");
const sendButton = document.getElementById("sendButton");
const refreshButton = document.getElementById("refreshButton");
const deliveryReportRefreshButton = document.getElementById(
  "deliveryReportRefreshButton",
);

const saasAlertContainer = document.getElementById("saasAlertContainer");
if (!saasAlertContainer) {
  throw new Error("Alert container element is missing from the page.");
}

let selectedUploadId = null;
let lastPreviewRows = [];
let lastCustomReportRows = [];
let lastReportRows = [];
let lastInboundRows = [];
let lastUploads = [];
let msg91Config = { integratedNumbers: [], templates: [] };
let csvHeaders = [];
let selectedUploadValidation = { total: 0, valid: 0, invalid: 0 };
let refreshInProgress = false;
let customReportRefreshInProgress = false;
let customFiltersTouched = false;
const mediaComponentTypes = new Set([
  "image",
  "video",
  "document",
  "audio",
  "media",
]);

const JSON_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="1.2" fill="transparent"/><path d="M9 8s1-1 2 0-1 2-1 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 16s-1 1-2 0 1-2 1-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function getStatusClass(status) {
  if (!status) return "status-new";
  if (status === "new") return "status-new";
  if (status === "sent") return "status-sent";
  if (status === "reporting") return "status-reporting";
  if (status === "completed") return "status-completed";
  if (status === "partial") return "status-partial";
  return "status-new";
}

chooseFileButton.addEventListener("click", () => {
  csvInput.click();
});

csvInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || !file.path) return;
  try {
    // Clear stale Electron session cache so the new upload is always read fresh.
    await window.electronAPI.clearAppCache().catch(() => {});

    const result = await window.electronAPI.parseCsvFile(file.path);
    selectedUploadId = result.upload.id;
    customFiltersTouched = false;
    currentUploadLabel.textContent = `Selected: ${result.upload.fileName}`;

    // Reset stale preview/report state before re-rendering.
    lastPreviewRows = [];
    lastReportRows = [];
    lastInboundRows = [];
    previewTableBody.innerHTML = "";
    reportTableBody.innerHTML = "";

    displayPreview(result.rows);

    // Wait for any in-progress auto-refresh to finish, then reload.
    const waitForIdle = () =>
      new Promise((resolve) => {
        if (!refreshInProgress) {
          resolve();
          return;
        }
        const t = setInterval(() => {
          if (!refreshInProgress) {
            clearInterval(t);
            resolve();
          }
        }, 100);
      });
    await waitForIdle();
    await refreshUploads();
  } catch (err) {
    showAlert(`Unable to import file: ${err.message}`, "error");
  }
  // Reset the file input so the same file can be re-selected if needed.
  csvInput.value = "";
});

if (exportIndianCsvButton) {
  exportIndianCsvButton.addEventListener("click", () =>
    exportSplitCsv("india"),
  );
}

if (exportForeignCsvButton) {
  exportForeignCsvButton.addEventListener("click", () =>
    exportSplitCsv("foreign"),
  );
}

if (previewPhoneSearch) {
  previewPhoneSearch.addEventListener("input", () =>
    displayPreview(lastPreviewRows),
  );
}

if (uploadPhoneSearch) {
  uploadPhoneSearch.addEventListener("input", () =>
    renderUploadTable(lastUploads),
  );
}

if (deliveryPhoneSearch) {
  deliveryPhoneSearch.addEventListener("input", () =>
    renderDeliveryRows(lastReportRows),
  );
}

sendButton.addEventListener("click", async () => {
  if (!selectedUploadId) {
    showAlert("Select a CSV upload first.", "warning");
    return;
  }

  if (!selectedUploadValidation.valid) {
    showAlert(
      "No valid numbers found. Upload a file with valid WhatsApp numbers before sending.",
      "warning",
    );
    return;
  }

  const integratedNumberId = numberSelect.value;
  if (!integratedNumberId) {
    showAlert("Select a MSG91 sender number first.", "warning");
    return;
  }

  const templateId = templateSelect.value;
  if (!templateId) {
    showAlert("Select a template first.", "warning");
    return;
  }

  const columnMapping = getColumnMapping();

  try {
    sendButton.disabled = true;
    sendButton.textContent = "Sending...";
    const result = await window.electronAPI.sendMessages({
      uploadId: selectedUploadId,
      integratedNumberId,
      templateId,
      columnMapping,
    });
    customFiltersTouched = false;
    showAlert(formatMsg91SendAlert(result), "success");
    await refreshUploads();
  } catch (err) {
    showAlert(`Send failed: ${err.message}`, "error");
  } finally {
    updateSendButtonState();
    sendButton.textContent = "Send Selected Template";
  }
});

refreshButton.addEventListener("click", async () => {
  if (refreshInProgress) {
    showAlert("Refresh already in progress, please wait.", "info", 2000);
    return;
  }
  try {
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing...";
    refreshInProgress = true;
    let serverResult = null;
    if (selectedUploadId) {
      serverResult =
        await window.electronAPI.refreshUploadReport(selectedUploadId);
    }
    await refreshUploads();
    showAlert(
      serverResult?.message || "Dashboard refreshed from MongoDB.",
      "success",
    );
  } catch (err) {
    showAlert(`Refresh failed: ${err.message}`, "error");
  } finally {
    refreshInProgress = false;
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh Dashboard";
  }
});
let deliveryReportRefreshInProgress = false;
deliveryReportRefreshButton.addEventListener("click", async () => {
  if (deliveryReportRefreshInProgress) {
    showAlert(
      "Delivery report refresh already in progress, please wait.",
      "info",
      2000,
    );
    return;
  }
  if (!selectedUploadId) {
    showAlert(
      "Select an upload first to refresh its delivery report.",
      "warning",
    );
    return;
  }
  const icon = document.getElementById("deliveryReportRefreshIcon");
  const label = document.getElementById("deliveryReportRefreshLabel");
  try {
    deliveryReportRefreshInProgress = true;
    deliveryReportRefreshButton.disabled = true;
    if (label) label.textContent = "Refreshing...";
    if (icon) icon.style.animation = "spin 0.8s linear infinite";
    const serverResult =
      await window.electronAPI.refreshUploadReport(selectedUploadId);
    await refreshReport(selectedUploadId);
    const updatedCount = Number(serverResult?.updated || 0);
    const alertType =
      updatedCount > 0 || serverResult?.source ? "success" : "info";
    showAlert(
      serverResult?.message || "Delivery report refreshed from MongoDB.",
      alertType,
      3000,
    );
  } catch (err) {
    showAlert(`Delivery report refresh failed: ${err.message}`, "error");
  } finally {
    deliveryReportRefreshInProgress = false;
    deliveryReportRefreshButton.disabled = false;
    if (label) label.textContent = "Refresh Report";
    if (icon) icon.style.animation = "";
  }
});

if (deliveryReportExport)
  deliveryReportExport.addEventListener("click", async () => {
    if (!selectedUploadId) {
      showAlert("Select an upload first before exporting the delivery report.", "warning");
      return;
    }
    try {
      deliveryReportExport.disabled = true;
      deliveryReportExport.textContent = "Exporting...";
      const result = await window.electronAPI.exportUploadReport(selectedUploadId);
      showAlert(
        `Delivery report PDF exported with ${result.rowCount} rows:\n${result.filePath}`,
        "success",
      );
    } catch (err) {
      showAlert(`Export failed: ${err.message}`, "error");
    } finally {
      deliveryReportExport.disabled = false;
      deliveryReportExport.textContent = "Export PDF";
    }
  });

if (deliveryReportEmailAdmin)
  deliveryReportEmailAdmin.addEventListener("click", async () => {
    if (!selectedUploadId) {
      showAlert("Select an upload first before sending the admin report.", "warning");
      return;
    }
    const dateDisplay = deliveryContextSummary?.textContent || "selected upload";
    if (
      !confirm(
        `Send Admin Report email for ${dateDisplay}?\n\nThis will email the selected upload delivery report as PDF to configured admin recipients.\n\nClick OK to send.`,
      )
    )
      return;
    try {
      deliveryReportEmailAdmin.disabled = true;
      deliveryReportEmailAdmin.textContent = "Emailing...";
      await window.electronAPI.sendAdminReportEmail({ uploadId: selectedUploadId });
      showAlert(
        "Admin report email sent successfully for the selected upload.",
        "success",
      );
    } catch (err) {
      showAlert(`Admin email failed: ${err.message}`, "error");
    } finally {
      deliveryReportEmailAdmin.disabled = false;
      deliveryReportEmailAdmin.textContent = "Email Admin Report";
    }
  });

if (deliveryReportEmailRMs)
  deliveryReportEmailRMs.addEventListener("click", async () => {
    if (!selectedUploadId) {
      showAlert("Select an upload first before sending RM reports.", "warning");
      return;
    }
    const dateDisplay = deliveryContextSummary?.textContent || "selected upload";
    if (
      !confirm(
        `Send RM Reports email for ${dateDisplay}?\n\nThis will email PDF reports to configured RM recipients for the selected upload.\n\nClick OK to send.`,
      )
    )
      return;
    try {
      deliveryReportEmailRMs.disabled = true;
      deliveryReportEmailRMs.textContent = "Emailing...";
      const stats = await window.electronAPI.sendRmReports({ uploadId: selectedUploadId });
      showAlert(
        `RM report emails sent successfully to ${stats.sent || 0} recipient(s).`,
        "success",
      );
    } catch (err) {
      showAlert(`RM email failed: ${err.message}`, "error");
    } finally {
      deliveryReportEmailRMs.disabled = false;
      deliveryReportEmailRMs.textContent = "Email RM Reports";
    }
  });

numberSelect.addEventListener("change", () => {
  customFiltersTouched = false;
  renderTemplateOptions();
  renderMappingTable();
  syncCustomReportFiltersToCampaign(true);
  if (isWebhookDebugVisible()) refreshCustomReport();
});
templateSelect.addEventListener("change", () => {
  customFiltersTouched = false;
  renderMappingTable();
  syncCustomReportFiltersToCampaign(true);
  if (isWebhookDebugVisible()) refreshCustomReport();
});
mappingTableBody.addEventListener("change", (event) => {
  if (event.target.matches("select[data-component-key]")) {
    const previewData = parseStoredRowData(lastPreviewRows[0]);
    const row = event.target.closest("tr");
    if (row) {
      row.children[3].textContent = event.target.value
        ? previewData[event.target.value] || "-"
        : "-";
    }
  }
  if (event.target.matches("input[data-file-key]")) {
    const file = event.target.files?.[0];
    const row = event.target.closest("tr");
    const staticInput = row?.querySelector("input[data-static-key]");
    if (file && staticInput) {
      staticInput.value = file.path || file.name || "";
      row.children[3].textContent = staticInput.value || "-";
    }
  }
});
mappingTableBody.addEventListener("input", (event) => {
  if (event.target.matches("input[data-static-key]")) {
    const row = event.target.closest("tr");
    if (row) row.children[3].textContent = event.target.value || "-";
  }
});
customReportRefresh.addEventListener("click", async () => {
  if (customReportRefreshInProgress) {
    showAlert("Report refresh already in progress.", "info", 2000);
    return;
  }
  try {
    customReportRefresh.disabled = true;
    customReportRefresh.textContent = "Refreshing...";
    await refreshCustomReport();
    showAlert("Webhook report refreshed.", "success");
  } catch (err) {
    showAlert(`Refresh report failed: ${err.message}`, "error");
  } finally {
    customReportRefresh.disabled = false;
    customReportRefresh.textContent = "Refresh Report";
  }
});
customReportExport.addEventListener("click", exportCustomReportPdf);

if (customReportEmailAdmin)
  customReportEmailAdmin.addEventListener("click", async () => {
    const dateDisplay = customDateTimeDisplay?.value || "current filter range";
    if (
      !confirm(
        `Send Admin Report email?\n\nThis will email the report for: ${dateDisplay}\n\nRecipients: software@ipkwealth.com / prabhukumarasamy@ipkwealth.com\n\nClick OK to send.`,
      )
    )
      return;
    try {
      customReportEmailAdmin.disabled = true;
      customReportEmailAdmin.textContent = "Emailing...";
      const filters = getCustomReportFilters();
      await window.electronAPI.sendAdminReportEmail(filters);
      showAlert(
        "Admin PDF report successfully generated and sent to software@ipkwealth.com/prabhukumarasamy@ipkwealth.com!",
        "success",
      );
    } catch (err) {
      showAlert(`Admin email report failed: ${err.message}`, "error");
    } finally {
      customReportEmailAdmin.disabled = false;
      customReportEmailAdmin.textContent = "Email Admin Report";
    }
  });

if (customReportEmailRMs)
  customReportEmailRMs.addEventListener("click", async () => {
    const dateDisplay = customDateTimeDisplay?.value || "current filter range";
    if (
      !confirm(
        `Send RM Reports email?\n\nThis will email individual reports to each RM for: ${dateDisplay}\n\nClick OK to send to all configured RM email addresses.`,
      )
    )
      return;
    try {
      customReportEmailRMs.disabled = true;
      customReportEmailRMs.textContent = "Emailing...";
      const filters = getCustomReportFilters();
      const stats = await window.electronAPI.sendRmReports(filters);
      showAlert(
        `Grouped RM PDF reports generated successfully. Sent to ${stats.sent} RM email address(es)!`,
        "success",
      );
    } catch (err) {
      showAlert(`RM grouped email reports failed: ${err.message}`, "error");
    } finally {
      customReportEmailRMs.disabled = false;
      customReportEmailRMs.textContent = "Email RM Reports";
    }
  });
// Schedule panel handlers
if (customReportSchedule && schedulePanel) {
  customReportSchedule.addEventListener("click", () => {
    schedulePanel.setAttribute("aria-hidden", "false");
  });
}

if (scheduleClose)
  scheduleClose.addEventListener("click", () =>
    schedulePanel.setAttribute("aria-hidden", "true"),
  );

if (scheduleSave) {
  scheduleSave.addEventListener("click", async () => {
    const cfg = {
      enabled: Boolean(scheduleEnabled.checked),
      time: scheduleTime.value || "10:00",
      mechanism: scheduleMechanism.value || "email",
    };
    try {
      await window.electronAPI.scheduleSet(cfg);
      schedulePanel.setAttribute("aria-hidden", "true");
      showAlert("Schedule saved.", "success");
    } catch (err) {
      showAlert(`Unable to save schedule: ${err.message}`, "error");
    }
  });
}

if (scheduleRunNow)
  scheduleRunNow.addEventListener("click", async () => {
    if (
      !confirm(
        "Run the scheduled report now?\n\nThis will send Admin Report and RM Reports emails immediately (24-hour window ending now).\n\nClick OK to send.",
      )
    )
      return;
    try {
      scheduleRunNow.disabled = true;
      scheduleRunNow.textContent = "Running...";
      await window.electronAPI.scheduleRunNow();
      showAlert("Scheduled report sent successfully.", "success");
    } catch (err) {
      showAlert(`Scheduled report failed: ${err.message}`, "error");
    } finally {
      scheduleRunNow.disabled = false;
      scheduleRunNow.textContent = "Run Now";
    }
  });

// initialize schedule config on load (from main process)
window.electronAPI.scheduleGet().then((cfg) => {
  if (!cfg) return;
  scheduleEnabled.checked = Boolean(cfg.enabled);
  scheduleTime.value = cfg.time || "10:00";
  scheduleMechanism.value = cfg.mechanism || "email";
});
customScope.addEventListener("change", () => {
  customFiltersTouched = true;
  refreshCustomReport();
});
customNumberFilter.addEventListener("change", () => {
  customFiltersTouched = true;
  renderCustomTemplateOptions();
  refreshCustomReport();
});
customTemplateFilter.addEventListener("change", () => {
  customFiltersTouched = true;
  refreshCustomReport();
});
if (customRangePreset) {
  customRangePreset.addEventListener("change", () => {
    customFiltersTouched = true;
    applyReportRangePreset(customRangePreset.value, true);
  });
}
customDateTimeOpen.addEventListener("click", openDateTimePicker);
customDateTimeDisplay.addEventListener("click", openDateTimePicker);
customDateTimeOk.addEventListener("click", () => {
  const startDateValue = customStartDateInput.value;
  const startTimeValue = customStartTimeInput.value;
  const endDateValue = customEndDateInput.value;
  const endTimeValue = customEndTimeInput.value;

  if (!startDateValue || !startTimeValue || !endDateValue || !endTimeValue) {
    showAlert("Please select both start and end date/time.", "warning");
    return;
  }

  const start = new Date(`${startDateValue}T${startTimeValue}`);
  const end = new Date(`${endDateValue}T${endTimeValue}`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    showAlert("Please enter a valid date and time range.", "warning");
    return;
  }
  if (end < start) {
    showAlert("End date/time must be after start date/time.", "warning");
    return;
  }

  customStartDateTime.value = getLocalDatetimeForInput(start);
  customEndDateTime.value = getLocalDatetimeForInput(end);
  if (customRangePreset) customRangePreset.value = "custom";
  customFiltersTouched = true;
  updateDateRangeDisplay();
  closeDateTimePicker();
  refreshCustomReport();
});
customDateTimeCancel.addEventListener("click", () => {
  closeDateTimePicker();
});
dateTimePickerClose.addEventListener("click", () => {
  closeDateTimePicker();
});
dateTimePickerBackdrop.addEventListener("click", (event) => {
  if (event.target === dateTimePickerBackdrop) {
    closeDateTimePicker();
  }
});
customEventType.addEventListener("change", () => {
  customFiltersTouched = true;
  if (customEventType.value === "inbound") {
    customStatus.value = "inbound";
  }
  refreshCustomReport();
});
customStatus.addEventListener("change", () => {
  customFiltersTouched = true;
  if (customStatus.value === "inbound") {
    customEventType.value = "inbound";
  } else if (customEventType.value === "inbound") {
    customEventType.value = "all";
  }
  refreshCustomReport();
});
customSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    customFiltersTouched = true;
    refreshCustomReport();
  }
});

document.addEventListener("app-tab-change", (event) => {
  if (event.detail?.targetId === "tab-webhook") {
    syncCustomReportFiltersToCampaign(false);
    refreshCustomReport();
  }
});

window.electronAPI.onStateUpdated((payload) => {
  // If the webhook event carries an uploadId that matches the currently-selected
  // upload, only refresh the delivery report section (faster, no flicker).
  // Otherwise fall back to a full dashboard refresh.
  if (payload?.uploadId && payload.uploadId === selectedUploadId) {
    if (!refreshInProgress) refreshReport(selectedUploadId).catch(console.warn);
  } else {
    refreshDashboard();
  }
});

async function refreshDashboard() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    await refreshUploads();
  } catch (error) {
    console.warn("Dashboard refresh failed:", error);
  } finally {
    refreshInProgress = false;
  }
}

async function refreshUploads() {
  const uploads = await window.electronAPI.fetchUploads();
  lastUploads = uploads;
  renderUploadTable(uploads);
  const uploadToShow =
    uploads.find((upload) => upload.id === selectedUploadId) || uploads[0];
  if (uploadToShow) {
    selectedUploadId = uploadToShow.id;
    updateSelectedUploadValidationFromUpload(uploadToShow);
    currentUploadLabel.textContent = `Selected: ${uploadToShow.fileName}`;
    syncCustomReportFiltersToCampaign(false);
    await refreshReport(uploadToShow.id);
  } else {
    currentUploadLabel.textContent = selectedUploadId
      ? "Upload selected. Click Refresh Report if it is not visible in today's upload list."
      : "No CSV uploaded yet.";
    if (!selectedUploadId) {
      previewSummary.textContent = "";
      updateValidationPreview([]);
      updateNumberSplitPanel([]);
      previewTableBody.innerHTML = "";
      reportTableBody.innerHTML = "";
    }
  }
  if (isWebhookDebugVisible()) await refreshCustomReport();
  // update uploads summary
  await refreshUploadsSummary();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getAlertIcon(type) {
  switch (type) {
    case "success":
      return "Success";
    case "warning":
      return "Warning";
    case "error":
      return "Error";
    default:
      return "Info";
  }
}

function removeAlertElement(alertElement) {
  if (!alertElement) return;
  alertElement.classList.remove("show");
  setTimeout(() => {
    alertElement.remove();
  }, 180);
}

function showAlert(message, type = "info", duration = 6000) {
  if (!message) return;
  const alertElement = document.createElement("div");
  alertElement.className = `saas-alert saas-alert-${type}`;
  alertElement.innerHTML = `
    <div class="alert-icon">${getAlertIcon(type)}</div>
    <div class="alert-content">
      <div class="alert-message">${escapeHtml(message)}</div>
    </div>
    <button type="button" class="alert-close" aria-label="Dismiss notification">&times;</button>
  `;

  const closeButton = alertElement.querySelector(".alert-close");
  closeButton.addEventListener("click", () => removeAlertElement(alertElement));

  saasAlertContainer.appendChild(alertElement);
  requestAnimationFrame(() => alertElement.classList.add("show"));

  if (duration > 0) {
    setTimeout(() => removeAlertElement(alertElement), duration);
  }
}

function formatMsg91SendAlert(result = {}) {
  const statusCode = Number(result.apiStatusCode || result.statusCode || 0);
  const statusText = result.apiStatusText || result.statusText || "";
  const statusLabel = statusCode
    ? `${statusCode}${statusText ? ` ${statusText}` : ""}`
    : "success";
  const detail = result.message || "Message request sent to MSG91.";
  return `MSG91 accepted the template send with HTTP ${statusLabel}.\n${detail}`;
}

function parseStoredRowData(row) {
  if (!row?.data) return {};
  if (typeof row.data === "object") return row.data;
  try {
    return JSON.parse(row.data);
  } catch (error) {
    return {};
  }
}

function isPreviewRowValid(row) {
  return (
    row?.valid === true ||
    row?.valid === 1 ||
    row?.valid === "1" ||
    row?.valid === "true"
  );
}

function digitsOnly(value) {
  return String(value || "").replace(/\D+/g, "");
}

function rowPhoneText(row) {
  return digitsOnly(
    [
      row?.cleaned,
      row?.original,
      row?.normalizedMobile,
      row?.customerNumber,
      row?.mobile,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function rowMatchesPhoneSearch(row, searchValue) {
  const needle = digitsOnly(searchValue);
  if (!needle) return true;
  return rowPhoneText(row).includes(needle);
}

function getValidationStats(rows = lastPreviewRows) {
  const previewRows = Array.isArray(rows) ? rows : [];
  const valid = previewRows.filter(isPreviewRowValid).length;
  const total = previewRows.length;
  return {
    total,
    valid,
    invalid: Math.max(total - valid, 0),
  };
}

function updateSelectedUploadValidationFromUpload(upload) {
  if (!upload) {
    selectedUploadValidation = { total: 0, valid: 0, invalid: 0 };
    updateSendButtonState();
    return;
  }

  const total = Number(upload.totalRecords || 0);
  const valid = Number(upload.validCount || 0);
  const invalid = Number(upload.invalidCount || Math.max(total - valid, 0));
  selectedUploadValidation = { total, valid, invalid };
  updateSendButtonState();
}

function updateSendButtonState() {
  if (!sendButton) return;
  const hasValidatedUpload = Boolean(
    selectedUploadId && selectedUploadValidation.total > 0,
  );
  const hasValidNumbers = selectedUploadValidation.valid > 0;
  sendButton.disabled = !hasValidatedUpload || !hasValidNumbers;
  sendButton.title = hasValidatedUpload
    ? hasValidNumbers
      ? "Send selected template to valid numbers only"
      : "No valid numbers found in this upload"
    : "Upload and validate a CSV or Excel file first";
}

function getInvalidReason(row) {
  if (isPreviewRowValid(row)) return "";
  if (!String(row?.original || "").trim()) return "No mobile/phone value found";
  const cleaned = String(row?.cleaned || "").trim();
  if (!cleaned) return "No digits found";
  if (/^91\d{10}$/.test(cleaned))
    return "Indian number is not a valid mobile format";
  if (/^65\d{8}$/.test(cleaned))
    return "Singapore number is not a valid mobile format";
  return "Expected country code with 8 to 15 digits";
}

function getRecipientRegion(row) {
  if (!isPreviewRowValid(row)) return "invalid";
  const mobile = String(row.cleaned || row.original || "").replace(/\D+/g, "");
  return /^91[6-9]\d{9}$/.test(mobile) ? "india" : "foreign";
}

function getSplitRows(region) {
  return lastPreviewRows.filter((row) => getRecipientRegion(row) === region);
}

function updateNumberSplitPanel(rows = lastPreviewRows) {
  if (!numberSplitPanel) return;
  const previewRows = Array.isArray(rows) ? rows : [];
  const indianCount = previewRows.filter(
    (row) => getRecipientRegion(row) === "india",
  ).length;
  const foreignCount = previewRows.filter(
    (row) => getRecipientRegion(row) === "foreign",
  ).length;

  if (indianSplitCount) indianSplitCount.textContent = String(indianCount);
  if (foreignSplitCount) foreignSplitCount.textContent = String(foreignCount);
  if (exportIndianCsvButton) exportIndianCsvButton.disabled = indianCount === 0;
  if (exportForeignCsvButton)
    exportForeignCsvButton.disabled = foreignCount === 0;

  numberSplitPanel.classList.toggle("hidden", previewRows.length === 0);
}

function renderValidationRowDataButton(row, tableType, index) {
  const payload = parseStoredRowData(row);
  if (!payload || !Object.keys(payload).length) return "-";
  return `<button type="button" class="json-view-button" data-table-type="${tableType}" data-row-index="${index}" data-tooltip="View JSON">View JSON</button>`;
}

function renderValidationLists(rows = lastPreviewRows) {
  if (!validationLists || !invalidNumberTableBody) return;

  const previewRows = Array.isArray(rows) ? rows : [];
  const searchValue = previewPhoneSearch?.value || "";
  const invalidRows = previewRows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        !isPreviewRowValid(row) && rowMatchesPhoneSearch(row, searchValue),
    );

  validationLists.classList.toggle("hidden", previewRows.length === 0);
  invalidNumberTableBody.innerHTML = "";

  if (!invalidRows.length) {
    invalidNumberTableBody.innerHTML = `<tr><td colspan="4" class="small-note">No invalid numbers found${digitsOnly(searchValue) ? " for this search" : ""}.</td></tr>`;
  } else {
    invalidRows.forEach(({ row, index }, displayIndex) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${displayIndex + 1}</td>
        <td>${escapeHtml(row.original || "-")}</td>
        <td>${escapeHtml(row.cleaned || "-")}</td>
        <td><span class="badge badge-failed">${escapeHtml(getInvalidReason(row))}</span><br>${renderValidationRowDataButton(row, "preview", index)}</td>
      `;
      invalidNumberTableBody.appendChild(tr);
    });
  }
}

function updateValidationPreview(rows = lastPreviewRows) {
  const stats = getValidationStats(rows);
  selectedUploadValidation = stats;
  if (validationPanel)
    validationPanel.classList.toggle("hidden", stats.total === 0);
  if (validationTotalCount)
    validationTotalCount.textContent = String(stats.total);
  if (validationValidCount)
    validationValidCount.textContent = String(stats.valid);
  if (validationInvalidCount)
    validationInvalidCount.textContent = String(stats.invalid);
  renderValidationLists(rows);
  updateSendButtonState();
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsvFromRows(rows) {
  const headerSet = new Set();
  rows.forEach((row) => {
    const data = parseStoredRowData(row);
    Object.keys(data).forEach((key) => headerSet.add(key));
  });

  const headers = [...headerSet];
  if (!headers.length) headers.push("Mobile Number");

  const lines = [headers.map(escapeCsvValue).join(",")];
  rows.forEach((row) => {
    const data = parseStoredRowData(row);
    if (!Object.keys(data).length)
      data["Mobile Number"] = row.cleaned || row.original || "";
    lines.push(
      headers.map((header) => escapeCsvValue(data[header] ?? "")).join(","),
    );
  });
  return lines.join("\r\n");
}

function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSplitCsv(region) {
  const rows = getSplitRows(region);
  if (!rows.length) {
    showAlert(
      `No ${region === "india" ? "Indian" : "foreign"} numbers found in this preview.`,
      "warning",
    );
    return;
  }

  const csvText = buildCsvFromRows(rows);
  const label = region === "india" ? "indian" : "foreign";
  const uploadPart = selectedUploadId
    ? `upload-${selectedUploadId}`
    : "preview";
  downloadCsv(`${label}-numbers-${uploadPart}.csv`, csvText);
  showAlert(
    `${rows.length} ${label} row(s) exported as CSV. Upload that file as a separate batch before sending.`,
    "success",
  );
}

function updateCsvHeadersFromRows(rows) {
  const firstRow = rows.find((row) => row.data);
  csvHeaders = Object.keys(parseStoredRowData(firstRow));
}

function getSelectedTemplate() {
  const selectedNumber = getSelectedNumber();

  if (!selectedNumber) return null;

  return (selectedNumber.templates || []).find(
    (template) =>
      template.id === templateSelect.value ||
      template.name === templateSelect.value,
  );
}

function getSelectedNumber() {
  return msg91Config.integratedNumbers.find(
    (entry) =>
      entry.id === numberSelect.value || entry.number === numberSelect.value,
  );
}

function isWebhookDebugVisible() {
  return document.getElementById("tab-webhook")?.classList.contains("active");
}

function setSelectValueIfOptionExists(select, value) {
  if (!select || !value) return false;
  const option = [...select.options].find((entry) => entry.value === value);
  if (!option) return false;
  select.value = value;
  return true;
}

function syncCampaignSelectorsFromUpload(upload) {
  if (!upload) return;
  if (upload.senderNumber) {
    const sender = msg91Config.integratedNumbers.find(
      (entry) =>
        String(entry.number) === String(upload.senderNumber) ||
        String(entry.id) === String(upload.senderNumber),
    );
    if (
      sender &&
      setSelectValueIfOptionExists(numberSelect, sender.id || sender.number)
    ) {
      renderTemplateOptions();
    }
  }

  const templateValue = upload.templateId || upload.templateName || "";
  if (templateValue) {
    setSelectValueIfOptionExists(templateSelect, templateValue);
  }
  renderMappingTable();
}

function syncCustomReportFiltersToCampaign(force = false) {
  if (!force && customFiltersTouched) return;

  customScope.value = selectedUploadId ? "selected" : "all";
  customEventType.value = "all";
  customStatus.value = "all";
  const selectedNumber = getSelectedNumber();
  if (selectedNumber) {
    setSelectValueIfOptionExists(
      customNumberFilter,
      selectedNumber.id || selectedNumber.number,
    );
  }
  renderCustomTemplateOptions();

  const selectedTemplate = getSelectedTemplate();
  if (selectedTemplate) {
    setSelectValueIfOptionExists(
      customTemplateFilter,
      selectedTemplate.name || selectedTemplate.id || selectedTemplate.label,
    );
  }
  if (!customStartDateTime.value || !customEndDateTime.value) {
    applyReportRangePreset(customRangePreset?.value || "day", false);
  }
}

function findDefaultColumn(component) {
  if (!csvHeaders.length) return "";
  const preferred =
    component.defaultColumn || component.parameterName || component.key || "";
  const alternatives = [
    preferred,
    component.parameterName,
    component.key,
    preferred.replace(/^body_/, ""),
    preferred.replace(/^body_body_/, ""),
    (component.parameterName || "").replace(/^body_/, ""),
    (component.key || "").replace(/^body_/, "").replace(/^body_/, ""),
  ].filter(Boolean);
  const normalizedAlternatives = alternatives.map((value) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
  return (
    csvHeaders.find((header) => header === component.defaultColumn) ||
    csvHeaders.find((header) =>
      normalizedAlternatives.includes(
        header.toLowerCase().replace(/[^a-z0-9]/g, ""),
      ),
    ) ||
    csvHeaders.find((header) =>
      normalizedAlternatives.some(
        (normalizedPreferred) =>
          normalizedPreferred &&
          header
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")
            .includes(normalizedPreferred),
      ),
    ) ||
    ""
  );
}

function renderNumberOptions() {
  numberSelect.innerHTML = `<option value="">Select sender number</option>`;
  msg91Config.integratedNumbers.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.id || entry.number;
    option.textContent = entry.label || entry.number;
    numberSelect.appendChild(option);
  });
  const defaultNumber =
    msg91Config.integratedNumbers.find(
      (entry) => entry.number === msg91Config.integratedNumber,
    ) || msg91Config.integratedNumbers[0];
  if (defaultNumber) {
    numberSelect.value = defaultNumber.id || defaultNumber.number;
  }
}

function renderCustomNumberOptions() {
  customNumberFilter.innerHTML = `<option value="all">All sender numbers</option>`;
  msg91Config.integratedNumbers.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.id || entry.number;
    option.textContent = entry.label || entry.number;
    customNumberFilter.appendChild(option);
  });
}

function renderCustomTemplateOptions() {
  const selectedNumber = msg91Config.integratedNumbers.find(
    (entry) =>
      entry.id === customNumberFilter.value ||
      entry.number === customNumberFilter.value,
  );
  customTemplateFilter.innerHTML = `<option value="all">All templates</option>`;
  const templates = selectedNumber?.templates?.length
    ? selectedNumber.templates
    : msg91Config.integratedNumbers.reduce(
        (all, entry) => all.concat(entry.templates || []),
        [],
      );
  templates.forEach((template) => {
    const option = document.createElement("option");
    option.value = template.name || template.id || template.label;
    option.textContent = template.label || template.name;
    customTemplateFilter.appendChild(option);
  });
}

function renderTemplateOptions() {
  const selectedNumber = getSelectedNumber();
  templateSelect.innerHTML = `<option value="">Select template</option>`;
  const templates = selectedNumber?.templates || [];
  templates.forEach((template) => {
    const option = document.createElement("option");
    option.value = template.id || template.name;
    option.textContent = template.label || template.name;
    templateSelect.appendChild(option);
  });
  if (templates.length > 0) {
    templateSelect.value = templates[0].id || templates[0].name;
  }
}

function renderMappingTable() {
  const template = getSelectedTemplate();
  mappingTableBody.innerHTML = "";

  if (!template) {
    templateDescription.textContent = "";
    mappingSummary.textContent = numberSelect.value
      ? "Select a template to map CSV columns."
      : "Select a sender number first.";
    return;
  }

  const selectedNumber = getSelectedNumber();
  templateDescription.textContent = `${template.name} | Sender: ${selectedNumber?.number || "-"} | Language: ${template.language || "en"}${template.description ? ` | ${template.description}` : ""}`;
  const components = Array.isArray(template.components)
    ? template.components
    : [];
  if (!components.length) {
    mappingSummary.textContent = "This template has no mapped variables.";
    return;
  }

  mappingSummary.textContent = csvHeaders.length
    ? "Map each template field to the matching CSV column before sending."
    : "Upload a CSV to see available columns for this template.";

  const previewData = parseStoredRowData(lastPreviewRows[0]);
  components.forEach((component) => {
    const isMedia = mediaComponentTypes.has(
      String(component.type || "").toLowerCase(),
    );
    const defaultColumn = findDefaultColumn(component);
    const tr = document.createElement("tr");
    const options = [`<option value="">Select column</option>`]
      .concat(
        csvHeaders.map((header) => {
          const selected = header === defaultColumn ? "selected" : "";
          return `<option value="${escapeHtml(header)}" ${selected}>${escapeHtml(header)}</option>`;
        }),
      )
      .join("");
    const previewValue = defaultColumn ? previewData[defaultColumn] : "";
    const staticInput = isMedia
      ? `<input type="url" data-static-key="${escapeHtml(component.key)}" placeholder="${escapeHtml(`${component.type || "media"} URL`)}" />
         <input type="file" data-file-key="${escapeHtml(component.key)}" accept="${component.type === "document" ? "application/pdf" : "image/*"}" />`
      : "";
    tr.innerHTML = `
      <td>${escapeHtml(component.label || component.parameterName || component.key)}<br><span class="small-note">${escapeHtml(component.type || "text")}</span></td>
      <td><select data-component-key="${escapeHtml(component.key)}">${options}</select></td>
      <td>${staticInput}</td>
      <td>${escapeHtml(previewValue || "-")}</td>
    `;
    mappingTableBody.appendChild(tr);
  });
}

function getColumnMapping() {
  const mapping = {};
  mappingTableBody
    .querySelectorAll("select[data-component-key]")
    .forEach((select) => {
      if (select.value) {
        mapping[select.dataset.componentKey] = select.value;
      }
    });
  mappingTableBody
    .querySelectorAll("input[data-static-key]")
    .forEach((input) => {
      if (input.value.trim()) {
        mapping[`${input.dataset.staticKey}:staticValue`] = input.value.trim();
      }
    });
  return mapping;
}

async function loadMsg91Config() {
  msg91Config = await window.electronAPI.getMsg91Config();
  renderNumberOptions();
  renderTemplateOptions();
  renderCustomNumberOptions();
  renderCustomTemplateOptions();
  syncCustomReportFiltersToCampaign(true);
  if (!customStartDateTime.value || !customEndDateTime.value) {
    applyReportRangePreset(customRangePreset?.value || "day", false);
  }
  updateDateRangeDisplay();
  const configuredText = msg91Config.hasAuthKey
    ? "Auth key configured"
    : "Auth key missing";
  const numberText = msg91Config.integratedNumbers?.length
    ? `${msg91Config.integratedNumbers.length} sender number(s) configured`
    : "Sender number missing";
  const totalTemplates = msg91Config.integratedNumbers.reduce(
    (sum, item) => sum + (item.templates?.length || 0),
    0,
  );

  const templateText = `${totalTemplates} template(s) configured`;
  const mongoText = msg91Config.mongoConnected
    ? "MongoDB connected"
    : msg91Config.hasMongoUri
      ? "MongoDB configured, connection pending"
      : "MongoDB not configured";
  const webhookText = msg91Config.webhookIsLocalOnly
    ? "Webhook is local only; MSG91 cannot send replies to this PC until WEBHOOK_PUBLIC_BASE_URL is set to a public HTTPS URL"
    : `Webhook public URL: ${msg91Config.webhookUrl || "configured"}`;
  const reportSourceText = msg91Config.reportPollingEnabled
    ? "MSG91 report API polling enabled"
    : "Reports/replies sync from CRM webhook MongoDB";
  configStatus.textContent = `MSG91 configuration: ${configuredText}. ${numberText}. ${templateText}. ${mongoText}. ${webhookText}. ${reportSourceText}.`;
  renderMappingTable();
}

function renderUploadTable(uploads) {
  // Render uploads table without duplicate rows
  uploadTableBody.innerHTML = "";
  const searchValue = String(uploadPhoneSearch?.value || "")
    .trim()
    .toLowerCase();
  const searchDigits = digitsOnly(searchValue);
  const filteredUploads = (Array.isArray(uploads) ? uploads : []).filter(
    (upload) => {
      if (!searchValue) return true;
      const text = [
        upload.fileName,
        upload.templateLabel,
        upload.templateName,
        upload.senderId,
        upload.senderNumber,
        upload.senderLabel,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const digits = digitsOnly(text);
      return (
        text.includes(searchValue) ||
        (searchDigits && digits.includes(searchDigits))
      );
    },
  );

  if (!filteredUploads.length) {
    uploadTableBody.innerHTML = `<tr><td colspan="10" class="small-note">No uploads match this search.</td></tr>`;
    return;
  }

  filteredUploads.forEach((upload) => {
    const tr = document.createElement("tr");
    const template = escapeHtml(
      upload.templateLabel || upload.templateName || "-",
    );
    const sender = escapeHtml(upload.senderId || upload.senderNumber || "-");
    const triggeredAt = escapeHtml(
      upload.sentAt || upload.updatedAt || upload.createdAt || "-",
    );
    const retryButton =
      Number(upload.failedCount || 0) > 0
        ? `<button class="small-button" data-retry-id="${upload.id}" title="Retry only failed rows from this upload">Retry Failed</button>`
        : "";
    tr.dataset.uploadId = String(upload.id);
    tr.innerHTML = `
      <td>${escapeHtml(upload.fileName)}</td>
      <td>${upload.totalRecords || 0}</td>
      <td>${upload.validCount || 0}</td>
      <td>${upload.invalidCount || 0}</td>
      <td>${upload.deliveredCount || 0}</td>
      <td>${upload.failedCount || 0}</td>
      <td>${template}</td>
      <td>${sender}</td>
      <td>${triggeredAt}</td>
      <td>
        <button class="small-button" data-upload-id="${upload.id}" title="Open this upload in the delivery report">Select</button>
        <button class="small-button secondary-button" data-export-id="${upload.id}" title="Download PDF for this upload">Export PDF</button>
        ${retryButton}
      </td>
    `;
    uploadTableBody.appendChild(tr);
  });

  uploadTableBody.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const uploadId = Number(
        event.target.dataset.uploadId ||
          event.target.dataset.retryId ||
          event.target.dataset.exportId,
      );
      if (event.target.dataset.uploadId) {
        selectedUploadId = uploadId;
        const uploads = await window.electronAPI.fetchUploads();
        const upload = uploads.find((item) => item.id === uploadId);
        if (upload) {
          updateSelectedUploadValidationFromUpload(upload);
          currentUploadLabel.textContent = `Selected: ${upload.fileName}`;
          customFiltersTouched = false;
          lastPreviewRows = [];
          syncCampaignSelectorsFromUpload(upload);
          syncCustomReportFiltersToCampaign(true);
          await refreshReport(uploadId);
          if (isWebhookDebugVisible()) await refreshCustomReport();
        }
      }
      if (event.target.dataset.retryId) {
        try {
          const result = await window.electronAPI.retryFailed(uploadId);
          showAlert(formatMsg91SendAlert(result), "success");
          await refreshUploads();
        } catch (err) {
          showAlert(`Retry failed: ${err.message}`, "error");
        }
      }
      if (event.target.dataset.exportId) {
        try {
          const result = await window.electronAPI.exportUploadReport(uploadId);
          showAlert(
            `PDF report exported with ${result.rowCount} rows:\n${result.filePath}`,
            "success",
          );
        } catch (err) {
          showAlert(`Export failed: ${err.message}`, "error");
        }
      }
    });
  });
}

async function refreshUploadsSummary() {
  try {
    const stats = await window.electronAPI.fetchSenderStats({
      todayOnly: true,
    });
    const el = document.getElementById("uploadsSummary");
    if (!el) return;
    el.textContent = `Today: ${stats.totalSends} messages sent across ${stats.templatesTriggered} template(s). Responses received: ${stats.responsesReceived}.`;
  } catch (err) {
    console.warn("Unable to load uploads summary:", err);
  }
}

function displayPreview(rows) {
  try {
    lastPreviewRows = Array.isArray(rows) ? rows : [];
    updateCsvHeadersFromRows(lastPreviewRows);
    renderMappingTable();
    const count = lastPreviewRows.length;
    updateValidationPreview(lastPreviewRows);
    updateNumberSplitPanel(lastPreviewRows);
    const indiaCount = getSplitRows("india").length;
    const foreignCount = getSplitRows("foreign").length;
    const validCount = selectedUploadValidation.valid;
    const invalidCount = selectedUploadValidation.invalid;
    previewSummary.textContent = `Validation complete: ${validCount} valid and ${invalidCount} invalid out of ${count} rows. Only valid numbers can be sent through MSG91.`;

    if (!previewTableBody) {
      console.warn("previewTableBody element not found in DOM");
      return;
    }

    previewTableBody.innerHTML = "";

    if (!count) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="8" class="small-note">No preview rows available. Please check the selected CSV/Excel file.</td>`;
      previewTableBody.appendChild(tr);
      return;
    }

    const searchValue = previewPhoneSearch?.value || "";
    const visibleRows = lastPreviewRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => rowMatchesPhoneSearch(row, searchValue));

    if (!visibleRows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="8" class="small-note">No preview rows match this phone search.</td>`;
      previewTableBody.appendChild(tr);
      return;
    }

    visibleRows.forEach(({ row, index }, displayIndex) => {
      const tr = document.createElement("tr");
      tr.dataset.tableType = "preview";
      tr.dataset.rowIndex = String(index);
      const previewPayload = parseStoredRowData(row);
      const previewHasJson =
        previewPayload && Object.keys(previewPayload).length > 0;

      const previewStatusText =
        row.currentStatus || (isPreviewRowValid(row) ? "valid" : "invalid");
      let previewStatusClass = "badge-pending";
      if (previewStatusText === "valid" || previewStatusText === "Valid")
        previewStatusClass = "badge-delivered";
      else if (
        previewStatusText === "invalid" ||
        previewStatusText === "Invalid"
      )
        previewStatusClass = "badge-failed";
      const previewStatusHtml = `<span class="badge ${previewStatusClass}">${escapeHtml(previewStatusText)}</span>`;

      const previewMobileHtml = `<span class="mobile-pill">${escapeHtml(row.cleaned || row.original || "")}</span>`;
      const region = getRecipientRegion(row);
      const regionLabel =
        region === "india"
          ? "Indian Batch"
          : region === "foreign"
            ? "Foreign Batch"
            : "Invalid";
      const regionClass =
        region === "india"
          ? "region-india"
          : region === "foreign"
            ? "region-foreign"
            : "region-invalid";
      const regionHtml = `<span class="region-pill ${regionClass}">${escapeHtml(regionLabel)}</span>`;

      const previewDeliveryText = row.deliveryStatus || "pending";
      let previewDeliveryClass = "badge-pending";
      const pdLower = String(previewDeliveryText).toLowerCase();
      if (
        pdLower.includes("delivered") ||
        pdLower.includes("read") ||
        pdLower.includes("success")
      ) {
        previewDeliveryClass = "badge-delivered";
      } else if (
        pdLower.includes("failed") ||
        pdLower.includes("undelivered")
      ) {
        previewDeliveryClass = "badge-failed";
      } else if (pdLower.includes("sent") || pdLower.includes("submitted")) {
        previewDeliveryClass = "badge-sent";
      }
      const previewDeliveryHtml = `<span class="badge ${previewDeliveryClass}">${escapeHtml(previewDeliveryText)}</span>`;

      tr.innerHTML = `
        <td>${displayIndex + 1}</td>
        <td>${previewStatusHtml}</td>
        <td>${regionHtml}</td>
        <td>${previewMobileHtml}</td>
        <td>${previewDeliveryHtml}</td>
        <td>${row.retryCount || 0}</td>
        <td>${escapeHtml(row.lastUpdated || "")}</td>
        <td>${previewHasJson ? `<button type="button" class="json-view-button" data-table-type="preview" data-row-index="${index}" data-tooltip="View JSON">View JSON</button>` : "-"}</td>
      `;
      previewTableBody.appendChild(tr);
    });
  } catch (err) {
    console.error("displayPreview error:", err);
    previewSummary.textContent = "Unable to show preview (see console).";
    if (previewTableBody) {
      previewTableBody.innerHTML = `<tr><td colspan=8 class=\"small-note\">Error generating preview.</td></tr>`;
    }
  }
}

// Guard: only one refreshReport call runs at a time.
// Concurrent calls (auto-poll + manual button) would clear + re-append the
// table in an interleaved order, producing duplicate rows.
let reportRefreshInProgress = false;
let reportRefreshQueued = null; // holds the latest uploadId requested while busy

async function refreshReport(uploadId) {
  if (reportRefreshInProgress) {
    // Remember the latest requested upload so we can re-run it once done.
    reportRefreshQueued = uploadId;
    return;
  }
  reportRefreshInProgress = true;
  try {
    await _doRefreshReport(uploadId);
    // If a newer request came in while we were running, run it once more now.
    if (reportRefreshQueued !== null && reportRefreshQueued !== uploadId) {
      const queued = reportRefreshQueued;
      reportRefreshQueued = null;
      await _doRefreshReport(queued);
    }
  } finally {
    reportRefreshInProgress = false;
    reportRefreshQueued = null;
  }
}

async function _doRefreshReport(uploadId) {
  const rows = await window.electronAPI.fetchReport(uploadId);
  lastReportRows = rows;
  updateDeliveryContextSummary(uploadId);
  if (rows.length && !lastPreviewRows.length) {
    lastPreviewRows = rows;
    updateCsvHeadersFromRows(rows);
    renderMappingTable();
    displayPreview(rows);
  }

  renderDeliveryRows(rows);
}

function renderDeliveryRows(rows = lastReportRows) {
  lastInboundRows = [];

  // --- DOM writes happen here, all at once, with no awaits in between ---
  reportTableBody.innerHTML = "";

  const searchValue = deliveryPhoneSearch?.value || "";
  const visibleRows = (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => rowMatchesPhoneSearch(row, searchValue));

  if (!visibleRows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="8" class="small-note">${rows.length ? "No delivery report rows match this phone search." : "No delivery report rows found for this selected upload yet."}</td>`;
    reportTableBody.appendChild(tr);
  }

  visibleRows.forEach(({ row, index }, displayIndex) => {
    const tr = document.createElement("tr");
    tr.dataset.tableType = "report";
    tr.dataset.rowIndex = String(index);

    const reportMobileHtml = `<span class="mobile-pill">${escapeHtml(row.cleaned || row.original || "")}</span>`;

    const deliveryText = row.deliveryStatus || row.currentStatus || "pending";
    let deliveryClass = "badge-pending";
    const dtLower = String(deliveryText).toLowerCase();
    if (
      dtLower.includes("delivered") ||
      dtLower.includes("read") ||
      dtLower.includes("success")
    ) {
      deliveryClass = "badge-delivered";
    } else if (dtLower.includes("failed") || dtLower.includes("undelivered")) {
      deliveryClass = "badge-failed";
    } else if (dtLower.includes("sent") || dtLower.includes("submitted")) {
      deliveryClass = "badge-sent";
    }
    const deliveryHtml = `<span class="badge ${deliveryClass}">${escapeHtml(deliveryText)}</span>`;
    const replyTime = getReplyTime(row);

    tr.innerHTML = `
      <td>${displayIndex + 1}</td>
      <td>${reportMobileHtml}</td>
      <td>${escapeHtml(getTemplateLabelForReport(row) || "-")}</td>
      <td><div class="raw-cell">${escapeHtml(row.sentMessage || "-")}</div></td>
      <td>${deliveryHtml}</td>
      <td><div class="raw-cell ${formatReplyHistory(row) !== "-" ? "reply-cell-highlight" : ""}">${formatReplyHistoryHtml(row)}</div></td>
      <td>${escapeHtml(replyTime)}</td>
      <td>${escapeHtml(row.responseId || "-")}</td>
    `;
    reportTableBody.appendChild(tr);
  });

  const matchedReplyCount = visibleRows.filter(({ row }) => {
    const replyText = formatReplyHistory(row);
    return replyText && replyText !== "-";
  }).length;
  const filterText =
    visibleRows.length === rows.length
      ? ""
      : ` (${visibleRows.length} after phone search)`;
  deliveryReplySummary.textContent = rows.length
    ? `Showing ${rows.length} selected-upload transaction${rows.length === 1 ? "" : "s"}${filterText}. ${matchedReplyCount} customer repl${matchedReplyCount === 1 ? "y" : "ies"} matched.`
    : "No selected-upload transactions found yet.";
}

function updateDeliveryContextSummary(uploadId) {
  if (!deliveryContextSummary) return;
  const upload = lastUploads.find(
    (item) => Number(item.id) === Number(uploadId),
  );
  if (!upload) {
    deliveryContextSummary.textContent = uploadId
      ? `Selected upload #${uploadId}.`
      : "No upload selected.";
    return;
  }
  const sender = upload.senderLabel || upload.senderNumber || upload.senderId || "-";
  const template =
    upload.templateLabel || upload.templateName || upload.templateId || "-";
  deliveryContextSummary.textContent = `Selected upload #${upload.id}: ${upload.fileName} | Sender: ${sender} | Template: ${template} | Range: Today by default`;
}

function getLocalDatetimeForInput(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getReportRangeForPreset(preset) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  if (preset === "yesterday") {
    // Yesterday 10:00 AM IST to today 10:00 AM IST
    start.setDate(start.getDate() - 1);
    start.setHours(10, 0, 0, 0);
    end.setHours(10, 0, 0, 0);
    return { start, end };
  }

  if (preset === "week") {
    start.setDate(start.getDate() - 6);
  } else if (preset === "month") {
    start.setDate(1);
  }

  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function applyReportRangePreset(preset = "day", refresh = true) {
  if (preset === "custom") {
    updateDateRangeDisplay();
    return;
  }

  const { start, end } = getReportRangeForPreset(preset);
  customStartDateTime.value = getLocalDatetimeForInput(start);
  customEndDateTime.value = getLocalDatetimeForInput(end);
  updateDateRangeDisplay();
  if (refresh) refreshCustomReport();
}

function formatDateTimeDisplayLabel(startIso, endIso) {
  const startDate = new Date(startIso);
  const endDate = new Date(endIso);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "Select date range";
  }
  const fmt = (d) => d.toLocaleString("en-IN", { timeZone: "Asia/Calcutta" });
  return `${fmt(startDate)} to ${fmt(endDate)}`;
}

function updateDateRangeDisplay() {
  if (customStartDateTime.value && customEndDateTime.value) {
    const presetLabel = {
      day: "Today",
      yesterday: "Yesterday",
      week: "Last 7 days",
      month: "This month",
      custom: "",
    }[customRangePreset?.value || ""];
    const rangeLabel = formatDateTimeDisplayLabel(
      customStartDateTime.value,
      customEndDateTime.value,
    );
    customDateTimeDisplay.value = presetLabel
      ? `${presetLabel}: ${rangeLabel}`
      : rangeLabel;
  } else {
    customDateTimeDisplay.value = "";
  }
}

function openDateTimePicker() {
  if (customRangePreset) customRangePreset.value = "custom";
  const now = new Date();
  const startValue =
    customStartDateTime.value &&
    !Number.isNaN(new Date(customStartDateTime.value).getTime())
      ? new Date(customStartDateTime.value)
      : new Date(now.setHours(0, 0, 0, 0));
  const endValue =
    customEndDateTime.value &&
    !Number.isNaN(new Date(customEndDateTime.value).getTime())
      ? new Date(customEndDateTime.value)
      : new Date(startValue);

  customStartDateInput.value = startValue.toISOString().slice(0, 10);
  customStartTimeInput.value = `${String(startValue.getHours()).padStart(2, "0")}:${String(startValue.getMinutes()).padStart(2, "0")}`;
  customEndDateInput.value = endValue.toISOString().slice(0, 10);
  customEndTimeInput.value = `${String(endValue.getHours()).padStart(2, "0")}:${String(endValue.getMinutes()).padStart(2, "0")}`;

  dateTimePickerBackdrop.classList.add("show");
  dateTimePickerBackdrop.setAttribute("aria-hidden", "false");
}

function closeDateTimePicker() {
  dateTimePickerBackdrop.classList.remove("show");
  dateTimePickerBackdrop.setAttribute("aria-hidden", "true");
}

function getCustomReportFilters() {
  const numberId = customNumberFilter.value;
  const selectedSender = msg91Config.integratedNumbers.find(
    (entry) => entry.id === numberId || entry.number === numberId,
  );
  const templateName = customTemplateFilter.value;
  return {
    uploadId: customScope.value === "selected" ? selectedUploadId : null,
    filteredNumberId:
      numberId && numberId !== "all"
        ? selectedSender?.number || numberId
        : null,
    templateName:
      templateName && templateName !== "all"
        ? customTemplateFilter.value
        : null,
    startDateTime: customStartDateTime.value || null,
    endDateTime: customEndDateTime.value || null,
    eventType: customEventType.value,
    status: customStatus.value,
    search: customSearch.value.trim(),
  };
}

function displayDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // Always display in IST (Asia/Calcutta) regardless of system locale
  return date.toLocaleString("en-IN", { timeZone: "Asia/Calcutta" });
}

function formatJsonBlock(value) {
  if (!value) return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function isJsonLike(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") {
    const t = value.trim();
    return t.startsWith("{") || t.startsWith("[");
  }
  return false;
}

function truncateText(text, max = 120) {
  if (!text) return "";
  const s = String(text);
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function formatReplyHistoryEntries(row) {
  const history = Array.isArray(row.replyHistory) ? row.replyHistory : [];
  const directReply =
    row.customReply ||
    row.inboundReply?.text ||
    row.senderReport?.customReply ||
    "";

  if (!history.length) {
    return directReply ? [{ time: "", text: directReply }] : [];
  }

  const entries = history
    .map((reply) => ({
      time: displayDate(
        reply.receivedAt || reply.lastReplyAt || reply.updatedAt,
      ),
      text:
        reply.text ||
        reply.customReply ||
        JSON.stringify(reply.payload || reply.rawPayload || {}),
    }))
    .filter((entry) => entry.text && !entry.text.endsWith("{}"));

  if (
    directReply &&
    !entries.some((entry) => entry.text.includes(directReply))
  ) {
    entries.unshift({ time: "", text: directReply });
  }

  return entries;
}

function formatReplyHistory(row) {
  const entries = formatReplyHistoryEntries(row);
  if (!entries.length) return "-";
  return entries
    .map((entry) => (entry.time ? `${entry.time}: ${entry.text}` : entry.text))
    .join("\n");
}

// Returns an icon for known WhatsApp button replies: a green check for
// "Execute the Trade" and a red cross for "Deny". Any other reply text is
// shown as-is with no icon.
function getReplyIndicatorHtml(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase();
  if (normalized === "execute the trade") {
    return '<span class="reply-icon reply-icon-positive" title="Execute the Trade">&#10003;</span>';
  }
  if (normalized === "deny" || normalized === "denied") {
    return '<span class="reply-icon reply-icon-negative" title="Deny">&#10007;</span>';
  }
  return "";
}

function formatReplyHistoryHtml(row) {
  const entries = formatReplyHistoryEntries(row);
  if (!entries.length) return "-";
  return entries
    .map((entry) => {
      const icon = getReplyIndicatorHtml(entry.text);
      const prefix = entry.time ? `${escapeHtml(entry.time)}: ` : "";
      return `<div class="reply-line">${icon}${prefix}${escapeHtml(entry.text)}</div>`;
    })
    .join("");
}

function getReplyTime(row) {
  if (row.lastReplyAt) return displayDate(row.lastReplyAt);
  if (
    row.inboundReply?.receivedAt ||
    row.inboundReply?.statusUpdatedAt ||
    row.inboundReply?.updatedAt
  ) {
    return displayDate(
      row.inboundReply.receivedAt ||
        row.inboundReply.statusUpdatedAt ||
        row.inboundReply.updatedAt,
    );
  }
  const history = Array.isArray(row.replyHistory) ? row.replyHistory : [];
  const latest = history
    .map((reply) => reply.receivedAt || reply.lastReplyAt || reply.updatedAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  return latest ? displayDate(latest) : "-";
}

function parseMaybeJson(value) {
  if (!value || typeof value !== "string") return value;
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

function extractReplyTextFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const button = parseMaybeJson(payload.button);
  const interactive = parseMaybeJson(payload.interactive);
  const messages = parseMaybeJson(payload.messages);

  if (payload.text) return String(payload.text);
  if (button && typeof button === "object")
    return button.text || button.payload || button.title || "";
  if (typeof button === "string") return button;
  if (interactive && typeof interactive === "object") {
    return (
      interactive.button_reply?.title ||
      interactive.list_reply?.title ||
      interactive.button_reply?.id ||
      interactive.list_reply?.id ||
      ""
    );
  }
  if (typeof interactive === "string") return interactive;
  if (Array.isArray(messages)) {
    return messages
      .map(
        (message) =>
          message?.text?.body ||
          message?.button?.text ||
          message?.button?.payload ||
          message?.interactive?.button_reply?.title ||
          message?.interactive?.list_reply?.title ||
          message?.reaction?.emoji ||
          "",
      )
      .filter(Boolean)
      .join(" | ");
  }
  if (payload.caption) return String(payload.caption);
  if (payload.reaction) return String(payload.reaction);
  return "";
}

function getMessageText(row) {
  const extracted = extractReplyTextFromPayload(row.rawPayload || row);
  if (row.text) return row.text;
  if (extracted) return extracted;
  if (row.content) return row.content;
  if (row.caption) return row.caption;
  if (row.button) return row.button;
  if (row.interactive) return row.interactive;
  if (row.messages) return row.messages;
  return "-";
}

function getCsvField(row, candidates = []) {
  const data =
    row?.csvRowData && typeof row.csvRowData === "object" ? row.csvRowData : {};
  const normalized = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      String(key)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ""),
      value,
    ]),
  );
  for (const candidate of candidates) {
    const key = String(candidate)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    const value = normalized[key];
    if (value !== undefined && value !== null && String(value).trim())
      return String(value).trim();
  }
  return "";
}

function getCustomerName(row) {
  return (
    row.customerName ||
    getCsvField(row, [
      "Customer Name",
      "Client Name",
      "Name",
      "Customer",
      "Client",
    ]) ||
    "-"
  );
}

function getTemplateLabelForReport(row) {
  return (
    row.templateName ||
    row.uploadTemplateLabel ||
    row.templateLabel ||
    row.campaignName ||
    row.templateId ||
    (row.upload && row.upload.templateName) ||
    "No Template"
  );
}

function getSentMessage(row) {
  if (row.sentMessage) return row.sentMessage;
  const parts = [
    [
      "Stock Name",
      getCsvField(row, ["Stock Name", "Stock", "Scrip", "Symbol"]),
    ],
    [
      "Client Name",
      getCsvField(row, ["Client Name", "Customer Name", "Name", "Client"]),
    ],
    ["Price", getCsvField(row, ["Price", "PRICE", "Rate"])],
    ["Client Code", getCsvField(row, ["Client Code", "ClientCode", "Code"])],
    [
      "Order Type",
      getCsvField(row, ["Order Type", "OrderType", "Buy/Sell", "Side"]),
    ],
    ["Qty", getCsvField(row, ["Qty", "QTY", "Quantity"])],
  ].filter(([, value]) => value);
  return parts.length
    ? parts.map(([label, value]) => `${label}: ${value}`).join(" | ")
    : "-";
}

function flattenPayload(value, prefix = "", result = {}) {
  if (value === null || value === undefined) return result;
  if (typeof value !== "object") {
    if (prefix) result[prefix] = value;
    return result;
  }
  Object.entries(value).forEach(([key, item]) => {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      flattenPayload(item, nextPrefix, result);
    } else {
      result[nextPrefix] = Array.isArray(item) ? JSON.stringify(item) : item;
    }
  });
  return result;
}

function getDynamicResponse(row) {
  const payload = flattenPayload(row.rawPayload || {});
  return Object.entries(payload)
    .filter(
      ([, value]) => value !== null && value !== undefined && value !== "",
    )
    .slice(0, 12)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

function getFriendlyStatus(row) {
  if (row.customReply || row.lastReplyAt) return "Customer replied";
  if (row.eventType === "inbound") return "Customer replied";
  if (row.normalizedStatus === "delivered") return "Delivered / read";
  if (row.normalizedStatus === "failed") return "Failed";
  if (row.normalizedStatus === "sent") return "Sent to MSG91";
  return row.normalizedStatus || "In progress";
}

function getMatchedMessageStatus(row) {
  const parts = [];
  if (row.numberCurrentStatus)
    parts.push(`Message: ${row.numberCurrentStatus}`);
  if (row.numberDeliveryStatus)
    parts.push(`Delivery: ${row.numberDeliveryStatus}`);
  return parts.join("\n") || "-";
}

function getSentDeliveryStatus(row) {
  return (
    row.numberDeliveryStatus ||
    row.deliveryStatus ||
    (row.eventType === "outbound" ? row.normalizedStatus : "") ||
    ""
  );
}

function getReceivedDeliveryStatus(row) {
  if (row.eventType === "inbound") return "Customer replied";
  if (row.customReply || row.lastReplyAt) return "Customer replied";
  return "";
}

function getStatusTone(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized.includes("fail") || normalized.includes("deny")) return "failed";
  if (normalized.includes("deliver") || normalized.includes("read")) return "delivered";
  if (normalized.includes("reply")) return "replied";
  if (normalized.includes("sent") || normalized.includes("submit")) return "sent";
  return "pending";
}

function getStatusTimestamp(row, status) {
  const tone = getStatusTone(status);
  if (tone === "replied") return getReplyTime(row);
  if (tone === "delivered" || tone === "failed") {
    return displayDate(row.statusUpdatedAt || row.updatedAt || row.receivedAt || row.requestedAt);
  }
  return displayDate(row.requestedAt || row.sentAt || row.statusUpdatedAt || row.receivedAt);
}

function buildStatusLineHtml(label, status, timestamp) {
  const tone = getStatusTone(status || label);
  const timeText = timestamp && timestamp !== "-" ? ` at ${timestamp}` : "";
  return `<div class="status-line status-line-${tone}"><span>${escapeHtml(label)}</span>${escapeHtml(timeText)}</div>`;
}

function buildDeliveryStatusHtml(row) {
  const sentStatus = getSentDeliveryStatus(row) || "-";
  const receivedStatus = getReceivedDeliveryStatus(row) || "-";
  const lines = [];
  const sentTime = displayDate(row.requestedAt || row.sentAt || row.receivedAt || row.statusUpdatedAt);
  const deliveryTime = getStatusTimestamp(row, sentStatus);

  lines.push(buildStatusLineHtml("Sent", "sent", sentTime));
  if (sentStatus !== "-" && getStatusTone(sentStatus) !== "sent") {
    const label = getStatusTone(sentStatus) === "failed" ? "Failed" : "Delivered";
    lines.push(buildStatusLineHtml(label, sentStatus, deliveryTime));
  } else if (sentStatus === "-") {
    lines.push(buildStatusLineHtml("Delivery pending", "pending", ""));
  }
  if (receivedStatus !== "-") {
    lines.push(buildStatusLineHtml("Customer replied", "replied", getReplyTime(row)));
  }

  return `
    <div class="stacked-cell status-stack">
      ${lines.join("")}
    </div>
  `;
}

function buildMessageSummaryHtml(sentMessageText, receivedMessageHtml) {
  const hasReceivedMessage = receivedMessageHtml && receivedMessageHtml !== "-";
  return `
    <div class="message-summary-cell">
      <div class="message-part message-part-sent"><span>Sent:</span> ${escapeHtml(sentMessageText || "-")}</div>
      <div class="message-part ${hasReceivedMessage ? "message-part-received" : "message-part-pending"}"><span>Received:</span> ${receivedMessageHtml || "-"}</div>
    </div>
  `;
}

function getCustomerKey(row) {
  return String(
    row.normalizedMobile ||
      row.mobile ||
      row.customerNumber ||
      row.to ||
      row.phone ||
      "",
  ).trim();
}

function formatPercent(value, total) {
  if (!total) return "0%";
  const percent = (value / total) * 100;
  return `${percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function renderCustomSummary(rows) {
  // Outbound rows are the actual dispatched communications. Inbound rows are
  // the investor's replies to those communications - a separate dimension -
  // so they're excluded from the outbound status buckets below to avoid
  // double-counting the same investor interaction in two cards.
  const outboundRows = rows.filter((row) => row.eventType !== "inbound");
  const uniqueCustomers = new Set(
    outboundRows.map(getCustomerKey).filter(Boolean),
  );
  const repliedRows = rows.filter(
    (row) => row.eventType === "inbound" || row.customReply || row.lastReplyAt,
  );

  const getStatusKey = (row) =>
    String(
      row.normalizedStatus || row.deliveryStatus || row.numberDeliveryStatus || "",
    ).toLowerCase();

  const isDelivered = (row) => {
    const status = getStatusKey(row);
    return status.includes("deliver") || status.includes("read") || status.includes("success");
  };

  const isFailed = (row) => {
    const status = getStatusKey(row);
    return (
      status.includes("fail") ||
      status.includes("deny") ||
      status.includes("rejected") ||
      status.includes("undelivered") ||
      status.includes("error")
    );
  };

  const delivered = outboundRows.filter(isDelivered).length;
  const failed = outboundRows.filter(isFailed).length;
  // Everything outbound that is neither a confirmed delivery nor a confirmed
  // failure - covers "sent"/"queued"/blank status - so Delivered + Pending +
  // Failed always reconciles exactly to Total Communication Events.
  const pending = outboundRows.length - delivered - failed;

  const counts = {
    total: outboundRows.length,
    uniqueCustomers: uniqueCustomers.size,
    replyEvents: repliedRows.length,
    delivered,
    pending,
    failed,
  };

  const cards = [
    {
      label: "Total Communication Events",
      value: counts.total,
      note: "Dispatched messages tracked in this view (Delivered + Pending + Failed).",
    },
    {
      label: "Investors Communicated To",
      value: counts.uniqueCustomers,
      note: "Unique investor mobile numbers that received a communication in this view.",
    },
    {
      label: "Successfully Delivered to Investor",
      value: counts.delivered,
      note: "Communications confirmed delivered, read, or success by MSG91.",
      tone: "good",
    },
    {
      label: "Investor Acknowledgements",
      value: counts.replyEvents,
      note: "Communications with an inbound investor reply as evidence of acknowledgement.",
      tone: "reply",
    },
    {
      label: "Pending Delivery Confirmation",
      value: counts.pending,
      note: "Dispatched to MSG91, awaiting a delivered/read/failed callback.",
      tone: "pending",
    },
    {
      label: "Delivery Failed - Action Required",
      value: counts.failed,
      note: "Communications MSG91 reported as failed, rejected, denied, or undelivered.",
      tone: "bad",
    },
  ];

  customReportSummaryGrid.innerHTML = cards
    .map(
      (card) =>
        `<div class="summary-item summary-item-${escapeHtml(card.tone || "neutral")}">
          <div class="summary-label">${escapeHtml(card.label)}</div>
          <strong>${escapeHtml(String(card.value))}</strong>
          <p>${escapeHtml(card.note)}</p>
        </div>`,
    )
    .join("");
}

async function refreshCustomReport() {
  if (customReportRefreshInProgress) return;
  customReportRefreshInProgress = true;
  try {
    await _doRefreshCustomReport();
  } finally {
    customReportRefreshInProgress = false;
  }
}

async function _doRefreshCustomReport() {
  if (customScope.value === "selected" && !selectedUploadId) {
    lastCustomReportRows = [];
    customReportSummary.textContent =
      "Select an upload first to create a selected-upload report.";
    renderCustomSummary([]);
    customReportTableBody.innerHTML = "";
    return;
  }

  const rows = await window.electronAPI.fetchCustomReport(
    getCustomReportFilters(),
  );
  lastCustomReportRows = rows;
  const scopeText =
    customScope.value === "selected"
      ? "the selected upload report"
      : "the transaction compliance report";
  const dateText =
    customStartDateTime.value && customEndDateTime.value
      ? ` from ${new Date(customStartDateTime.value).toLocaleDateString("en-IN", { timeZone: "Asia/Calcutta" })} to ${new Date(customEndDateTime.value).toLocaleDateString("en-IN", { timeZone: "Asia/Calcutta" })}`
      : "";
  const activeFilterText = [
    customEventType.value !== "all"
      ? `type ${customEventType.options[customEventType.selectedIndex]?.textContent || customEventType.value}`
      : "",
    customStatus.value !== "all"
      ? `status ${customStatus.options[customStatus.selectedIndex]?.textContent || customStatus.value}`
      : "",
    customSearch.value.trim() ? `search "${customSearch.value.trim()}"` : "",
  ]
    .filter(Boolean)
    .join(", ");
  customReportSummary.textContent = rows.length
    ? `${rows.length} records found for ${scopeText}${dateText}.`
    : `No records found for ${scopeText}${dateText}${activeFilterText ? ` with ${activeFilterText}` : ""}. Try All types and All statuses to see sent transactions.`;
  renderCustomSummary(rows);
  customReportTableBody.innerHTML = "";

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    const templateOrCampaign =
      [row.templateName, row.campaignName].filter(Boolean).join(" / ") || "-";
    tr.dataset.reportIndex = String(index);
    const readableText = getMessageText(row) || "-";
    const dynamicText = getDynamicResponse(row) || "-";
    const payloadPresent = isJsonLike(row.rawPayload);
    const readableIsJson = payloadPresent || isJsonLike(readableText);
    const dynamicIsJson = payloadPresent || isJsonLike(dynamicText);
    const reasonText = String(
      row.reason || row.cleverTapErrorReason || "",
    ).toLowerCase();
    const isDenied = reasonText === "deny";

    // Denied flow replies are individual inbound events; show only this event's reply text here.
    let dynamicCellHtml = "";
    if (isDenied) {
      dynamicCellHtml = escapeHtml(
        readableText || row.text || row.customReply || "-",
      );
    } else if (dynamicIsJson) {
      dynamicCellHtml = `<button type="button" class="json-view-button small-button" data-report-index="${index}" data-tooltip="View JSON">View JSON</button>`;
    } else {
      dynamicCellHtml = escapeHtml(dynamicText || "-");
    }

    const eventKey = String(row.id || row.eventId || row._id || index);
    tr.dataset.eventId = eventKey;
    tr.dataset.reportIndex = String(index);

    // Build readable cell: remove button for readable JSON, only show truncated text
    const readableCellHtml = readableIsJson
      ? `<div class="readable-cell"><div class="small-note">${escapeHtml(truncateText(readableText))}</div></div>`
      : escapeHtml(readableText);

    // Append updatedAt info to reason if present
    const reasonBase = escapeHtml(
      row.reason || row.cleverTapErrorReason || "-",
    );
    const updatedNote = row.updatedAt
      ? `<div class="small-note">Updated: ${escapeHtml(displayDate(row.updatedAt))}</div>`
      : "";

    // Generate SaaS Badge structures
    const typeClass =
      row.eventType === "inbound" ? "event-inbound" : "event-outbound";
    const typeLabel = row.eventType === "inbound" ? "Reply event" : "Sent record";
    const typeHtml = `<span class="${typeClass}">${typeLabel}</span>`;

    const friendlyStatus = getFriendlyStatus(row);
    let statusClass = "badge-pending";
    if (friendlyStatus === "Customer replied") statusClass = "badge-replied";
    else if (friendlyStatus === "Delivered / read")
      statusClass = "badge-delivered";
    else if (friendlyStatus === "Failed") statusClass = "badge-failed";
    else if (friendlyStatus === "Sent to MSG91" || friendlyStatus === "sent")
      statusClass = "badge-sent";
    const statusHtml = `<span class="badge ${statusClass}">${escapeHtml(friendlyStatus)}</span>`;

    const mobileHtml = `<span class="mobile-pill">${escapeHtml(row.normalizedMobile || row.customerNumber || "-")}</span>`;
    const templateHtml =
      templateOrCampaign !== "-"
        ? `<span class="template-tag">${escapeHtml(templateOrCampaign)}</span>`
        : "-";

    // Extract Sender Number and look up friendly RM label
    const senderNumber = row.integratedNumber || row.integrated_number || "";
    let senderLabel = senderNumber;
    if (senderNumber && msg91Config?.integratedNumbers) {
      const matchRM = msg91Config.integratedNumbers.find(
        (n) =>
          String(n.number) === String(senderNumber) ||
          String(n.id) === String(senderNumber),
      );
      if (matchRM) {
        senderLabel = matchRM.label || matchRM.number;
      }
    }
    const senderHtml = senderLabel
      ? `<span class="badge badge-sent" style="font-size: 11px; padding: 2px 8px;">${escapeHtml(senderLabel)}</span>`
      : `<span class="small-note">-</span>`;

    const customerReplyHtml = formatReplyHistoryHtml(row);
    const replyTimeText = getReplyTime(row);
    const sentMessageText = getSentMessage(row);
    const receivedMessageHtml =
      customerReplyHtml && customerReplyHtml !== "-"
        ? customerReplyHtml
        : row.eventType === "inbound"
          ? escapeHtml(readableText || row.text || row.customReply || "-")
          : "-";
    const messageSummaryHtml = buildMessageSummaryHtml(
      sentMessageText,
      receivedMessageHtml,
    );

    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${escapeHtml(displayDate(row.receivedAt || row.statusUpdatedAt || row.requestedAt))}</td>
      <td style="font-weight: 600; color: var(--text-primary);">${escapeHtml(getCustomerName(row))}</td>
      <td>${mobileHtml}</td>
      <td>${senderHtml}</td>
      <td class="delivery-summary-cell">${buildDeliveryStatusHtml(row)}</td>
      <td>${messageSummaryHtml}</td>
      <td>${typeHtml}</td>
      <td class="status-cell">${statusHtml}</td>
      <td class="status-detail-cell">${escapeHtml(getMatchedMessageStatus(row))}</td>
      <td>${escapeHtml(row.uploadFileName || "-")}</td>
      <td class="reply-time-cell" style="white-space:nowrap;">${escapeHtml(replyTimeText)}</td>
      <td>${templateHtml}</td>
      <td>${dynamicCellHtml}</td>
      <td>${reasonBase}${updatedNote}</td>
    `;

    // If a row for this event already exists in the table, replace its contents; otherwise append
    const existing = customReportTableBody.querySelector(
      `tr[data-event-id="${eventKey}"]`,
    );
    if (existing) {
      existing.innerHTML = tr.innerHTML;
      existing.dataset.reportIndex = String(index);
    } else {
      customReportTableBody.appendChild(tr);
    }
  });

}

// Help button for Custom Report header
const customReportHelpBtn = document.getElementById("customReportHelp");
if (customReportHelpBtn) {
  customReportHelpBtn.addEventListener("click", () => {
    showAlert(
      "Selected upload report uses the same fast matched rows as Uploads & Batches. All transactions + webhook events scans sender reports and raw webhook events for admin reporting.",
      "info",
      10000,
    );
  });
}

previewTableBody.addEventListener("click", (event) => {
  const button = event.target.closest(".json-view-button");
  if (!button) return;
  const rowIndex = Number(button.dataset.rowIndex);
  const tableType = button.dataset.tableType;
  let payload = {};
  if (tableType === "preview" && lastPreviewRows[rowIndex]) {
    payload = parseStoredRowData(lastPreviewRows[rowIndex]);
  }
  if (payload && Object.keys(payload).length > 0) {
    showJsonModal(payload);
  }
});

if (validationLists) {
  validationLists.addEventListener("click", (event) => {
    const button = event.target.closest(".json-view-button");
    if (!button) return;
    const rowIndex = Number(button.dataset.rowIndex);
    const tableType = button.dataset.tableType;
    let payload = {};
    if (tableType === "preview" && lastPreviewRows[rowIndex]) {
      payload = parseStoredRowData(lastPreviewRows[rowIndex]);
    }
    if (payload && Object.keys(payload).length > 0) {
      showJsonModal(payload);
    }
  });
}

reportTableBody.addEventListener("click", (event) => {
  const button = event.target.closest(".json-view-button");
  if (!button) return;
  const rowIndex = Number(button.dataset.rowIndex);
  const tableType = button.dataset.tableType;
  let payload = {};
  if (tableType === "report" && lastReportRows[rowIndex]) {
    const rawValue = formatJsonBlock(lastReportRows[rowIndex].responseDetails);
    if (typeof rawValue === "string") {
      try {
        payload = JSON.parse(rawValue || "{}");
      } catch (err) {
        payload = rawValue;
      }
    } else {
      payload = rawValue;
    }
  } else if (tableType === "inbound" && lastInboundRows[rowIndex]) {
    payload = lastInboundRows[rowIndex].rawPayload || {};
  }
  if (payload !== undefined && payload !== null) {
    showJsonModal(payload);
  }
});

customReportTableBody.addEventListener("click", (event) => {
  const button = event.target.closest(".json-view-button");
  if (!button) return;
  const reportIndex = Number(button.dataset.reportIndex);
  const row = lastCustomReportRows[reportIndex];
  if (!row) return;
  showJsonModal(row.rawPayload || {});
});

function showJsonModal(payload) {
  const content = document.getElementById("jsonModalContent");
  const backdrop = document.getElementById("jsonModalBackdrop");
  if (!content || !backdrop) return;

  if (typeof payload === "string") {
    content.textContent = payload || "No JSON data available.";
  } else if (payload && Object.keys(payload).length > 0) {
    content.textContent = JSON.stringify(payload, null, 2);
  } else {
    content.textContent = "No JSON data available.";
  }

  backdrop.classList.add("show");
}

function hideJsonModal() {
  const backdrop = document.getElementById("jsonModalBackdrop");
  if (!backdrop) return;
  backdrop.classList.remove("show");
}

function csvValue(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportCustomReportPdf() {
  if (!lastCustomReportRows.length) {
    showAlert("No custom report rows to export.", "warning");
    return;
  }

  try {
    const result = await window.electronAPI.exportCustomReport(
      getCustomReportFilters(),
    );
    showAlert(
      `Webhook PDF report exported with ${result.rowCount} rows:\n${result.filePath}`,
      "success",
    );
  } catch (err) {
    showAlert(`Export failed: ${err.message}`, "error");
  }
}

async function initWebhookInfo() {
  const url = await window.electronAPI.getWebhookUrl();
  webhookInfo.textContent = `Webhook endpoint: ${url}`;
}

function attachJsonModalEvents() {
  const backdrop = document.getElementById("jsonModalBackdrop");
  const closeButton = document.getElementById("jsonModalClose");
  if (!backdrop || !closeButton) return;
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) hideJsonModal();
  });
  closeButton.addEventListener("click", hideJsonModal);
}

initWebhookInfo();
attachJsonModalEvents();
loadMsg91Config().then(() => {
  refreshDashboard();
  setInterval(refreshDashboard, 10000);
});

