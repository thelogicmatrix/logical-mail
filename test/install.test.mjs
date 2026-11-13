import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('installer preserves unrelated config, removes old MCP, and survives repeat install',async () => {
  const mod=await import('../install-client.mjs').catch(()=>({}))
  assert.equal(typeof mod.installClient,'function','portable installer is missing')
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'logical-install-'))
  fs.mkdirSync(path.join(home,'.claude'),{recursive:true})
  fs.mkdirSync(path.join(home,'.codex'),{recursive:true})
  fs.writeFileSync(path.join(home,'.claude','settings.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'node C:/Users/user/scripts/agent-mail/join.mjs'}]}]},keep:42}))
  fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({mcpServers:{'agent-mail':{url:'old'},other:{command:'keep'}},projects:{example:{mcpServers:{agent_mail:{url:'old'},other:{command:'keep'}}}}}))
  fs.writeFileSync(path.join(home,'.codex','config.toml'),'model = "test"\n[mcp_servers.agent_mail]\nurl="old"\n[mcp_servers.other]\ncommand="keep"\n')
  await mod.installClient({home,homeRepo:home})
  await mod.installClient({home,homeRepo:home})
  const settings=JSON.parse(fs.readFileSync(path.join(home,'.claude','settings.json')))
  assert.equal(settings.keep,42)
  assert.match(settings.hooks.SessionStart[0].hooks[0].command,/scripts\/logical-mail\/join.mjs/)
  const config=JSON.parse(fs.readFileSync(path.join(home,'.claude.json')))
  assert.deepEqual(config.mcpServers,{other:{command:'keep'}})
  assert.deepEqual(config.projects.example.mcpServers,{other:{command:'keep'}})
  assert.equal(fs.readFileSync(path.join(home,'.codex','config.toml'),'utf8'),'model = "test"\n[mcp_servers.other]\ncommand="keep"\n')
  assert.ok(fs.existsSync(path.join(home,'.logical-mail','client','logical-mail.mjs')))
})
