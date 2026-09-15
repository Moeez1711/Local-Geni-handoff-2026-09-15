/** Local encrypted secrets, kept outside the generic application settings endpoint. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';

db.exec('CREATE TABLE IF NOT EXISTS email_private_secrets (name TEXT PRIMARY KEY, encrypted_value TEXT NOT NULL)');
const unavailable = () => Object.assign(new Error('Email credentials could not be unlocked. Reconnect the account.'), { status: 409, code: 'EMAIL_KEY_UNAVAILABLE' });

const memoryKey = crypto.randomBytes(32);
export function createEmailVault({ keyProvider, keyPath: explicitKeyPath } = {}) {
  const memoryOnly = config.dbPath === ':memory:' && explicitKeyPath === undefined;
  const keyPath = explicitKeyPath || process.env.EMAIL_KEY_PATH || path.join(path.dirname(config.dbPath), 'email.key');
  function key(create = false) {
    if (keyProvider) {
      const value = keyProvider();
      if (!Buffer.isBuffer(value) || value.length !== 32) throw unavailable();
      return value;
    }
    if (memoryOnly) return memoryKey;
    try {
      if (!fs.existsSync(keyPath)) {
        if (!create) throw unavailable();
        fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
        try { fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      const stat = fs.lstatSync(keyPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw unavailable();
      const value = fs.readFileSync(keyPath);
      if (value.length !== 32) throw unavailable();
      return value;
    } catch { throw unavailable(); }
  }
  function seal(value, context = 'account') {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(true), iv);
    cipher.setAAD(Buffer.from(`local-geni-email:v1:${context}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [1, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }
  function open(envelope, context = 'account') {
    if (!envelope) return null;
    try {
      const [version, iv, tag, ciphertext] = envelope.split('.');
      if (version !== '1') throw unavailable();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(`local-geni-email:v1:${context}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
    } catch { throw unavailable(); }
  }
  const validateName = (name) => { if (typeof name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(name)) throw new Error('Invalid secret name'); };
  return {
    seal, open,
    get(name) { validateName(name); return open(db.prepare('SELECT encrypted_value FROM email_private_secrets WHERE name=?').get(name)?.encrypted_value, name); },
    set(name, value) { validateName(name); db.prepare('INSERT INTO email_private_secrets (name,encrypted_value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET encrypted_value=excluded.encrypted_value').run(name, seal(value, name)); },
    delete(name) { validateName(name); db.prepare('DELETE FROM email_private_secrets WHERE name=?').run(name); },
  };
}
const vault = createEmailVault();
export const getPrivateSecret = (name) => vault.get(name);
export const setPrivateSecret = (name, value) => vault.set(name, value);
export const deletePrivateSecret = (name) => vault.delete(name);
