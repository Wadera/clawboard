import { Router, Request, Response } from 'express';
import { journalPublicationService, JournalPublicationError } from '../services/JournalPublicationService';

const router=Router();
router.get('/:key/:kind',async(req:Request,res:Response)=>{
 try{
  if(req.params.kind!=='image'&&req.params.kind!=='audio'){res.status(404).end();return}
  const media=await journalPublicationService.readPublishedMedia(req.params.key,req.params.kind);
  res.setHeader('Content-Type',media.contentType);
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.send(media.bytes);
 }catch(e){const status=e instanceof JournalPublicationError?e.status:500;res.status(status).json({success:false,error:e instanceof Error?e.message:'media unavailable'})}
});
export default router;
