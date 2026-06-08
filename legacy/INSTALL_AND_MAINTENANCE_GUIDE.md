# WhatsApp Bulk Sender: Production Install & System Maintenance Guide

This document provides complete instructions on how to install the WhatsApp Bulk Sender application, configure it for production, manage Relationship Managers (RMs) or departments, and maintain scheduled background reporting.

---

## 1. Installation Guide

Once the installer is generated (using `npm run release` or `npm run dist:win`), follow these steps to install it on a Windows machine:

1. **Run the Installer**:
   - Double-click the generated setup executable: `WhatsApp Bulk Sender Setup 1.0.0.exe`.
   - If prompted by Windows Defender SmartScreen ("Windows protected your PC"), click **More info** and select **Run anyway**.
2. **Setup Wizards**:
   - Select whether to install for **All Users** (requires admin permissions) or **Only Me**.
   - Choose the target destination directory (default: `C:\Program Files\WhatsApp Bulk Sender`).
   - Click **Install** and then **Finish**.
3. **Tray Execution**:
   - The application will launch and minimize automatically to the Windows system tray (bottom-right corner, next to the clock).
   - Right-click the tray icon to quick-open the Dashboard, check service endpoints, or exit.
   - Closing the dashboard window does **not** close the application; it continues to run in the background to handle MSG91 webhooks and scheduled tasks.

---

## 2. System Configuration (`.env` File)

The application relies on a `.env` file located in the application root directory (where the executable runs, or inside the project workspace directory) to connect to MongoDB, communicate with MSG91, and route emails.

Ensure the following variables are correctly configured:

```ini
# MongoDB Connection parameters
DATABASE_URL="mongodb://..."
MONGODB_DB_NAME="ipkwealth_crm_test"

# Webhook Base Endpoint (MUST be a public HTTPS domain for MSG91 to match webhooks)
WEBHOOK_PUBLIC_BASE_URL="https://crm.ipkwealth.com"
WEBHOOK_PORT=3002
WEBHOOK_HOST="0.0.0.0"

# MSG91 Auth parameters
MSG91_AUTH_KEY="your-msg91-auth-key"
MSG91_TEMPLATE_NAMESPACE="your-template-namespace"

# Node-mailer SMTP Configuration (Email Delivery Server)
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_USER="software@ipkwealth.com"
SMTP_PASS="your-app-password" # For Gmail, use a 16-character App Password

# Admin Mailing Distribution Lists (Multiple emails must be separated by commas)
ADMIN_EMAILS_TO="prabhukumarasamy@ipkwealth.com"
ADMIN_EMAILS_BCC="dhinakaran@ipkwealth.com,vijaytp@ipkwealth.com"
ADMIN_EMAILS_CC_SALES1="bharath@ipkwealth.com"
ADMIN_EMAILS_CC_SALES2="another@ipkwealth.com"
```

---

## 3. Maintenance: Adding RMs & Departments (`msg91.config.json`)

To add new Relationship Managers, Operational teams, support branches, or Analyst roles, edit the `msg91.config.json` file in the application directory. 

### Structure of `msg91.config.json`
Configure the `integratedNumbers` array. You can define as many numbers as needed. You can also specify an optional `"email"` field for each sender to route their grouped reports automatically:

```json
{
  "authKey": "${MSG91_AUTH_KEY}",
  "namespace": "${MSG91_TEMPLATE_NAMESPACE}",
  "integratedNumbers": [
    {
      "id": "client-919363406313",
      "number": "919363406313",
      "label": "919363406313 - RM-General",
      "email": "rmgeneral@ipkwealth.com"
    }
  ],
  "templates": []
}
```

### Adding a New Team Member
1. Open `msg91.config.json` in a text editor.
2. Add a new object inside `"integratedNumbers"` specifying their `id`, `number`, `label`, and `email`.
3. Restart the Bulk Sender application. The Dashboard and the live webhook logger will dynamically load the new RM and start routing reports and matches instantly.

---

## 4. Maintenance: 10:00 AM Scheduled Reporting

The application is engineered with a **zero-configuration background scheduler**:
- Upon first-time installation and boot, the application automatically registers a daily **10:00 AM** emailing scheduled task.
- **Reporting Period**: Every morning at 10:00 AM, the server compiles the transaction logs from **yesterday at 10:00 AM to today at 10:00 AM**.
- **Admin Delivery**: Admins automatically receive a multi-tab comprehensive Excel report. Each tab contains isolated transactions grouped by the configured RM labels. An extra `Other Event Logs` sheet is included to capture unassigned events.
- **RM Delivery**: Each configured RM receives an isolated single-tab Excel sheet representing their transactions only, CC'ing the Admin team. RMs cannot see other RMs' transactions.

### Running a Manual Force Export
If the Admin wants to force-run the daily delivery at any point:
1. Open the Bulk Sender Dashboard from the tray.
2. Navigate to the **Webhook Live** tab.
3. In the filters bar, click **Pick Range** if you want to inspect a custom range, or just click **Email Admin Report** to instantly mail the filtered set to the Administrators.
4. Click **Email RM Reports** to manually push isolated reports to RMs.
5. In the **Schedule Export** panel (accessible via *Schedule Export* button), click **Run Now** to test the complete, automated daily 10:00 AM mail-out package.

### Checking Server Log Files
If you encounter mailing or Mongo issues, inspect the running application console log or execute the log viewer in the project directory:
```bash
# View active background logs
npm run logs
```
Or check the system logs located in `C:\Users\ADMIN\\.gemini\\antigravity\\brain\\273db0a8-e185-44bd-bed3-0c0364901674\\.system_generated\\logs`.
