import {DatabaseSync} from 'node:sqlite';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {mkdirSync,chmodSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';

const uidValid=uid=>typeof uid==='string'&&/^\d{1,30}$/.test(uid);
/** OS-backed exclusive ownership for one local persistent volume. No expiry/lease. */
export function acquireBinanceCloudLock(directory){
  if(!isAbsolute(directory||''))throw Error('Absolute persistent directory required');
  mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
  const file=join(directory,'executor-lock.sqlite'),db=new DatabaseSync(file);let closed=false;
  try{db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');chmodSync(file,0o600);}
  catch(error){db.close();throw error;}
  return {close(){if(closed)return;closed=true;try{db.exec('ROLLBACK');}finally{db.close();}}};
}
export function parseCloudMasterKey(value){
  if(Buffer.isBuffer(value)&&value.length===32)return Buffer.from(value);
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))throw Error('A 32-byte base64 master key is required');
  const key=Buffer.from(value,'base64');if(key.length!==32)throw Error('Invalid master key');return key;
}
/** Only verified UIDs enter this store. Secrets never enter strategy journals. */
export class BinanceCloudVault{
  constructor({directory,masterKey,now=Date.now}){
    if(!isAbsolute(directory||'')||typeof now!=='function')throw Error('Absolute persistent directory required');
    this.key=parseCloudMasterKey(masterKey);this.directory=directory;this.now=now;
    mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
    const file=join(directory,'accounts.sqlite');this.db=new DatabaseSync(file);
    try{this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS accounts(uid TEXT PRIMARY KEY, nonce BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL);');chmodSync(file,0o600);for(const uid of this.list())this.get(uid);}
    catch(error){this.db.close();this.key.fill(0);throw error;}
  }
  list(){return this.db.prepare('SELECT uid FROM accounts ORDER BY uid').all().map(row=>row.uid);}
  put(uid,credentials){
    if(!uidValid(uid)||!credentials||typeof credentials.apiKey!=='string'||typeof credentials.apiSecret!=='string')throw Error('Invalid verified credentials');
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from('binance-cloud-v1:'+uid));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify({apiKey:credentials.apiKey,apiSecret:credentials.apiSecret}),'utf8'),cipher.final()]);
    this.db.prepare('INSERT INTO accounts(uid,nonce,tag,ciphertext,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET nonce=excluded.nonce,tag=excluded.tag,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at').run(uid,nonce,cipher.getAuthTag(),ciphertext,this.now());
  }
  get(uid){
    if(!uidValid(uid))throw Error('Invalid account');const row=this.db.prepare('SELECT nonce,tag,ciphertext FROM accounts WHERE uid=?').get(uid);if(!row)return null;
    const decipher=createDecipheriv('aes-256-gcm',this.key,row.nonce);decipher.setAAD(Buffer.from('binance-cloud-v1:'+uid));decipher.setAuthTag(row.tag);
    return JSON.parse(Buffer.concat([decipher.update(row.ciphertext),decipher.final()]).toString('utf8'));
  }
  delete(uid){if(!uidValid(uid))throw Error('Invalid account');this.db.prepare('DELETE FROM accounts WHERE uid=?').run(uid);}
  journalPath(uid){if(!uidValid(uid))throw Error('Invalid account');return join(this.directory,'uid-'+createHash('sha256').update(uid).digest('hex')+'.sqlite');}
  close(){this.db.close();this.key.fill(0);}
}
