// Removes the dashboard login (email + password) and ends all sessions.
// Run with the app stopped:  npm run reset-login
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const db = new DatabaseSync(config.dbPath);
try { db.prepare(`DELETE FROM settings WHERE key='auth'`).run(); } catch { /* settings table not created yet */ }
try { db.exec('DELETE FROM sessions'); } catch { /* sessions table not created yet */ }
db.close();
console.log('Login removed. Start the app (npm run dev) and set a new email and password on the Privacy page.');
