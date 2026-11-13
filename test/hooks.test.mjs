import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs, { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const fixtureRepo = mkdtempSync(path.join(os.tmpdir(),'logical-mail-repo-'))
execFileSync('git',['init','-q',fixtureRepo],{windowsHide:true})
execFileSync('git',['-C',fixtureRepo,'remote','add','origin','https://forgejo.example.org/example/logical-mail.git'],{windowsHide:true})
after(()=>fs.rmSync(fixtureRepo,{recursive:true,force:true}))

function launch(args,env,input) {
  return new Promise(resolve=>{
    const child=spawn(process.execPath,args,{env:{...process.env,...env},windowsHide:true})
    let stdout='',stderr=''
    child.stdout.on('data',v=>stdout+=v)
    child.stderr.on('data',v=>stderr+=v)
    child.on('close',code=>resolve({code,stdout,stderr}))
    child.stdin.end(JSON.stringify(input))
  })
}

async function hook(event,input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath,['hook.mjs',event],{env:{...process.env,LOGICAL_MAIL_URL:'http://127.0.0.1:1',LOGICAL_MAIL_TOKEN:'synthetic-only',LOGICAL_MAIL_STATE_DIR:mkdtempSync(path.join(os.tmpdir(),'logical-hook-test-'))},windowsHide:true})
    let stdout = '', stderr = ''
    child.stdout.on('data',v=>stdout+=v)
    child.stderr.on('data',v=>stderr+=v)
    child.on('close',code=>resolve({code,stdout,stderr}))
    child.stdin.end(JSON.stringify(input))
  })
}
test('startup hook reports identity and unavailable mail without blocking',async () => {
  const r = await hook('start',{session_id:'synthetic-session',cwd:fixtureRepo})
  assert.equal(r.code,0)
  const output = JSON.parse(r.stdout).hookSpecificOutput
  assert.equal(output.hookEventName,'SessionStart')
  assert.match(output.additionalContext,/Logical Mail.*identity/s)
  assert.match(output.additionalContext,/unavailable/i)
  assert.equal(r.stderr,'')
})

test('named agent hooks share the configured identity and cursor across chat sessions',async () => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'logical-named-hook-'))
  const env={LOGICAL_MAIL_STATE_DIR:dir,LOGICAL_MAIL_URL:'http://127.0.0.1:1',LOGICAL_MAIL_TOKEN:'fixture-only'}
  for (const session of ['chat-one','chat-two']) {
    const r=await launch(['hook.mjs','start','--identity','Courier','--session','courier'],env,{session_id:session,cwd:fixtureRepo})
    assert.equal(r.code,0)
    const text=JSON.parse(r.stdout).hookSpecificOutput.additionalContext
    assert.match(text,/Logical Mail identity Courier,/)
    assert.match(text,/read --identity Courier .*--session "courier"/)
  }
  assert.equal(fs.readdirSync(dir).filter(name=>name.startsWith('identity-')).length,0)
})

test('profile identity also applies to inherited project hooks',async () => {
  const env={LOGICAL_MAIL_STATE_DIR:mkdtempSync(path.join(os.tmpdir(),'logical-profile-hook-')),LOGICAL_MAIL_URL:'http://127.0.0.1:1',LOGICAL_MAIL_TOKEN:'fixture-only',LOGICAL_MAIL_IDENTITY:'Courier',LOGICAL_MAIL_SESSION:'courier'}
  const r=await launch(['hook.mjs','start'],env,{session_id:'inherited-chat',cwd:fixtureRepo})
  const text=JSON.parse(r.stdout).hookSpecificOutput.additionalContext
  assert.match(text,/Logical Mail identity Courier,/)
  assert.match(text,/read --identity Courier .*--session "courier"/)
})
test('activity hook is silent on unavailable server and missing session input',async () => {
  for (const input of [{session_id:'synthetic-session',cwd:fixtureRepo},{}]) {
    const r=await hook('check',input)
    assert.deepEqual(r,{code:0,stdout:'',stderr:''})
  }
})

test('adopted identity survives legacy temp cleanup and harness differences',async t => {
  const session=`logical-review-${process.pid}`
  const legacy=path.join(os.tmpdir(),`agent-mail-${session}.json`)
  const dir=mkdtempSync(path.join(os.tmpdir(),'logical-identity-test-'))
  const env={LOGICAL_MAIL_STATE_DIR:dir,LOGICAL_MAIL_URL:'http://127.0.0.1:1',LOGICAL_MAIL_TOKEN:'synthetic-only'}
  t.after(()=>{try{fs.unlinkSync(legacy)}catch{}})
  fs.writeFileSync(legacy,JSON.stringify({key:'/forgejo/example/logical-mail',name:'PriorAgent'}))
  const first=await launch(['hook.mjs','start','--harness','codex'],env,{session_id:session,cwd:fixtureRepo})
  assert.match(first.stdout,/identity PriorAgent/)
  fs.unlinkSync(legacy)
  const resumed=await launch(['hook.mjs','start'],env,{session_id:session,cwd:fixtureRepo})
  assert.match(resumed.stdout,/identity PriorAgent/)
})

