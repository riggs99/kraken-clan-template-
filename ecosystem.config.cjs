// cwd is derived from this file's own location (__dirname), not hardcoded —
// this file previously pinned a specific machine's absolute path, which broke
// the moment this project was cloned/relocated anywhere else. `env` also used
// to carry two duplicate, misplaced `cwd` keys (that field means nothing
// inside `env`; pm2's real cwd is the top-level one above) — removed rather
// than fixed forward, since nothing ever read them.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'kraken',
      script: 'src/index.js',
      cwd: __dirname,
      interpreter: 'node',

      autorestart: true,
      watch: false,
      time: true,

      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '350M',

      env: {
        DOTENV_CONFIG_QUIET: 'true',
        NODE_ENV: 'production',
        DOTENV_PATH: path.join(__dirname, '.env'),
      },
    },
  ],
};




