'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const script=fs.readFileSync(__dirname+'/aito.js','utf8');
const OMP='https://omp.uopes.cn/xcar/omp/xbs/account/', IVCS='https://apig.fgaiservice.com/vcam/v1/accounts/vehicles';
let store, notices, now, result;
function init(){store=new Map();notices=[];now=1700000000000;result=null;}
function run(type,request,response,panel,trigger) {
  let doneCount=0; result=null;
  const context={$script:{type},$request:request,$response:response,$input:{panelName:panel},$trigger:trigger,
    $done:x=>{doneCount++;result=x},$notification:{post:(...x)=>notices.push(x)},
    $persistentStore:{read:k=>store.has(k)?store.get(k):null,write:(v,k)=>{v===null?store.delete(k):store.set(k,v);return true}},
    Date:class extends Date{static now(){return now}},Math,Number,JSON,Array,Object,String};
  vm.runInNewContext(script,context,{timeout:500});assert.strictEqual(doneCount,1);now+=10;return result;
}
function header(x){return Object.entries(x||{}).map(([field,value])=>({field,value}))}
function req(id,url,body,headers,method='POST'){run('http-request',{id,url,method,body:JSON.stringify(body),headers:header(headers)})}
function resp(id,url,data,status=200,method='POST'){run('http-response',{id,url,method,headers:[]},{status,body:JSON.stringify(data)})}
function panel(name='AITO_Authorization'){return run('generic',undefined,undefined,name,'button')}
function complete(){
  req('A',OMP+'user/auth',{device:{id:'device-1'},authCode:'not-persisted'});
  resp('A',OMP+'user/auth',{resultCode:0,data:{sessionKey:'xid-1',userInfo:{userId:'user-1',sessionKeyStatus:0},oauthToken:{accessToken:'access-1',refreshToken:'refresh-1'}}});
  req('B',OMP+'vehicle/auth',{deviceInfo:{id:'device-1'}},{uid:'user-1',xid:'xid-1'});
  resp('B',OMP+'vehicle/auth',{resultCode:0,data:{vehicleTokenInfoList:[{accessToken:'vehicle-1',enterpriseCode:''}]}});
  req('C',IVCS,null,{Authorization:'vehicle-1','X-Device-Id':'ivcs-1'},'GET');
  resp('C',IVCS,[{}],200,'GET');
}
init(); complete(); now+=16000;
run('cron'); assert(notices.some(n=>n[2].includes('授权信息已找到')));
let r=panel();assert(r.content.includes('已暂停'));now+=16000;r=panel();assert.strictEqual(r.style,'good');
let notification=notices.find(n=>n[3]&&n[3].action==='clipboard'); assert(notification);
const json=JSON.parse(notification[3].text);assert.strictEqual(json.schema,1);assert.strictEqual(json.user_id,'user-1');
assert(!JSON.stringify([...store.values()]).includes('not-persisted'));assert(!notices.some(n=>n[2].includes('user-1')));
// Previously completed data are only discarded through the explicitly named reset panel.
const before=store.size; run('generic',undefined,undefined,'AITO_Reset','auto-interval');assert.strictEqual(store.size,before);
r=panel('AITO_Reset');assert(r.content.includes('再次点击'));assert(store.size>=before);
r=panel('AITO_Reset');assert(r.content.includes('已开始'));
// No candidate may be copied while the vehicle request has been rejected.
init();req('F',IVCS,null,{Authorization:'vehicle-1','X-Device-Id':'ivcs-1'},'GET');
resp('F',IVCS,{error:'denied'},401,'GET');assert(notices.some(n=>n[2].includes('错误')||n[2].includes('未完成')));
panel();now+=16000;r=panel();assert.strictEqual(r.style,'error');assert(!notices.some(n=>n[3]&&n[3].action==='clipboard'));
// Multiple successful user authorizations are ambiguous and cannot be copied.
init();complete();
req('D',OMP+'user/auth',{device:{id:'device-2'}});resp('D',OMP+'user/auth',{resultCode:0,data:{sessionKey:'xid-2',userInfo:{userId:'user-2',sessionKeyStatus:0},oauthToken:{accessToken:'access-2',refreshToken:'refresh-2'}}});
panel();now+=16000;r=panel();assert.strictEqual(r.style,'error');assert(!notices.some(n=>n[3]&&n[3].action==='clipboard'));
// A still-pending request must block copying after freeze.
init();complete();req('P',OMP+'user/refresh',{device:{id:'device-1'},rt:'old-refresh'},{uid:'user-1',xid:'xid-1'});panel();now+=16000;r=panel();assert.strictEqual(r.style,'error');
// A new request after freezing may rotate tokens, even if its body is ignored.
init();complete();panel();req('AFTER',OMP+'user/refresh',{device:{id:'device-1'},rt:'other'},{uid:'user-1',xid:'xid-1'});
now+=16000;r=panel();assert.strictEqual(r.style,'error');assert(!notices.some(n=>n[3]&&n[3].action==='clipboard'));
// account refresh + vehicle refresh are passively handled.
init();req('R1',OMP+'user/refresh',{device:{id:'device-1'},rt:'old-refresh'},{uid:'user-1',xid:'old-xid'});
resp('R1',OMP+'user/refresh',{resultCode:0,data:{sessionKey:'xid-1',userInfo:{userId:'user-1'},oauthToken:{accessToken:'access-1'}}});
req('R2',OMP+'vehicle/refresh',{deviceInfo:{id:'device-1'}},{uid:'user-1',xid:'xid-1',EC:'enterprise'});
resp('R2',OMP+'vehicle/refresh',{resultCode:0,data:{accessToken:'vehicle-1'}});
req('R3',IVCS,null,{Authorization:'vehicle-1','X-Device-Id':'ivcs-1'},'GET');resp('R3',IVCS,[{}],200,'GET');
panel();now+=16000;r=panel();assert.strictEqual(r.style,'good');
// A user auth status 1 may precede a later successful authorization.
init();req('DENIED',OMP+'user/auth',{device:{id:'device-1'}});resp('DENIED',OMP+'user/auth',{resultCode:0,data:{userInfo:{sessionKeyStatus:1}}});complete();
panel();now+=16000;r=panel();assert.strictEqual(r.style,'good');
// Empty vehicle list, malformed data and timed-out records do not export.
init();req('E',IVCS,null,{Authorization:'v','X-Device-Id':'d'},'GET');resp('E',IVCS,[],200,'GET');assert(store.get('aito_ui_v1_error'));
init();complete();now+=601000;panel();now+=16000;r=panel();assert.strictEqual(r.style,'error');
console.log('Surge native panel synthetic tests passed');
