#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const DEFAULT_URL = 'https://forgejo.example.org'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(value)
const project = value => typeof value === 'string' && /^\/forgejo\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
// Git Bash rewrites /forgejo/o/r into <Git install>/forgejo/o/r before node sees it. Undo that, and accept a missing leading slash.
export function normalizeProject(value) {
  if (typeof value !== 'string') return value
  const match = /^(?:[A-Za-z]:\/(?:[^/]+\/)*?)?\/?(forgejo\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(value.replace(/\\/g,'/'))
  return match ? `/${match[1]}` : value
}
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export function dayInSingapore(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(date)
}

function credential(url) {
  try {
    const host = new URL(url)
    // Explicitly use the existing store. Never launch an interactive credential manager.
    const result = execFileSync('git', ['-c','credential.helper=','-c','credential.helper=store','credential','fill'], {
      input:`protocol=${host.protocol.slice(0,-1)}\nhost=${host.host}\n\n`,encoding:'utf8',
      timeout:2000,windowsHide:true,stdio:['pipe','pipe','ignore'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'},
    })
    const password = result.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9)
    if (password) return password
  } catch {}
  if (process.platform !== 'win32') {
    try {
      const host = new URL(url)
      const result = execFileSync('git',['credential','fill'],{input:`protocol=${host.protocol.slice(0,-1)}\nhost=${host.host}\n\n`,encoding:'utf8',timeout:2000,stdio:['pipe','pipe','ignore'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}})
      const password=result.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9)
      if (password) return password
    } catch {}
  }
  for (const file of [path.join(process.env.APPDATA || os.homedir(),'forgejo-cli','forgejo-cli','data','keys.json'),path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(),'.local','share'),'forgejo-cli','keys.json')]) {
    try {
      const value=JSON.parse(fs.readFileSync(file,'utf8')).hosts?.[new URL(url).host]?.token
      if (value) return value
    } catch {}
  }
  // fj's existing config is an alternative on clients without a git store.
  for (const file of [path.join(os.homedir(),'.config','fj','config.toml'),path.join(process.env.APPDATA || os.homedir(),'fj','config.toml')]) {
    try {
      const text = fs.readFileSync(file,'utf8')
      for (const block of text.split(/(?=^\[)/m)) {
        const configuredUrl = block.match(/^\s*url\s*=\s*"([^"\r\n]+)"/m)?.[1]
        if (configuredUrl && new URL(configuredUrl).origin === new URL(url).origin) {
          const token = block.match(/^\s*token\s*=\s*"([^"\r\n]+)"/m)?.[1]
          if (token) return token
        }
      }
    } catch {}
  }
  throw new Error('No Forgejo credential. Set LOGICAL_MAIL_TOKEN or configure the existing git credential store.')
}

export function createClient(options = {}) {
  const url = options.url || process.env.LOGICAL_MAIL_URL || DEFAULT_URL
  const repo = options.repo || process.env.LOGICAL_MAIL_REPO || 'example/logical-mail'
  const branch = options.branch || process.env.LOGICAL_MAIL_BRANCH || 'main'
  const parsed = new URL(url)
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid Forgejo URL')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid mail repository')
  let token = options.token || process.env.LOGICAL_MAIL_TOKEN || (parsed.origin === new URL(DEFAULT_URL).origin ? process.env.FORGEJO_TOKEN : undefined)
  return {
    async request(file, method = 'GET', data) {
      options.signal?.throwIfAborted()
      token ||= credential(url)
      let response
      try {
        response = await fetch(`${url.replace(/\/$/,'')}/api/v1/repos/${repo}/contents/${file}?ref=${encodeURIComponent(branch)}`, {
          method,headers:{Authorization:`token ${token}`,'Content-Type':'application/json'},
          body:data ? JSON.stringify({...data,branch}) : undefined,
          signal:options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(options.timeoutMs || 3000)]) : AbortSignal.timeout(options.timeoutMs || 3000),redirect:'error',
        })
      } catch { throw new Error('Forgejo request failed or timed out') }
      if (response.status === 404 && method === 'GET') return null
      if (!response.ok) {
        const error = new Error(`Forgejo HTTP ${response.status}`)
        error.status = response.status
        if (response.status === 403 && method !== 'GET') {
          const detail=await response.json().catch(()=>({}))
          // Forgejo reports a concurrent Git ref update as 403, unlike blob-SHA conflicts.
          error.refConflict=typeof detail.message==='string' && detail.message.startsWith('PushRejected Error:') && /\(incorrect old value provided\)|\(non-fast-forward\)/.test(detail.message)
        }
        throw error
      }
      try { return await response.json() } catch { throw new Error('Invalid Forgejo response') }
    },
  }
}

