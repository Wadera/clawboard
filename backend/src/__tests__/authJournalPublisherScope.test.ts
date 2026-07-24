describe('journal publisher credential scope',()=>{
 beforeEach(()=>{jest.resetModules();process.env.JWT_SECRET='test-secret';process.env.CLAWBOARD_JOURNAL_PUBLISH_API_KEY='journal-only-secret';});
 async function invoke(path:string,method:string,baseUrl=''){
  const {authMiddleware}=await import('../middleware/auth');const req:any={baseUrl,path,method,headers:{'x-journal-publish-key':'journal-only-secret'}};let status=200;let next=false;
  const res:any={status:(s:number)=>{status=s;return res},json:()=>res};authMiddleware(req,res,()=>{next=true});return{status,next,userId:req.userId};
 }
 it('accepts only scoped publication paths',async()=>{
  const key='a'.repeat(32);expect((await invoke(`/hermes-runs/${key}/publish`,'POST','/journal'))).toMatchObject({status:200,next:true,userId:'journal_publisher'});
  expect((await invoke('/journal/11111111-1111-4111-8111-111111111111','PUT'))).toMatchObject({status:403,next:false});
  expect((await invoke('/tasks','POST'))).toMatchObject({status:403,next:false});
 });
});
