module.exports = {
  apps: [
    {
      name: 'baileys-wa-server',
      script: './server2.js',
      
      // Instance Configuration
      instances: 1,
      exec_mode: 'fork',
      
      // Auto Restart Configuration
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      
      // Memory & CPU Management
      max_memory_restart: '500M',
      kill_timeout: 5000,
      listen_timeout: 10000,
      
      // Logging
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Advanced Options
      exp_backoff_restart_delay: 100,
      wait_ready: true,
      shutdown_with_message: true,
      
      // Graceful Shutdown
      kill_timeout: 5000,
      
      // PM2 Plus (optional)
      // pmx: true,
      // instance_var: 'INSTANCE_ID'
    }
  ]
}
