import { Router } from 'express';
import { getPolicyStatus, updateEmailPolicy, listSuppressions, addSuppression, removeSuppression } from '../emailPolicy.js';
import { getInfrastructureSettings, saveInfrastructureSettings, checkDomain, buildDnsPlan, generateDkim, setDkimEnabled, setVerifier, verifyRecipient } from '../emailInfrastructure.js';

// Mounted after the email router's origin/host guard and the existing authentication middleware.
const router = Router();
router.get('/policy', (req,res) => res.json(getPolicyStatus()));
router.put('/policy', (req,res) => res.json(updateEmailPolicy(req.body)));
router.get('/suppressions', (req,res) => res.json({rows:listSuppressions()}));
router.post('/suppressions', (req,res) => res.json(addSuppression(req.body)));
router.delete('/suppressions/:email', (req,res) => res.json(removeSuppression(req.params.email)));
router.get('/infrastructure', (req,res) => res.json(getInfrastructureSettings()));
router.put('/infrastructure', (req,res) => res.json(saveInfrastructureSettings(req.body)));
router.post('/domain/check', async (req,res) => res.json(await checkDomain(req.body)));
router.get('/domain/plan', (req,res) => res.json(buildDnsPlan()));
router.post('/dkim/generate', async (req,res) => res.json(await generateDkim(req.body)));
router.post('/dkim/enabled', async (req,res) => res.json(await setDkimEnabled(req.body?.enabled)));
router.put('/verifier', (req,res) => res.json(setVerifier(req.body)));
router.post('/verification', async (req,res) => res.json(await verifyRecipient(req.body)));
router.use((err,req,res,next) => { // Keep provider credentials and raw errors out of shared logs.
  const safe = Number(err.status) >= 400 && Number(err.status) < 500 && typeof err.code === 'string';
  res.status(safe ? err.status : 502).json({ error: safe ? err.message : 'This check could not be completed. Check your connection and try again.', code: safe ? err.code : 'EMAIL_CHECK_UNAVAILABLE' });
});
export default router;