test('startup deadline prints identity/read fallback and releases its state lock',async t => {
  const server=createServer((req,res)=>{
    if(req.url.includes('/contents/mail?')) {res.writeHead(200);res.end(JSON.stringify(Array.from({length:18},(_,i)=>({type:'file',name:`2026-11-${String(i+1).padStart(2,'0')}.md`,sha:String(i)}))))}
    else setTimeout(()=>{res.writeHead(200);res.end(JSON.stringify({sha:'x',content:Buffer.from('').toString('base64')}))},500)
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
  const session=`deadline-${process.pid}`
  const dir=mkdtempSync(path.join(os.tmpdir(),'logical-deadline-test-'))
  const who=`agent-${createHash('sha256').update(`${os.hostname()}|${session}`).digest('hex').slice(0,16)}`
  const hash=createHash('sha256').update(JSON.stringify([who,'/forgejo/example/logical-mail',session])).digest('hex')
  const file=path.join(dir,`${hash}.json`)
  fs.writeFileSync(file,JSON.stringify({startDay:'2026-11-01',offsets:{}}))
  const r=await launch(['hook.mjs','start'],{LOGICAL_MAIL_STATE_DIR:dir,LOGICAL_MAIL_URL:`http://127.0.0.1:${server.address().port}`,LOGICAL_MAIL_TOKEN:'synthetic-only'},{session_id:session,cwd:fixtureRepo})
  assert.match(r.stdout,/Logical Mail identity/)
  assert.match(r.stdout,/read --identity/)
  assert.match(r.stdout,/unavailable|deadline|budget/i)
  assert.equal(fs.existsSync(file+'.lock'),false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).offsets,{})
})

test('existing Forgejo environment credential is scoped to the default host',async () => {
  const code=`
    import cp from 'node:child_process'
    import fs from 'node:fs'
    import {syncBuiltinESMExports} from 'node:module'
    cp.execFileSync=()=>{throw new Error('no synthetic store')}
    syncBuiltinESMExports()
    const {createClient}=await import('./logical-mail.mjs')
    fs.readFileSync=()=>{throw Error('Synthetic credential config absent')}
    syncBuiltinESMExports()
    const captured=[]
    globalThis.fetch=async (url,options)=>{captured.push(options.headers.Authorization);return new Response('[]',{status:200})}
    await createClient().request('mail')
    const inherited=captured.at(-1)==='token synthetic-forgejo'
    await createClient({token:'synthetic-explicit'}).request('mail')
    const explicit=captured.at(-1)==='token synthetic-explicit'
    let refused=false
    try{await createClient({url:'http://127.0.0.1:1'}).request('mail')}catch{refused=true}
    console.log(JSON.stringify({inherited,explicit,refused,calls:captured.length}))
  `
  const r=await launch(['--input-type=module','-e',code],{FORGEJO_TOKEN:'synthetic-forgejo',LOGICAL_MAIL_TOKEN:'',LOGICAL_MAIL_URL:''},{})
  assert.equal(r.code,0)
  assert.deepEqual(JSON.parse(r.stdout),{inherited:true,explicit:true,refused:true,calls:2})
})

test('startup note gives the send rule and a ready send command',async () => {
  const r = await hook('start',{session_id:'synthetic-session',cwd:fixtureRepo})
  const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
  assert.match(text,/send --from agent-[0-9a-f]{16} --to all --project \/forgejo\/example\/logical-mail --body "/)
  assert.match(text,/shared container/)
  assert.doesNotMatch(text,/No registration or mandatory broadcast/)
})

test('send accepts an inline --body',async () => {
  const r = await launch(['logical-mail.mjs','send','--from','A','--to','all','--project','/forgejo/example/home','--body','hello'],{LOGICAL_MAIL_URL:'http://127.0.0.1:1',LOGICAL_MAIL_TOKEN:'x'},{})
  assert.equal(r.code,1)
  assert.match(r.stderr,/Send not confirmed/)
})

test('send accepts a project path rewritten by Git Bash or given without the leading slash',async () => {
  for (const project of ['C:/Program Files/Git/forgejo/example/home','forgejo/example/home']) {
    const r = await launch(['logical-mail.mjs','send','--from','A','--to','all','--project',project,'--body','hello'],{LOGICAL_MAIL_URL:'http://127.0.0.1:1',LOGICAL_MAIL_TOKEN:'x',MSYS_NO_PATHCONV:'1'},{})
    assert.equal(r.code,1)
    assert.match(r.stderr,/Send not confirmed/)
  }
})
