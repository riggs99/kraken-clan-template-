import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

let loaded = false;

export function loadEnv() {
  if (loaded) return;

  const explicit = process.env.DOTENV_PATH;
  const defaultPath = path.join(process.cwd(), '.env');
  const envPath = explicit ?? defaultPath;

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
    loaded = true;
    return;
  }

  if (explicit && fs.existsSync(defaultPath)) {
    dotenv.config({ path: defaultPath, quiet: true });
    loaded = true;
    return;
  }

  console.warn('  .env not found at: ' + envPath);
}

