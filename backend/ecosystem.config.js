module.exports = {
  apps: [
    {
      name: "webhook-msg91-backend",

      script: "webhook-server.js",

      cwd: "/home/ubuntu/webhook-msg91/backend",

      instances: 1,
      exec_mode: "fork",

      autorestart: true,
      watch: false,

      max_memory_restart: "512M",

      min_uptime: "10s",
      max_restarts: 10,

      restart_delay: 5000,

      kill_timeout: 5000,
      listen_timeout: 8000,

      node_args: "--max-old-space-size=512",

      merge_logs: true,
      time: true,

      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      out_file: "/home/ubuntu/logs/msg91-webhook-out.log",
      error_file: "/home/ubuntu/logs/msg91-webhook-error.log",

      env: {
        NODE_ENV: "development",
        PORT: 3002,
        WEBHOOK_HOST: "127.0.0.1",
      },

      env_production: {
        NODE_ENV: "production",
        PORT: 3002,
        WEBHOOK_HOST: process.env.WEBHOOK_HOST || "0.0.0.0",
        WEBHOOK_PUBLIC_BASE_URL: process.env.WEBHOOK_PUBLIC_BASE_URL || "https://crm.ipkwealth.com",
        WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
        MSG91_WEBHOOK_SECRET: process.env.MSG91_WEBHOOK_SECRET,
        MSG91_SIGNATURE_SECRET: process.env.MSG91_SIGNATURE_SECRET,
        MSG91_WEBHOOK_SIGNATURE_SECRET: process.env.MSG91_WEBHOOK_SIGNATURE_SECRET,
        MSG91_WEBHOOK_SIGNATURE_HEADER: process.env.MSG91_WEBHOOK_SIGNATURE_HEADER,
        MSG91_IP_WHITELIST: process.env.MSG91_IP_WHITELIST,
        WEBHOOK_TRUSTED_IPS: process.env.WEBHOOK_TRUSTED_IPS,

        // MongoDB
        MONGODB_URI: process.env.MONGODB_URI,

        // SMTP
        SMTP_HOST: process.env.SMTP_HOST,
        SMTP_PORT: process.env.SMTP_PORT,
        SMTP_USER: process.env.SMTP_USER,
        SMTP_PASS: process.env.SMTP_PASS,

        // MSG91
        MSG91_AUTHKEY: process.env.MSG91_AUTHKEY,

        // Redis
        REDIS_HOST: process.env.REDIS_HOST,
        REDIS_PORT: process.env.REDIS_PORT,

        // Optional
        LOG_LEVEL: "info",
      },
    },
  ],
};
