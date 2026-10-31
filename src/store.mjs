export class Inbox {
  constructor(db) { this.db=db; }
  async reserve({id,webhookId,bodyHash,payload,now,maxJobs}) {
    // One SQLite statement makes both daily admission and deduplication atomic.
    const result = await this.db.prepare(`INSERT OR IGNORE INTO jobs(id,webhook_id,body_hash,payload,state,created)
      SELECT ?,?,?,?,'dispatching',? WHERE
      (SELECT COUNT(*) FROM jobs WHERE created >= ?) < ? RETURNING id`)
      .bind(id,webhookId,bodyHash,JSON.stringify(payload),now,Math.floor(now/86400000)*86400000,maxJobs).first();
    if (result) return {created:true,id};
    const existing = await this.db.prepare('SELECT id,body_hash,state FROM jobs WHERE webhook_id = ?').bind(webhookId).first();
    if (!existing) return {budgetExceeded:true};
    return {created:false,id:existing.id,conflict:existing.body_hash !== bodyHash,state:existing.state};
  }
  async markDispatch(id,state) {
    await this.db.prepare("UPDATE jobs SET state=? WHERE id=? AND state='dispatching'").bind(state,id).run();
  }
  async lease(id,runner,now) {
    return this.db.prepare(`UPDATE jobs SET state='leased',runner_id=? WHERE id=?
      AND state IN ('dispatching','dispatched') AND created >= ? RETURNING id,payload`)
      .bind(runner,id,now-15*60000).first();
  }
  async context() {
    const row = await this.db.prepare("SELECT content FROM documents WHERE name='context'").first();
    if (!row) throw new Error('private context not configured');
    return JSON.parse(row.content);
  }
  async get(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first(); }
  async sending(id,runner,answer) {
    return this.db.prepare("UPDATE jobs SET state='sending',answer=? WHERE id=? AND runner_id=? AND state='leased' RETURNING id")
      .bind(JSON.stringify(answer),id,runner).first();
  }
  async finish(id,state,status=null) {
    await this.db.prepare('UPDATE jobs SET state=?,reply_status=?,payload=NULL,answer=NULL WHERE id=?')
      .bind(state,status,id).run();
  }
}
