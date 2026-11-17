import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createExecutionHttp} from './execution/http.mjs';
const token='TEST_GATEWAY_TOKEN_NOT_REAL_012345678901234567890';
const siteOrigin='https://strategy-owner.invalid';
test('gateway requires both server token and configured Site, with no browser or arbitrary route access',async()=>{
  let calls=0;
  const server=createExecutionHttp({token,siteOrigin,service:{status:async()=>{calls++;return {canSubmit:false};},prepare:async body=>({prepared:body.symbol}),confirm:async()=>{throw Error('RAW_PRIVATE_NEVER_RETURN');},list:()=>[]}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal((await fetch(url+'/v1/status')).status,403);assert.equal(calls,0);
    const headers={Authorization:'Bearer '+token,'x-strategy-site':siteOrigin,'content-type':'application/json'};
    const r=await fetch(url+'/v1/status',{headers});assert.equal(r.status,200);assert.equal((await r.json()).canSubmit,false);
    assert.equal((await fetch(url+'/v1/status',{headers:{...headers,'x-strategy-site':'https://other.invalid'}})).status,403);
    assert.equal((await fetch(url+'/v1/withdraw',{headers,method:'POST',body:'{}'})).status,404);
    const failure=await fetch(url+'/v1/confirm',{headers,method:'POST',body:'{}'});assert.equal(failure.status,409);assert.doesNotMatch(await failure.text(),/RAW_PRIVATE/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
