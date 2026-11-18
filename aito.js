/* Passive AITO collector and user-controlled Surge panels. No network calls. */
(function () {
  'use strict';
  const PREFIX = 'aito_ui_v1_', SLOTS = 2048, WAIT_MS = 15000, MAX_AGE_MS = 600000;
  const account = 'https://omp.uopes.cn/xcar/omp/xbs/account/';
  const vehicles = 'https://apig.fgaiservice.com/vcam/v1/accounts/vehicles';
  function read(k) { try { return $persistentStore.read(PREFIX + k); } catch (_) { return null; } }
  function write(k,v) { try { return $persistentStore.write(v,PREFIX + k) === true; } catch (_) { return false; } }
  function obj(x) { try { const a=JSON.parse(x); return a && typeof a==='object' && !Array.isArray(a)?a:null; } catch (_) { return null; } }
  function valid(x) { return typeof x==='string' && x.length>0 && x.length<=16384 && !/[\u0000-\u001f\u007f]/.test(x); }
  function status() { return obj(read('state')) || {phase:'idle'}; }
  function notify(title, body, options) { try { $notification.post('AITO',title,body,options); } catch (_) {} }
  function notifyOnce(key, body) { if (read(key)===null && write(key,'1')) notify('授权采集',body); }
  function fail(message) { write('error','1'); notifyOnce('notice_error', message || '采集未完成，请在面板检查。'); }
  function slot(id) { let h=2166136261; for(let i=0;i<id.length;i++){ h^=id.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0)%SLOTS; }
  function header(headers,name,allowEmpty) {
    const all=Array.isArray(headers)?headers:Object.keys(headers||{}).map(k=>({field:k,value:headers[k]}));
    const hits=all.filter(x=>x&&typeof x.field==='string'&&x.field.toLowerCase()===name.toLowerCase());
    if(hits.length!==1 || typeof hits[0].value!=='string' || hits[0].value.length>16384 || /[\u0000-\u001f\u007f]/.test(hits[0].value)) return null;
    return allowEmpty || valid(hits[0].value) ? hits[0].value : null;
  }
  function parse(raw) { return typeof raw==='string' && raw.length<=1048576 ? obj(raw) : null; }
  function ok(x) {
    if (!x || x.error || x.error_description) return false;
    for(const o of [x,x.data&&typeof x.data==='object'&&!Array.isArray(x.data)?x.data:{}]) {
      if (o.success===false) return false;
      for(const k of ['code','resultCode','errorCode','errCode']) if(k in o&&!['0','200'].includes(String(o[k]))) return false;
    }
    return true;
  }
  function vehiclesOK(raw) {
    let x; try { x=JSON.parse(raw); } catch (_) { return false; }
    const list=a=>Array.isArray(a)&&a.length>0&&a.every(v=>v&&typeof v==='object'&&!Array.isArray(v));
    if (list(x)) return true;
    if (!x || typeof x!=='object' || Array.isArray(x) || !ok(x)) return false;
    const c=['code','resultCode'].filter(k=>Object.prototype.hasOwnProperty.call(x,k));
    return c.length>0&&c.every(k=>['0','200'].includes(String(x[k])))&&list(x.data);
  }
  function scan() {
    const records=[];
    for(let i=0;i<SLOTS;i++) {
      const raw=read('slot_'+i);
      if(raw!==null) { const v=parse(raw); if(!v || typeof v.id!=='string') return {error:'采集记录无效'}; records.push(v); }
    }
    return {records};
  }
  function validate(records,now) {
    if(read('error')!==null) return {error:'采集中出现错误或槽位冲突，请重开一轮'};
    if(records.some(r=>r.stage==='pending')) return {error:'仍有请求未完成，请稍后重试'};
    const ua=records.filter(r=>r.stage==='ua'), va=records.filter(r=>r.stage==='va'), iv=records.filter(r=>r.stage==='ivcs');
    if(ua.length!==1||va.length!==1||iv.length===0) return {error:'信息不完整或存在多个账号会话'};
    const a=ua[0],b=va[0];
    if (![a.uid,a.xid,a.device,a.access,a.refresh,b.uid,b.xid,b.device,b.token].every(valid)) return {error:'缺少必要授权字段'};
    if(a.uid!==b.uid||a.xid!==b.xid||a.device!==b.device) return {error:'账号或会话不匹配'};
    if(typeof b.enterprise!=='string'||b.enterprise.length>16384||/[\u0000-\u001f\u007f]/.test(b.enterprise)) return {error:'企业代码无效'};
    if(![a.req_t,a.t,b.req_t,b.t].every(Number.isSafeInteger)||!(a.req_t<=a.t&&a.t<=b.req_t&&b.req_t<=b.t)) return {error:'授权顺序无法确认'};
    if(records.some(r=>r.stage==='denied'&&r.t>=a.req_t)) return {error:'存在后续登录，无法确认会话'};
    const rel=iv.filter(r=>Number.isSafeInteger(r.req_t)&&r.req_t>=a.req_t);
    if(!rel.length || rel.some(r=>!Number.isSafeInteger(r.t)||r.req_t>r.t||r.token!==b.token||!valid(r.device))) return {error:'车辆授权尚未确认'};
    if(rel.some(r=>r.device!==rel[0].device)||!rel.some(r=>r.req_t>=b.t)) return {error:'车辆设备或请求顺序不匹配'};
    const latest=Math.max(...rel.map(r=>r.t));
    if(now-a.req_t>MAX_AGE_MS || latest>now || now-latest<WAIT_MS) return {error:'采集已过期或请求尚未稳定'};
    return {value:{schema:1,omp_device_id:a.device,ivcs_device_id:rel[0].device,user_id:a.uid,session_key:a.xid,
      user_access_token:a.access,user_refresh_token:a.refresh,vehicle_access_token:b.token,enterprise_code:b.enterprise}};
  }
  function panel(content, style) { $done({title:'AITO 授权采集',content,style:style||'info'}); }
  function start() {
    const old=status();
    if(old.phase==='active') return panel('正在采集；请先在 AITO 授权面板点击刷新以暂停。','alert');
    if(old.phase==='frozen' && Date.now()-old.at<WAIT_MS) return panel('正在等待请求结束，请稍后再重置。','alert');
    const existing=scan(), now=Date.now(), confirmed=Number(read('reset_confirm'));
    if(existing.error||existing.records.length||read('error')!==null) {
      if(!Number.isSafeInteger(confirmed)||confirmed<=0||now-confirmed<0||now-confirmed>30000) {
        if(!write('reset_confirm',String(now))) return panel('无法准备清理确认。','error');
        return panel('此操作会清除本轮采集；如确定放弃，请在 30 秒内再次点击此面板刷新。','alert');
      }
    }
    for(let i=0;i<SLOTS;i++) if(!write('slot_'+i,null)) return panel('清理失败，未开始新一轮。','error');
    for(const key of ['error','notice_error','notice_panel_error','notice_partial','notice_candidate','notice_wait','reset_confirm']) if(!write(key,null)) return panel('清理失败，未开始新一轮。','error');
    if(!write('state',JSON.stringify({phase:'active',at:Date.now()}))) return panel('无法启动采集。','error');
    return panel('新一轮采集已开始，可正常使用 AITO App。');
  }
  function copyPanel() {
    const s=status();
    if(s.phase==='idle') return panel('等待采集。正常使用 AITO，或在“新一轮”面板点击刷新开始。');
    if(s.phase==='active') {
      if(!write('state',JSON.stringify({phase:'frozen',at:Date.now()}))) return panel('无法暂停采集。','error');
      return panel('采集已暂停。等待 15 秒后再次点击刷新以校验并复制。');
    }
    if(s.phase!=='frozen') return panel('状态异常，请在“新一轮”面板重新开始。','error');
    const now=Date.now(); if(now-s.at<WAIT_MS) return panel('等待在途请求结束，15 秒后再点击刷新。');
    const one=scan(); if(one.error) return panel(one.error,'error');
    const result=validate(one.records,now); if(result.error) { notifyOnce('notice_panel_error',result.error); return panel(result.error+'；可在“新一轮”面板重新开始。','error'); }
    const two=scan(), after=status();
    if(two.error||JSON.stringify(one.records)!==JSON.stringify(two.records)||read('error')!==null||after.phase!=='frozen'||after.at!==s.at)
      return panel('采集记录仍在变化，请稍后重试。','alert');
    notify('授权已校验','点击此通知，确认复制后粘贴到 HA。',{action:'clipboard',text:JSON.stringify(result.value)});
    return panel('校验通过；请点击系统通知确认复制，然后粘贴到 HA。','good');
  }
  try {
    if(typeof $script==='object' && $script.type==='generic') {
      if(typeof $trigger==='string' && $trigger==='button') {
        if(typeof $input==='object' && $input.panelName==='AITO_Reset') return start();
        return copyPanel();
      }
      const s=status();
      return panel(s.phase==='active'?'采集中；点击刷新暂停并准备复制。':s.phase==='frozen'?'已暂停；点击刷新校验并发送复制通知。':'等待采集；点击“新一轮”面板刷新开始。');
    }
    if(typeof $script==='object' && $script.type==='cron') {
      let s=status();
      if(s.phase==='idle') { s={phase:'active',at:Date.now()}; write('state',JSON.stringify(s)); }
      if(s.phase==='active') {
        const snap=scan();
        if(!snap.error && !validate(snap.records,Date.now()).error)
          notifyOnce('notice_candidate','授权信息已找到，请打开 AITO 授权面板暂停并复制。');
        else if(Date.now()-s.at>=180000 && read('notice_candidate')===null)
          notifyOnce('notice_wait','尚未收集到完整候选，请确认 App 已产生相关请求。');
      }
      $done(); return;
    }
    if(typeof $request!=='object'||typeof $script!=='object') { $done(); return; }
    const s=status(); const mode=$script.type;
    if(s.phase==='frozen' && mode==='http-request') {
      fail('暂停后出现新的授权请求，请重新开始采集。'); $done(); return;
    }
    if(s.phase==='idle' && mode==='http-request') {
      if(!write('state',JSON.stringify({phase:'active',at:Date.now()}))) { $done(); return; }
    } else if(s.phase!=='active' && !(s.phase==='frozen' && mode==='http-response')) { $done(); return; }
    const url=typeof $request.url==='string'?$request.url.split('?')[0]:'';
    let kind=null;
    if(url===account+'user/auth')kind='ua'; else if(url===account+'user/refresh')kind='ur';
    else if(url===account+'vehicle/auth')kind='va'; else if(url===account+'vehicle/refresh')kind='vr';
    else if(url===vehicles)kind='ivcs';
    if(!kind||$request.method!==(kind==='ivcs'?'GET':'POST')) { $done(); return; }
    const id=$request.id;
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)) { fail('无法识别请求，采集已标记失败。'); $done(); return; }
    const key='slot_'+slot(id), now=Date.now(), rawOld=read(key), old=parse(rawOld);
    if(rawOld!==null&&!old) { fail('采集记录异常，请重新开始。'); $done(); return; }
    if(mode==='http-request') {
      if(old) { fail('采集请求发生冲突，请重新开始。'); $done(); return; }
      let p={id,kind,stage:'pending',req_t:now};
      if(kind==='ivcs') { p.token=header($request.headers,'Authorization',false); p.device=header($request.headers,'X-Device-Id',false); if(!valid(p.token)||!valid(p.device)) { fail(); $done(); return; } }
      else {
        const b=parse($request.body), d=b&&((kind==='ua'||kind==='ur')?b.device:b.deviceInfo);
        p.device=d&&d.id; p.uid=kind==='ua'?null:header($request.headers,'uid',false);
        p.xid=kind==='ua'?null:header($request.headers,'xid',false); p.refresh=kind==='ur'&&b?b.rt:null;
        p.ec=kind==='vr'?header($request.headers,'EC',true):null;
        if(!valid(p.device)||(kind!=='ua'&&(!valid(p.uid)||!valid(p.xid)))||(kind==='ur'&&!valid(p.refresh))) { fail(); $done(); return; }
      }
      if(!write(key,JSON.stringify(p))) fail();
    } else if(mode==='http-response') {
      if(!old||old.id!==id||old.kind!==kind||old.stage!=='pending'||$response.status!==200) { fail(); $done(); return; }
      let out=null;
      if(kind==='ivcs') {
        if(!vehiclesOK($response.body)) { fail(); $done(); return; }
        out={id,stage:'ivcs',token:old.token,device:old.device,req_t:old.req_t,t:now};
      } else {
        const raw=parse($response.body); if(!ok(raw)) { fail(); $done(); return; }
        const d=raw.data&&typeof raw.data==='object'&&!Array.isArray(raw.data)?raw.data:raw;
        if(kind==='ua'||kind==='ur') {
          const u=d.userInfo||{},tok=d.oauthToken||(kind==='ur'?d:null);
          if(kind==='ua'&&String(u.sessionKeyStatus)==='1') out={id,stage:'denied',req_t:old.req_t,t:now};
          else {
            const uid=kind==='ur'?old.uid:u.userId, xid=kind==='ur'?(d.sessionKey||old.xid):d.sessionKey, rt=tok&&(tok.refreshToken||(kind==='ur'?old.refresh:null));
            if(!tok||!valid(uid)||!valid(xid)||!valid(tok.accessToken)||!valid(rt)||(kind==='ua'&&String(u.sessionKeyStatus)!=='0')||
              (kind==='ur'&&((u.userId!==undefined&&u.userId!==uid)||(u.sessionKeyStatus!==undefined&&String(u.sessionKeyStatus)!=='0')))) { fail(); $done(); return; }
            out={id,stage:'ua',uid,xid,device:old.device,access:tok.accessToken,refresh:rt,req_t:old.req_t,t:now};
          }
        } else {
          const list=d.vehicleTokenInfoList; let v;
          if(list===undefined&&kind==='vr')v=d;
          else if(Array.isArray(list)&&list.length===1)v=list[0];
          else if(Array.isArray(list)&&kind==='vr'&&typeof old.ec==='string'&&old.ec) { const found=list.filter(x=>x&&x.enterpriseCode===old.ec); if(found.length===1)v=found[0]; }
          const ec=v&&Object.prototype.hasOwnProperty.call(v,'enterpriseCode')?v.enterpriseCode:(kind==='vr'?old.ec:null);
          if(!v||!valid(v.accessToken)||typeof ec!=='string'||(old.ec&&ec&&old.ec!==ec)) { fail(); $done(); return; }
          out={id,stage:'va',uid:old.uid,xid:old.xid,device:old.device,token:v.accessToken,enterprise:ec,req_t:old.req_t,t:now};
        }
      }
      if(!write(key,JSON.stringify(out))) fail();
      else notifyOnce('notice_partial','已收到授权信息，可在面板查看采集状态。');
    }
  } catch (_) { fail('采集发生错误，请在面板查看。'); }
  $done();
})();
