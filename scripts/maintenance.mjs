/** 每日维护入口：默认只读；写入仅限自有通知和草稿候选，没有合并/tag/发版入口。 */
import fs from 'node:fs'
import path from 'node:path'
import { project, readJson, redact, writeJson } from './maintenance/core.mjs'
import { Sources } from './maintenance/github.mjs'
import { scan } from './maintenance/scan.mjs'
import { guard } from './maintenance/guard.mjs'
import { notify, propose } from './maintenance/publish.mjs'
import { verifyPins } from './maintenance/pins.mjs'

const [command, ...args] = process.argv.slice(2), options = {}
try {
  const flags = new Set(['fixture', 'apply'])
  const valued = new Set(['root', 'output', 'github-url', 'registry-url', 'report', 'patch', 'result'])
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '')
    if (args[i] !== '--' + key || (!flags.has(key) && !valued.has(key)) || key in options) throw new Error('无效或重复参数')
    options[key] = flags.has(key) ? true : args[++i]
    if (!options[key] || options[key].startsWith?.('--')) throw new Error('参数缺少值')
  }
  const root = path.resolve(options.root || project)
  const file = key => { if (!options[key]) throw new Error(`缺少 --${key}`); return path.resolve(options[key]) }
  let result
  if (command === 'scan') {
    const output = path.resolve(options.output || path.join(root, '.tmp/maintenance/latest'))
    const report = await scan(new Sources(options), root, output)
    result = { complete: report.complete, output, fingerprint: report.fingerprint, selected: report.selected?.id || null, autoRelease: false }
    if (!report.complete) process.exitCode = 2
  } else if (command === 'guard') {
    result = guard(root, readJson(file('report')), file('patch'), file('result'))
  } else if (command === 'pins') {
    result = verifyPins(root, readJson(file('report')))
  } else if (command === 'notify') {
    result = await notify(new Sources(options), readJson(file('report')), !!options.apply)
  } else if (command === 'propose') {
    result = await propose(new Sources(options), root, readJson(file('report')), file('patch'), file('result'), !!options.apply)
  } else throw new Error('命令仅支持 scan / guard / pins / notify / propose')
  if (options.output && command !== 'scan') writeJson(path.join(path.resolve(options.output), `${command}.json`), result)
  console.log(JSON.stringify(result))
} catch (error) {
  const result = { ok: false, error: redact(error.message), autoRelease: false }
  if (options.output) { fs.mkdirSync(path.resolve(options.output), { recursive: true }); writeJson(path.join(path.resolve(options.output), 'failure.json'), result) }
  console.error(JSON.stringify(result))
  process.exitCode = 1
}
