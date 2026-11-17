import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('Windows account encryption round-trips only through redirected stdin/stdout without plaintext files',{skip:process.platform!=='win32'},()=>{
  const script=fileURLToPath(new URL('./execution/protect-config.ps1',import.meta.url));
  const invoke=(mode,input)=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Mode',mode],{input,encoding:'utf8',windowsHide:true,timeout:15000});
  const original=JSON.stringify({purpose:'mock-only',value:'测试配置，不是账户密钥'}),encrypted=invoke('Protect',original);
  assert.equal(encrypted.status,0);assert.equal(encrypted.stderr,'');assert.doesNotMatch(encrypted.stdout,/mock-only|测试配置/);assert.match(encrypted.stdout,/^[A-Za-z0-9+/=]+$/);
  const decoded=invoke('Unprotect',encrypted.stdout);assert.equal(decoded.status,0);assert.equal(decoded.stdout,original);
  const invalid=invoke('Unprotect','invalid-ciphertext');assert.notEqual(invalid.status,0);assert.equal(invalid.stdout,'');assert.doesNotMatch(invalid.stderr,/invalid-ciphertext/);
});
