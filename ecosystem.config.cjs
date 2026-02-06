module.exports = {
  apps: [
    {
      name: 'baileys-wa-server',
      script: './server-optimized.js',
      
      // ==================
      // Execution Mode
      // ==================
      instances: 1,
      exec_mode: 'fork',
      
      // ==================
      // Auto Restart
      // ==================
      watch: false,
      autorestart: true,
      max_restarts: 5,               // Reduced from 10
      min_uptime: '30s',             // Increased from 10s
      restart_delay: 5000,            // Increased from 4000
      listen_timeout: 15000,          // Increased from 10000
      kill_timeout: 8000,             // Increased from 5000
      
      // ==================
      // Memory Management
      // ==================
      max_memory_restart: '400M',     // Lowered from 500M for early intervention
      
      // ==================
      // Logging
      // ==================
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // ==================
      // Environment
      // ==================
      // env: {
      //   NODE_ENV: 'production',
      //   MAX_SESSIONS: '50'             // Prevent unbounded session creation
      // },
      
      // ==================
      // Advanced Options
      // ==================
      exp_backoff_restart_delay: 100,
      wait_ready: false,
      shutdown_with_message: true,
      
      // ==================
      // Node.js Specific
      // ==================
      node_args: '--max-old-space-size=512 --expose-gc',
      
      // ==================
      // Monitoring
      // ==================
      cron_restart: '0 2 * * *'        // Daily restart at 2 AM (optional)
    }
  ]
}
