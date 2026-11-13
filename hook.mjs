#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { createClient, statePath, loadState, saveState, readInbox, checkInbox, formatMessages, withStateLock } from './logical-mail.mjs'

const mode = process.argv[2]
const harness = process.argv.includes('--harness') ? process.argv[process.argv.indexOf('--harness')+1] : 'claude'
const event = mode === 'start' ? 'SessionStart' : 'PostToolUse'
const emit = text => fs.writeSync(1,JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:text}})+'\n')
// No idle process. A harness invocation has a fixed budget below its registered timeout.
const signal=AbortSignal.timeout(mode === 'start' ? 6500 : 2500)
let note = ''

export function projectKey(cwd) {
  try {
    const remotes = execFileSync('git',['-C',cwd,'remote','-v'],{encoding:'utf8',timeout:1000,windowsHide:true,stdio:['ignore','pipe','ignore']})
    for (const name of ['upstream','origin']) {
      const remote = remotes.split('\n').find(l=>l.startsWith(`${name}\t`) && l.endsWith('(fetch)'))?.split(/\s+/)[1]
      if (!remote) continue
      const parts = remote.replace(/\.git$/,'').split(/[/:]/).filter(Boolean)
      if (parts.length >= 2 && parts.slice(-2).every(v=>/^[A-Za-z0-9_.-]+$/.test(v))) return `/forgejo/${parts.at(-2)}/${parts.at(-1)}`
    }
  } catch {}
  return null
}

async function main() {
  if (mode === '--print-key') {
    const key = projectKey(process.argv[3] || process.cwd())
    if (key) fs.writeSync(1,key+'\n')
    return
  }
  const {values} = parseArgs({args:process.argv.slice(3),options:{harness:{type:'string'},identity:{type:'string'},session:{type:'string'}}})
  values.identity ??= process.env.LOGICAL_MAIL_IDENTITY
  values.session ??= process.env.LOGICAL_MAIL_SESSION
  if (values.identity !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(values.identity)) throw new Error('Invalid hook identity')
  if (values.session !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(values.session)) throw new Error('Invalid hook session')
  let raw = ''
  const abortInput=()=>process.stdin.destroy(new Error('Logical Mail input deadline'))
  signal.addEventListener('abort',abortInput,{once:true})
  try { for await (const chunk of process.stdin) raw += chunk } finally { signal.removeEventListener('abort',abortInput) }
  let input
  try { input = JSON.parse(raw) } catch { return }
  if (!input.session_id || !input.cwd) return
  if (values.session) input.session_id=values.session
  const key = projectKey(input.cwd)
  if (!key) return
  const hash = createHash('sha256').update(`${os.hostname()}|${input.session_id}`).digest('hex').slice(0,16)
  // Preserve an existing session's address during the one-time Agent Mail cutover.
  let legacy = {}
  try { legacy = JSON.parse(fs.readFileSync(path.join(os.tmpdir(),`agent-mail-${String(input.session_id).replace(/[^A-Za-z0-9_-]/g,'_')}.json`),'utf8')) } catch {}
  const identityKey=createHash('sha256').update(JSON.stringify([key,input.session_id])).digest('hex')
  const identityFile=path.join(process.env.LOGICAL_MAIL_STATE_DIR || path.join(os.homedir(),'.logical-mail','state'),`identity-${identityKey}.json`)
  const who=values.identity || await withStateLock(identityFile,async()=>{
    const saved=loadState(identityFile)
    if (typeof saved.identity === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(saved.identity)) return saved.identity
    const name=legacy.key === key && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(legacy.name) ? legacy.name : `agent-${hash}`
    saveState(identityFile,{identity:name})
    return name
  },signal)
  const options = {identity:who,project:key,session:input.session_id,signal}
  const file = statePath(options)
  const cli = path.join(import.meta.dirname,'logical-mail.mjs')
  const readCommand = `node "${cli}" read --identity ${who} --project ${key} --session "${String(input.session_id).replace(/["\r\n]/g,'')}"`
  note = `Logical Mail identity ${who}, project ${key}. Before you change anything another session may be using (restart, recreate or update an shared container or service, move or copy data on a shared disk, deploy, or edit shared hooks or config), tell the others, and again when done: node "${cli}" send --from ${who} --to all --project ${key} --body "<what, where, until when>". Reply to one session with --to <identity> --reply-to <UUID>. Read with ${readCommand}. T3 is for urgent steering.`
  const client = createClient({timeoutMs:1000,signal})
  if (mode === 'start') {
    await readInbox(client,{...options,deliver:messages=>emit(`${note}${messages.length ? '\n'+formatMessages(messages) : '\nNo unread mail.'}`)})
  } else if (mode === 'check') {
    const due=await withStateLock(file,async () => {
      const state = loadState(file)
      if (Date.now() - (state.lastCheck || 0) < 60_000) return false
      // Stamp first so an unavailable server cannot cause a request after every tool.
      saveState(file,{...state,lastCheck:Date.now()})
      return true
    },signal)
    if (!due) return
    const messages = await checkInbox(client,options)
    await withStateLock(file,async () => {
      const state=loadState(file)
      const fresh = messages.filter(m=>!(state.announced || []).includes(m.id))
      if (!fresh.length) return
      emit(`Logical Mail: ${fresh.length} new message(s) for ${who} from ${[...new Set(fresh.map(m=>m.from))].join(', ')}. ${readCommand}`)
      saveState(file,{...loadState(file),announced:[...new Set([...(state.announced || []),...fresh.map(m=>m.id)])]})
    },signal)
  }
}
main().catch(()=>{ if (mode === 'start' && note) emit(`${note}\nLogical Mail unavailable or hook budget reached. Use the read command to finish a long resume.`) }).finally(()=>{process.exitCode=0})
