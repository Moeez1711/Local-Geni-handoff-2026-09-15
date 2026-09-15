import {Router} from 'express';
import {getQaStatus,saveQaSettings,runQaChecks} from '../qaAgent.js';
const router=Router();
router.get('/status',(req,res)=>res.json(getQaStatus()));
router.put('/settings',(req,res)=>{try{res.json(saveQaSettings(req.body));}catch(e){res.status(400).json({error:e.message});}});
router.post('/run',(req,res)=>res.status(202).json(runQaChecks()));
export default router;
