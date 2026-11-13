import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const source = pathToFileURL(fileURLToPath(new URL('../logical-mail.mjs',import.meta.url))).href

function probe(configUrl) {
  const code = `
    import fs from 'node:fs'
    import cp from 'node:child_process'
    import {syncBuiltinESMExports} from 'node:module'
    const {createClient}=await import(${JSON.stringify(source)})
    cp.execFileSync=()=>{throw Error('Synthetic git credential unavailable')}
    syncBuiltinESMExports()
    fs.readFileSync=file=>{
      if(String(file).endsWith('config.toml')) return ${JSON.stringify('[hosts.synthetic]\nurl = "')}+${JSON.stringify(configUrl)}+${JSON.stringify('"\ntoken = "synthetic-fixture-value"\n')}
      throw Error('Synthetic credential config absent')
    }
    let calls=0
    globalThis.fetch=async()=>{calls++;return new Response('[]',{status:200})}
    let rejected=false
    try{await createClient({url:'https://git.example.org',repo:'example/inbox'}).request('mail')}catch{rejected=true}
    console.log(JSON.stringify({calls,rejected}))
  `
  const result=spawnSync(process.execPath,['--input-type=module'],{input:code,encoding:'utf8',windowsHide:true,env:{...process.env,LOGICAL_MAIL_TOKEN:'',FORGEJO_TOKEN:''}})
  assert.equal(result.status,0,result.stderr)
  return JSON.parse(result.stdout)
}

test('legacy Forgejo credentials never cross origins',()=>{
  for(const url of ['https://git.example.org.other.invalid','http://git.example.org','https://git.example.org:8443']) {
    assert.deepEqual(probe(url),{calls:0,rejected:true},url)
  }
})

test('legacy Forgejo credentials match the configured origin',()=>{
  assert.deepEqual(probe('https://git.example.org/'),{calls:1,rejected:false})
})
