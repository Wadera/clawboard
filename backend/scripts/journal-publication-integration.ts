import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { pool } from '../src/db/connection';
import { JournalPublicationService, JournalPublicationError } from '../src/services/JournalPublicationService';

async function main(){
 const [key1,key2]=process.env.TEST_RUN_KEYS!.split(',');
 const service=new JournalPublicationService('/clawd-media','/clawd-private-media','/test-runs');
 const before=(await pool.query('SELECT * FROM journal_entries WHERE id=$1',['d541297e-b350-457d-805a-2dcd1cc6967c'])).rows[0];
 const body1=await service.canonicalApprovalRequest(key1), body2=await service.canonicalApprovalRequest(key2);
 for(const badKey of (process.env.TEST_BAD_RUN_KEYS||'').split(',').filter(Boolean)){
  await assert.rejects(()=>service.canonicalApprovalRequest(badKey),/canonical|symlink|checksum|fingerprint/);
 }
 assert.equal((await service.approve(key1,'integration-human')).replay,false);
 assert.equal((await service.approve(key1,'integration-human')).replay,true);
 await service.approve(key2,'integration-human');
 const results=await Promise.allSettled([service.publish(key1),service.publish(key2)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1,'exactly one different-key publish must succeed');
 assert.equal(results.filter(x=>x.status==='rejected'&&x.reason instanceof JournalPublicationError&&x.reason.status===409).length,1,'loser must conflict');
 const winner=results[0].status==='fulfilled'?{key:key1,body:body1}:{key:key2,body:body2};
 assert.equal((await service.publish(winner.key)).replay,true,'same-key replay');
 const privateSong=await service.readPrivateSong(winner.key);assert(privateSong.bytes.length>1000,'private song must stream verified bytes');
 const publicImage=await service.readPublishedMedia(winner.key,'image');assert(publicImage.bytes.length>1000,'verified public image');
 const imageFile=path.join('/clawd-media',winner.body.media.image.path);const original=fs.readFileSync(imageFile);fs.writeFileSync(imageFile,Buffer.from('corrupt replacement'));
 await assert.rejects(()=>service.readPublishedMedia(winner.key,'image'),/checksum mismatch/);
 fs.writeFileSync(imageFile,original);
 const published=(await pool.query('SELECT * FROM journal_entries WHERE id=$1',[before.id])).rows[0];
 await pool.query("UPDATE journal_entries SET song_title='intervening edit' WHERE id=$1",[before.id]);
 await assert.rejects(()=>service.rollback(winner.key,winner.body.approval_fingerprint),/compare-and-swap/);
 await pool.query('UPDATE journal_entries SET song_title=$1 WHERE id=$2',[published.song_title,before.id]);
 assert.equal((await service.rollback(winner.key,winner.body.approval_fingerprint)).replay,false);
 assert.equal((await service.rollback(winner.key,winner.body.approval_fingerprint)).replay,true);
 const restored=(await pool.query('SELECT * FROM journal_entries WHERE id=$1',[before.id])).rows[0];
 for(const field of ['image_path','voice_path','song_path','song_url','song_title','entry_type','content_author'])assert.deepEqual(restored[field],before[field],`restore ${field}`);
 assert.deepEqual(restored.provenance,before.provenance,'restore provenance');
 const active=Number((await pool.query("SELECT count(*) FROM journal_run_publications WHERE entry_id=$1 AND state='published'",[before.id])).rows[0].count);assert.equal(active,0);
 console.log(JSON.stringify({integration:'PASS',different_key_conflict:true,same_key_replay:true,rollback_cas:true,full_restore:true}));
 await pool.end();
}
main().catch(async e=>{console.error(e);await pool.end();process.exit(1)});
