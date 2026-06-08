const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  parseCsvFile: (filePath) => ipcRenderer.invoke("parse-csv-file", filePath),
  fetchUploads: () => ipcRenderer.invoke("fetch-uploads"),
  fetchReport: (uploadId) => ipcRenderer.invoke("fetch-report", uploadId),
  refreshUploadReport: (uploadId) => ipcRenderer.invoke("refresh-upload-report", uploadId),
  exportUploadReport: (uploadId) => ipcRenderer.invoke("export-upload-report", uploadId),
  fetchCustomReport: (filters) => ipcRenderer.invoke("fetch-custom-report", filters),
  fetchSenderStats: (filters) => ipcRenderer.invoke("fetch-sender-stats", filters),
  exportCustomReport: (filters) => ipcRenderer.invoke("export-custom-report", filters),
  scheduleSet: (cfg) => ipcRenderer.invoke("schedule-set", cfg),
  scheduleGet: () => ipcRenderer.invoke("schedule-get"),
  scheduleRunNow: () => ipcRenderer.invoke("schedule-run-now"),
  getMsg91Config: () => ipcRenderer.invoke("get-msg91-config"),
  sendMessages: (options) => ipcRenderer.invoke("send-messages", options),
  retryFailed: (uploadId) => ipcRenderer.invoke("retry-failed", uploadId),
  getWebhookUrl: () => ipcRenderer.invoke("get-webhook-url"),
  sendAdminReportEmail: (filters) => ipcRenderer.invoke("send-admin-report-email", filters),
  sendRmReports: (filters) => ipcRenderer.invoke("send-rm-reports", filters),
  clearAppCache: () => ipcRenderer.invoke("clear-app-cache"),
  onStateUpdated: (callback) => ipcRenderer.on("state-updated", (_event, payload) => callback(payload || {}))
});