function validateMessage(m) {
  if (!uuid(m.id) || !identity(m.from) || !identity(m.to) || !project(m.project) ||
      !Number.isFinite(Date.parse(m.timestamp)) || (m.replyTo && !uuid(m.replyTo)) || typeof m.body !== 'string' || !m.body.trim()) throw new Error('Invalid message metadata or body')
}

function encode(m) {
  const {body,...meta} = m
  return `## ${m.timestamp} | ${m.from} -> ${m.to}\n<!-- logical-mail ${JSON.stringify({...meta,bodyLength:body.length})} -->\n${body}\n<!-- /logical-mail -->\n\n`
}

export function parseMail(text) {
  const messages = []
  let rest = text.replace(/^# Logical Mail \d{4}-\d{2}-\d{2} \(Asia\/Singapore\)\n\n/,'')
  while (rest.length) {
    const header = rest.match(/^## [^\n]+\n<!-- logical-mail (\{[^\n]+\}) -->\n/)
    if (!header) throw new Error('Malformed mail file, refusing to skip content')
    let meta
    try { meta = JSON.parse(header[1]) } catch { throw new Error('Malformed mail metadata') }
    if (!Number.isSafeInteger(meta.bodyLength) || meta.bodyLength < 1) throw new Error('Invalid mail body length')
    const body = rest.slice(header[0].length, header[0].length + meta.bodyLength)
    const end = '\n<!-- /logical-mail -->\n\n'
    if (rest.slice(header[0].length + meta.bodyLength, header[0].length + meta.bodyLength + end.length) !== end) throw new Error('Corrupt mail body')
    const {bodyLength,...fields} = meta
    const m = {...fields,body}
    validateMessage(m)
    messages.push(m)
    rest = rest.slice(header[0].length + body.length + end.length)
  }
  return messages
}

export async function sendMessage(client, options) {
  const now = options.now || new Date()
  const m = {id:options.id || randomUUID(),timestamp:now.toISOString(),from:options.from,to:options.to,project:options.project,...(options.replyTo ? {replyTo:options.replyTo} : {}),body:options.body.replace(/\r\n/g,'\n')}
  validateMessage(m)
  const day = dayInSingapore(now)
  const file = `mail/${day}.md`
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const current = await client.request(file)
      const text = current ? Buffer.from(current.content,'base64').toString('utf8') : `# Logical Mail ${day} (Asia/Singapore)\n\n`
      const existing = parseMail(text).find(item => item.id === m.id)
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(m)) throw new Error('Message UUID already exists with different content')
        return existing
      }
      await client.request(file,current ? 'PUT' : 'POST', {
        content:Buffer.from(text + encode(m)).toString('base64'),
        ...(current ? {sha:current.sha} : {}),message:`mail: ${m.from} to ${m.to} (${m.id})`,
      })
      return m
    } catch (error) {
      if (error.status && !error.refConflict && ![409,422,500,502,503,504].includes(error.status)) throw error
      if (!error.status && !/request failed|Invalid Forgejo response/.test(error.message)) throw error
      if (attempt === 11) throw new Error(`Send not confirmed. Retry with --id ${m.id} --timestamp ${m.timestamp} and the same message.`)
      await sleep(25 * (attempt + 1) + Math.random()*100)
    }
  }
}

export function statePath(options) {
  const {identity:who,project:key,session} = options
  if (!identity(who) || !project(key) || typeof session !== 'string' || !session) throw new Error('Identity, project and stable session are required')
  const dir = options.stateDir || process.env.LOGICAL_MAIL_STATE_DIR || path.join(os.homedir(),'.logical-mail','state')
  const name = parts => `${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}.json`
  // Delivery ignores project, so the cursor follows the session. Adopt the old per-project cursor once so nothing replays.
  const file = path.join(dir,name([who,session]))
  try { fs.copyFileSync(path.join(dir,name([who,key,session])),file,fs.constants.COPYFILE_EXCL) } catch {}
  return file
}

export function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file,'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error('Cannot read Logical Mail state')
  }
}

