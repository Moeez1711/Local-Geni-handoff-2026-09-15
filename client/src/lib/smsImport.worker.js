import { readRecipientFile } from './smsImport.js';
self.onmessage = async ({ data }) => {
  try { self.postMessage({ sheets: await readRecipientFile(data) }); }
  catch (error) { self.postMessage({ error: error.message || 'This file could not be read.' }); }
};
