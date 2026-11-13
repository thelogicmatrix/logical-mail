import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import fs, { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A local file-API server exercises SHA races and ambiguous commits over real HTTP.
async function fixture(t) {
  const files = new Map()
  let loseResponse = false
  let denied=false, writes=0
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://local')
    const file = decodeURIComponent(u.pathname.split('/contents/')[1] || '')
    const reply = (status, data) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(data)) }
    if (req.headers.authorization !== 'token synthetic-secret') return reply(401, {})
    if (req.method === 'GET') {
      if (file === 'mail') return reply(200, [...files.entries()].map(([p,v]) => ({name:p.split('/').at(-1),path:p,type:'file',sha:v.sha})))
      const found = files.get(file)
      return found ? reply(200, {sha:found.sha, content:Buffer.from(found.text).toString('base64')}) : reply(404, {})
    }
    let body = ''
    for await (const part of req) body += part
    const data = JSON.parse(body)
    writes++
    if (denied) return reply(403,{message:'permission denied synthetic-secret'})
    const old = files.get(file)
    if ((old && (req.method !== 'PUT' || data.sha !== old.sha)) || (!old && req.method !== 'POST')) return reply(403, {message:'PushRejected Error: remote rejected main (incorrect old value provided)'})
    const text = Buffer.from(data.content, 'base64').toString()
    files.set(file, {text, sha:createHash('sha1').update(text).digest('hex')})
    if (loseResponse) { loseResponse = false; return req.socket.destroy() }
    reply(200, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const mod = await import('../logical-mail.mjs').catch(() => ({}))
  assert.equal(typeof mod.createClient, 'function', 'CLI client is not implemented')
  return { ...mod, files, lose:() => { loseResponse = true },deny:()=>{denied=true},writes:()=>writes, client:mod.createClient({url:`http://127.0.0.1:${server.address().port}`,token:'synthetic-secret'}), stateDir:mkdtempSync(path.join(os.tmpdir(),'logical-mail-test-')) }
}
const message = {from:'Alice',to:'Bob',project:'/forgejo/example/home',body:'hello'}
const inbox = {identity:'Bob',project:message.project,session:'session-one'}

test('simultaneous appends preserve all messages and body delimiters', async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({length:8}, (_, i) => f.sendMessage(f.client, {...message,body:`message ${i}\n<!-- logical-mail {fake} -->\n你好`})))
  const found = await f.readInbox(f.client, {...inbox,stateDir:f.stateDir})
  assert.equal(found.length, 8)
  assert.equal(new Set(found.map(m=>m.id)).size, 8)
  assert.deepEqual(found.map(m=>m.body.split('\n')[0]).sort(), Array.from({length:8},(_,i)=>`message ${i}`))
  assert.equal((await f.readInbox(f.client, {...inbox,stateDir:f.stateDir})).length, 0)
})

test('ambiguous committed response retries one UUID without duplicating', async t => {
  const f = await fixture(t)
  f.lose()
  const sent = await f.sendMessage(f.client, message)
  const found = await f.checkInbox(f.client, {...inbox,stateDir:f.stateDir})
  assert.deepEqual(found.map(m=>m.id), [sent.id])
  assert.equal((await f.checkInbox(f.client, {...inbox,stateDir:f.stateDir})).length, 1)
})

test('filtering, resume and late appends cross Singapore midnight without timestamp loss', async t => {
  const f = await fixture(t)
  const before = new Date('2026-11-05T15:59:59Z')
  const after = new Date('2026-11-05T16:00:01Z')
  assert.equal(f.dayInSingapore(before), '2026-11-05')
  assert.equal(f.dayInSingapore(after), '2026-11-06')
  await f.sendMessage(f.client, {...message,now:before})
  await f.sendMessage(f.client, {...message,to:'Other',now:before})
  await f.sendMessage(f.client, {...message,to:'all',project:'/forgejo/example/other',now:before})
  const first = await f.readInbox(f.client, {...inbox,stateDir:f.stateDir,now:before})
  // Broadcasts and direct mail reach a session whatever repo it works in, and the header names the sender's repo.
  assert.equal(first.length, 2)
  assert.match(f.formatMessages(first), / -> all \| \/forgejo\/example\/other\n/)
  await f.sendMessage(f.client, {...message,to:'all',now:after})
  await f.sendMessage(f.client, {...message,body:'late append',now:before})
  const result = await f.readInbox(f.client, {...inbox,stateDir:f.stateDir,now:new Date('2026-11-10T00:00:00Z')})
  assert.deepEqual(result.map(m=>m.body), ['late append','hello'])
})

test('state paths isolate session and identity, not project, and malformed mail never advances cursor', async t => {
  const f = await fixture(t)
  const options = {...inbox,stateDir:f.stateDir}
  assert.equal(f.statePath(options), f.statePath({...options,project:'/forgejo/example/other'}))
  assert.notEqual(f.statePath(options), f.statePath({...options,session:'other-session'}))
  assert.notEqual(f.statePath(options), f.statePath({...options,identity:'Other'}))
  const sent = await f.sendMessage(f.client,message)
  const entry = [...f.files.values()][0]
  const saved = entry.text
  entry.text += '\n<!-- logical-mail {broken} -->'
  await assert.rejects(f.readInbox(f.client,options), /malformed|invalid|corrupt/i)
  entry.text = saved
  assert.deepEqual((await f.readInbox(f.client,options)).map(m=>m.id),[sent.id])
})

test('a non-consuming check preserves its original unread window across a long resume', async t => {
  const f=await fixture(t)
  const now=new Date('2026-11-01T00:00:00Z')
  const sent=await f.sendMessage(f.client,{...message,now})
  assert.equal((await f.checkInbox(f.client,{...inbox,stateDir:f.stateDir,now})).length,1)
  const later=await f.readInbox(f.client,{...inbox,stateDir:f.stateDir,now:new Date('2026-11-05T00:00:00Z')})
  assert.deepEqual(later.map(m=>m.id),[sent.id])
})

test('consumed archive days use directory SHAs and still notice late appends',async t => {
  const f=await fixture(t)
  const now=new Date('2026-11-01T00:00:00Z')
  await f.sendMessage(f.client,{...message,now})
  const options={...inbox,stateDir:f.stateDir,now}
  await f.readInbox(f.client,options)
  const requests=[]
  const client={request:async (...args)=>{requests.push(args[0]);return f.client.request(...args)}}
  assert.deepEqual(await f.readInbox(client,options),[])
  assert.deepEqual(requests,['mail'])
  await f.sendMessage(f.client,{...message,now,body:'late message'})
  assert.deepEqual((await f.readInbox(client,options)).map(m=>m.body),['late message'])
})

test('ordinary permission failures are not retried and do not expose response bodies',async t=>{
  const f=await fixture(t)
  f.deny()
  await assert.rejects(f.sendMessage(f.client,message),error=>error.message==='Forgejo HTTP 403')
  assert.equal(f.writes(),1)
})

test('a session keeps its per-project cursor when state moves to the session key', async t => {
  const f = await fixture(t)
  const options = {...inbox,stateDir:f.stateDir}
  const legacy = path.join(f.stateDir,createHash('sha256').update(JSON.stringify([options.identity,options.project,options.session])).digest('hex')+'.json')
  const state = JSON.stringify({startDay:'2026-11-07',offsets:{'2026-11-07.md':3}})
  fs.writeFileSync(legacy,state)
  assert.equal(fs.readFileSync(f.statePath(options),'utf8'),state)
})