export function saveState(file,state) {
  fs.mkdirSync(path.dirname(file),{recursive:true})
  const temp = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600})
  fs.renameSync(temp,file)
}

export async function withStateLock(file,action,signal) {
  fs.mkdirSync(path.dirname(file),{recursive:true})
  const lock = `${file}.lock`
  let fd
  for (let i = 0; i < 60; i++) {
    signal?.throwIfAborted()
    try { fd = fs.openSync(lock,'wx',0o600); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // A process killed mid-hook must not block the session forever.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.unlinkSync(lock) } catch {}
      await sleep(50)
    }
  }
  if (fd === undefined) throw new Error('Logical Mail state is busy')
  try { signal?.throwIfAborted(); return await action() } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}

async function scan(client,options,state) {
  const now = options.now || new Date()
  const startDay = state.startDay || dayInSingapore(new Date(now.getTime() - 86400_000))
  const listing = await client.request('mail') || []
  if (!Array.isArray(listing)) throw new Error('Invalid mail directory response')
  const days = listing.filter(f => f.type === 'file' && /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name) && f.name.slice(0,10) >= startDay).sort((a,b)=>a.name.localeCompare(b.name))
  const offsets = {...state.offsets}
  const shas={...state.shas}
  const messages = []
  for (const entry of days) {
    const day=entry.name
    if (entry.sha && shas[day] === entry.sha) continue
    const file = await client.request(`mail/${day}`)
    if (!file) throw new Error('Mail file disappeared during read')
    const all = parseMail(Buffer.from(file.content,'base64').toString('utf8'))
    const offset = offsets[day] || 0
    if (offset > all.length) throw new Error('Mail archive was shortened')
    messages.push(...all.slice(offset).filter(m=>(m.to === options.identity || m.to === 'all') && m.from !== options.identity))
    offsets[day] = all.length
    shas[day]=file.sha
  }
  return {messages,state:{...state,startDay,offsets,shas}}
}

export async function checkInbox(client,options) {
  const file=statePath(options)
  return withStateLock(file,async () => {
    const state=loadState(file)
    const result=await scan(client,options,state)
    if (!state.startDay) saveState(file,{...state,startDay:result.state.startDay})
    return result.messages
  },options.signal)
}

export async function readInbox(client,options) {
  const file = statePath(options)
  return withStateLock(file, async () => {
    const result = await scan(client,options,loadState(file))
    options.signal?.throwIfAborted()
    // Output is synchronous and happens before the cursor commit in the CLI/hooks.
    if (options.deliver) options.deliver(result.messages)
    saveState(file,result.state)
    return result.messages
  },options.signal)
}

export function formatMessages(messages) {
  return messages.map(m=>`Logical Mail ${m.id} | ${m.timestamp} | ${m.from} -> ${m.to} | ${m.project}${m.replyTo ? ` | reply ${m.replyTo}` : ''}\n${m.body}`).join('\n\n')
}

async function main() {
  const {values,positionals} = parseArgs({allowPositionals:true,options:Object.fromEntries(['from','to','project','body','body-file','reply-to','identity','session','state-dir','id','timestamp'].map(k=>[k,{type:'string'}]).concat([['json',{type:'boolean'}],['count',{type:'boolean'}]]))})
  const [command] = positionals
  values.project = normalizeProject(values.project)
  if (command === 'send') {
    if (values.body === undefined && !values['body-file']) throw new Error('send requires --body or --body-file')
    const body = values.body ?? fs.readFileSync(values['body-file'],'utf8')
    const sent = await sendMessage(createClient(), {from:values.from,to:values.to,project:values.project,body,replyTo:values['reply-to'],id:values.id,now:values.timestamp ? new Date(values.timestamp) : undefined})
    fs.writeSync(1,JSON.stringify(sent)+'\n')
  } else if (['read','check'].includes(command)) {
    const options = {identity:values.identity,project:values.project,session:values.session,stateDir:values['state-dir']}
    const deliver = messages => fs.writeSync(1,(values.count ? String(messages.length) : values.json ? JSON.stringify(messages) : formatMessages(messages))+'\n')
    if (command === 'read') await readInbox(createClient(),{...options,deliver})
    else deliver(await checkInbox(createClient(),options))
  } else throw new Error('Usage: logical-mail.mjs send|read|check. See README.md for options.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Logical Mail: ${error.message}\n`); process.exitCode = 1 })
}
