import test from 'node:test';
import assert from 'node:assert/strict';
import {createBinanceCloudExecutionClient} from './web/binance-cloud-execution.js';
const csrf='mock_csrf_token_not_secret_123456';
test('unconfigured public client performs status only and never accepts keys for forwarding',async()=>{
 const calls=[],client=createBinanceCloudExecutionClient({fetchImpl:async(path,options)=>{calls.push({path,options});return Response.json({ok:true,brokerConfigured:false,connected:false,canSubmit:false});}});
 assert.equal((await client.api('status')).brokerConfigured,false);
 await assert.rejects(()=>client.api('connect',{apiKey:'mock-key',apiSecret:'mock-secret',tradingEnabled:true}),/未配置/);
 assert.deepEqual(calls.map(c=>c.path),['/api/execution/status']);assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.cache,'no-store');
});
test('fixed cloud actions use in-memory CSRF, unwrap data, clear credentials and never auto-submit',async()=>{
 const calls=[],client=createBinanceCloudExecutionClient({fetchImpl:async(path,options)=>{calls.push({path,options});if(path.endsWith('status'))return Response.json({ok:true,brokerConfigured:true,csrf,connected:false});if(path.endsWith('/connect'))return Response.json({ok:true,connected:true});return Response.json({ok:true,data:[]});}});
 await client.api('status');const payload={apiKey:'mock-only-key',apiSecret:'mock-only-secret',tradingEnabled:true};await client.api('connect',payload);
 assert.equal(payload.apiKey,'');assert.equal(payload.apiSecret,'');assert.equal(calls.length,2);assert.equal(calls[1].options.headers['X-Strategy-CSRF'],csrf);assert.equal(calls[1].options.credentials,'same-origin');assert.equal(calls[1].options.redirect,'error');assert.match(calls[1].options.body,/mock-only-secret/);
 assert.deepEqual(await client.api('plans'),[]);await assert.rejects(()=>client.api('prepare',{}),/未连接/);await assert.rejects(()=>client.api('../withdraw',{}),/未知/);
});
test('failed connection clears secret fields without echoing credentials; disconnect invalidates CSRF',async()=>{
 const client=createBinanceCloudExecutionClient({fetchImpl:async path=>path.endsWith('status')?Response.json({ok:true,brokerConfigured:true,csrf,connected:true}):path.endsWith('/connect')?Response.json({ok:false,error:{message:'mock-secret'}},{status:403}):Response.json({ok:true,disconnected:true,activePlansContinue:true})});
 await client.api('status');const payload={apiKey:'mock-key',apiSecret:'mock-secret',tradingEnabled:true};await assert.rejects(()=>client.api('connect',payload),error=>!error.message.includes('mock-secret'));assert.equal(payload.apiSecret,'');
 assert.equal((await client.disconnect()).activePlansContinue,true);await assert.rejects(()=>client.api('prepare',{}),/失效/);
});
test('confirmation timeout is one request and is marked as an unknown outcome',async()=>{
 let writes=0;const client=createBinanceCloudExecutionClient({fetchImpl:async path=>{if(path.endsWith('status'))return Response.json({ok:true,brokerConfigured:true,csrf,connected:true});writes++;throw Error('timeout');}});
 await client.api('status');await assert.rejects(()=>client.api('confirm',{id:'mock'}),error=>error.unknownOutcome===true);assert.equal(writes,1);
});
