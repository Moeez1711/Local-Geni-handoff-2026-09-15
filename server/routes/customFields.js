import { Router } from 'express';
import { customFieldsService } from '../customFields.js';

const pass=(req,res,next) => next();
export function createCustomFieldsRouter({service=customFieldsService,canManage=pass,canEdit=pass}={}) {
  const router=Router();
  router.use((req,res,next) => {res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});next();});
  router.get('/leads/:placeId',(req,res) => res.json(service.getValues(req.params.placeId)));
  router.put('/leads/:placeId',canEdit,(req,res) => res.json(service.saveValues(req.params.placeId,req.body)));
  router.get('/',(req,res) => res.json(service.list(req.query)));
  router.post('/',canManage,(req,res) => res.status(201).json(service.create(req.body)));
  router.patch('/:id',canManage,(req,res) => res.json(service.update(req.params.id,req.body)));
  router.post('/:id/archive',canManage,(req,res) => res.json(service.archive(req.params.id,req.body)));
  router.post('/:id/restore',canManage,(req,res) => res.json(service.restore(req.params.id,req.body)));
  router.use((err,req,res,next) => res.status(err.customFieldsSafe ? err.status : 500).json({error:err.customFieldsSafe ? err.message : 'The custom fields could not be saved. Reload before trying again.',code:err.customFieldsSafe ? err.code : 'CUSTOM_FIELDS_FAILED'}));
  return router;
}
export default createCustomFieldsRouter();
