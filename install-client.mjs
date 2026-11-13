#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

function replace(text) {
  return text.replaceAll('scripts/agent-mail/','scripts/logical-mail/')
    .replaceAll('agent-mail-join','logical-mail-start').replaceAll('agent-mail-inbox','logical-mail-inbox')
    .replaceAll('"agent mail"','"logical mail"')
}

function migrate(value) {
  if (typeof value === 'string') return replace(value)
  if (Array.isArray(value)) return value.map(migrate)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key])=>!['agent-mail','agent_mail'].includes(key)).map(([key,v])=>[replace(key),migrate(v)]))
  }
  return value
}

export function installClient({home=os.homedir(),homeRepo,sourceOnly=false}) {
  if (!homeRepo) throw new Error('--home-repo is required')
  const changed=[]
  const stamp = new Date().toISOString().replace(/[:.]/g,'-')
  const update = (file,text) => {
    const old = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : null
    if (old === text) return
    if (old !== null && !sourceOnly) {
      const backup=path.join(home,'.logical-mail','backups',stamp,Buffer.from(file).toString('hex'))
      fs.mkdirSync(path.dirname(backup),{recursive:true})
      fs.writeFileSync(backup,old,{mode:0o600})
    }
    fs.mkdirSync(path.dirname(file),{recursive:true})
    fs.writeFileSync(file,text,{mode:0o600})
    changed.push(file)
  }
  if (!sourceOnly) {
    for (const name of ['logical-mail.mjs','hook.mjs','install-client.mjs']) update(path.join(home,'.logical-mail','client',name),fs.readFileSync(path.join(import.meta.dirname,name),'utf8'))
  }
  for (const [name,mode] of [['join','start'],['inbox','check']]) {
    update(path.join(homeRepo,'scripts','logical-mail',`${name}.mjs`),`// Installed by example/logical-mail. No server registration.\nimport os from 'node:os'\nimport path from 'node:path'\nimport { pathToFileURL } from 'node:url'\nprocess.argv.splice(2,0,'${mode}')\nawait import(pathToFileURL(path.join(process.env.LOGICAL_MAIL_CLIENT || path.join(os.homedir(),'.logical-mail','client'),'hook.mjs')).href)\n`)
  }
  const jsonFiles = new Set([
    ...[home,homeRepo].flatMap(root=>['.claude/settings.json','.claudework/settings.json','.claude.json','.claudework/.claude.json','.codex/hooks.json','.codex/parity-toggles.json','.pi/agent/mcp.json','.config/opencode/opencode.json'].map(file=>path.join(root,file))),
    ...['hooks.json','parity-toggles.json','toggles-probe.json'].map(file=>path.join(homeRepo,'scripts','codex-parity',file)),
    ...(!sourceOnly && process.env.CLAUDE_CONFIG_DIR ? ['.claude.json','settings.json','settings.local.json'].map(file=>path.join(process.env.CLAUDE_CONFIG_DIR,file)) : []),
  ])
  for (const file of jsonFiles) {
    if (!fs.existsSync(file)) continue
    const original=fs.readFileSync(file,'utf8')
    const data=migrate(JSON.parse(original.replace(/^\uFEFF/,'')))
    // Preserve the formatting of unaffected files and all unrelated values.
    if (JSON.stringify(data) !== JSON.stringify(JSON.parse(original.replace(/^\uFEFF/,'')))) {
      const replaced=replace(original)
      update(file,JSON.stringify(JSON.parse(replaced.replace(/^\uFEFF/,''))) === JSON.stringify(data) ? replaced : JSON.stringify(data,null,2)+'\n')
    }
  }
  for (const root of new Set([home,homeRepo])) {
    const file=path.join(root,'.codex','config.toml')
    if (!fs.existsSync(file)) continue
    const original=fs.readFileSync(file,'utf8')
    let skip=false
    const text=original.split(/(?<=\n)/).filter(line=>{
      if (/^\s*\[/.test(line)) skip=/^\s*\[mcp_servers\.(?:agent_mail|agent-mail)(?:[.\]])/.test(line)
      return !skip
    }).join('')
    if (text!==original) update(file,text)
  }
  return changed
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const {values}=parseArgs({options:{home:{type:'string'},'home-repo':{type:'string'},'source-only':{type:'boolean'}}})
  try {
    const files=installClient({home:values.home,homeRepo:values['home-repo'],sourceOnly:values['source-only']})
    console.log(`Logical Mail installed, ${files.length} files changed. Previous config retained under ~/.logical-mail/backups.`)
  } catch { console.error('Logical Mail installation failed. Check paths and config syntax.');process.exitCode=1 }
}
