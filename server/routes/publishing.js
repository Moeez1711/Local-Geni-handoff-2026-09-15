import { Router } from 'express';
import { getPublishingStatus,configurePublishing,verifyPublishing,syncPublicOptOuts } from '../publicPublishing.js';
export const publishingRouter=Router();
publishingRouter.get('/status',(req,res)=>res.json(getPublishingStatus()));
publishingRouter.put('/settings',async(req,res)=>res.json(await configurePublishing(req.body)));
publishingRouter.post('/verify',async(req,res)=>res.json(await verifyPublishing()));
publishingRouter.post('/sync',async(req,res)=>res.json(await syncPublicOptOuts()));
publishingRouter.use((error,req,res,next)=>{res.status(error.status||500).json({code:error.code||'PUBLISHING_ERROR',error:error.status?error.message:'The unsubscribe service could not complete this request.'});});
export default publishingRouter;
