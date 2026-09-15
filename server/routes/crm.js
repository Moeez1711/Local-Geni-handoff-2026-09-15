import { Router } from 'express';
import { crmService, DEAL_STAGES } from '../crm.js';
export function createCrmRouter(service=crmService) {
  const router=Router();
  router.get('/meta',(req,res)=>res.json({stages:DEAL_STAGES.map(([id,label])=>({id,label})),currencies:['USD','CAD','GBP','EUR','AUD','NZD','PKR','AED','SAR','INR']}));
  router.get('/board',(req,res)=>res.json(service.board(req.query)));
  router.get('/leads/:placeId',(req,res)=>res.json(service.forLead(req.params.placeId)));
  router.get('/companies',(req,res)=>res.json(service.list('companies',req.query)));
  router.post('/companies',(req,res)=>res.status(201).json(service.createCompany(req.body,req.user)));
  router.post('/companies/bulk',(req,res)=>res.status(201).json(service.bulkCreateCompanies(req.body,req.user)));
  router.get('/companies/:id',(req,res)=>res.json(service.companyDetail(req.params.id)));
  for(const [path,kind] of [['contacts','contact'],['deals','deal']]) {
    router.get(`/${path}`,(req,res)=>res.json(service.list(path,req.query)));
    router.post(`/${path}`,(req,res)=>res.status(201).json(service[kind==='contact'?'saveContact':'saveDeal'](req.body,req.user)));
    router.get(`/${path}/:id`,(req,res)=>res.json(service[kind](req.params.id)));
    router.patch(`/${path}/:id`,(req,res)=>res.json(service[kind==='contact'?'saveContact':'saveDeal'](req.body,req.user,req.params.id)));
    router.post(`/${path}/:id/archive`,(req,res)=>res.json(service.archive(kind,req.params.id,req.body,req.user)));
    router.post(`/${path}/:id/restore`,(req,res)=>res.json(service.archive(kind,req.params.id,req.body,req.user,true)));
  }
  return router;
}
export default createCrmRouter();
