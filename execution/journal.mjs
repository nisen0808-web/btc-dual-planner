import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';

function publicRecord(value){
  const visit=item=>{
    if(!item||typeof item!=='object')return;
    for(const [key,child] of Object.entries(item)){
      if(/secret|api.?key|authorization|signature|password|bearer|token/i.test(key))throw Error('Credentials must not enter the execution journal');
      visit(child);
    }
  };
  visit(value);return JSON.stringify(value);
}

/** One writer, durable order intents before sending. Keep outside the Site source checkout. */
export class ExecutionJournal{
  constructor(path){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, account TEXT NOT NULL, version INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_plan_per_account ON plans(account) WHERE closed=0;
      CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,data TEXT NOT NULL);`);
    if(path!==':memory:')try{chmodSync(path,0o600);}catch{}
  }
  get(id){const row=this.db.prepare('SELECT data FROM plans WHERE id=?').get(id);return row?JSON.parse(row.data):null;}
  list(){return this.db.prepare('SELECT data FROM plans ORDER BY rowid DESC').all().map(row=>JSON.parse(row.data));}
  create(plan){
    const value={...plan,version:1};
    this.db.prepare('INSERT INTO plans(id,account,version,closed,data) VALUES(?,?,1,0,?)').run(value.id,value.account,publicRecord(value));
    return value;
  }
  update(id,version,change,eventId){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(eventId&&this.db.prepare('SELECT event_id FROM events WHERE event_id=?').get(eventId)){this.db.exec('ROLLBACK');return this.get(id);}
      const old=this.get(id);if(!old||old.version!==version)throw Error('Execution state changed; reconcile before continuing');
      const value={...old,...change,id:old.id,account:old.account,version:version+1};
      this.db.prepare('UPDATE plans SET version=?,closed=?,data=? WHERE id=? AND version=?').run(value.version,value.closed===true?1:0,publicRecord(value),id,version);
      if(eventId)this.db.prepare('INSERT INTO events(event_id,plan_id,data) VALUES(?,?,?)').run(eventId,id,publicRecord(change));
      this.db.exec('COMMIT');return value;
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  close(){this.db.close();}
}
