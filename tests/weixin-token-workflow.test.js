// 先红后实现：实际运行同源 workflow Node 内联程序；只调用自有 recorder，不执行 GUI/安装/Win32。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const file = new URL('../.github/workflows/weixin-qualification.yml', import.meta.url)
const workflow = parse(fs.readFileSync(file, 'utf8')), job = workflow.jobs.native
const before = spawnSync('git', ['show', '80eef635199d5afe7610d898531c5b69858d9a7c:.github/workflows/weixin-qualification.yml'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
assert.equal(before.status, 0)
const original = parse(before.stdout)
const select = w => ({ plan: w.jobs.native.steps.find(s => s.name?.startsWith('先检查完整SHA')), execute: w.jobs.native.steps.find(s => s.env?.QUALIFICATION_SCOPE), summary: w.jobs.native.steps.find(s => s.if === 'always()' && s.run) })
const steps = select(workflow), oldSteps = select(original)
function inline(step) {
  const m = /node --input-type=module -e @'\r?\n([\s\S]+?)\r?\n'@/.exec(step.run)
  assert.ok(m, 'plan/execute/summary 均须可真实运行同源 Node inline')
  return m[1]
}
function own(t) {
  const parent = fs.realpathSync.native(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'wx-token-workflow-'))
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(root)), parent); fs.rmSync(root, { recursive: true, force: true }) })
  fs.mkdirSync(path.join(root, 'tooling/scripts'), { recursive: true }); fs.writeFileSync(path.join(root, 'tooling/package.json'), '{"type":"module"}')
  const harness = pathToFileURL(fileURLToPath(new URL('../scripts/test-weixin-windows-qualification.mjs', import.meta.url))).href
  fs.writeFileSync(path.join(root, 'tooling/scripts/test-weixin-windows-qualification.mjs'), `import fs from 'node:fs';import{parseArgs}from ${JSON.stringify(harness)};const argv=process.argv.slice(2);parseArgs(argv);fs.writeFileSync(process.env.OWN_CAPTURE,JSON.stringify({argv,nativeExecuted:false}));process.exit(23)`)
  fs.copyFileSync(new URL('../scripts/weixin-native-token-observation.mjs', import.meta.url), path.join(root, 'tooling/scripts/weixin-native-token-observation.mjs'))
  return root
}
function run(step, env, root) {
  const childEnv = { ...process.env }; delete childEnv.OBSERVE_APP_TOKEN
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v
  return spawnSync(process.execPath, ['--input-type=module', '-e', inline(step)], { cwd: root, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 10000 })
}
function evidence(name, value) {
  if (!process.env.CLAWPANEL_TOKEN_WORKFLOW_EVIDENCE) return
  fs.mkdirSync(process.env.CLAWPANEL_TOKEN_WORKFLOW_EVIDENCE, { recursive: true })
  fs.writeFileSync(path.join(process.env.CLAWPANEL_TOKEN_WORKFLOW_EVIDENCE, name + '.json'), JSON.stringify({ scope: 'own Node inline recorder / synthetic report, not VM token proof', qualificationPass: false, ...value }, null, 2), { flag: 'wx' })
}
const envFor = root => ({ CANDIDATE_SHA: 'a'.repeat(40), DIAGNOSTIC_ATTACH: 'true', OPENCLAW_HOST_VERSION: '2026.10.4', QUALIFICATION_SCOPE: 'complete', RUNNER_TEMP: root })

test('token input默认false；原workflow权限/矩阵/版本/预算/路径/actions及4旧测试字节不变', () => {
  const inputs = workflow.on.workflow_dispatch.inputs, oldInputs = original.on.workflow_dispatch.inputs
  assert.equal(inputs.observe_app_token.type, 'boolean'); assert.equal(inputs.observe_app_token.required, false); assert.equal(inputs.observe_app_token.default, false)
  const restored = structuredClone(workflow); delete restored.on.workflow_dispatch.inputs.observe_app_token
  for (let i = 0; i < job.steps.length; i++) {
    const step = restored.jobs.native.steps[i], prior = original.jobs.native.steps[i]
    if (step.run) { delete step.env.OBSERVE_APP_TOKEN; if (step === restored.jobs.native.steps.find(s => s.name?.startsWith('先检查完整SHA'))) delete step.env.OPENCLAW_HOST_VERSION; step.run = prior.run }
  }
  assert.deepEqual(restored, original)
  for (const key of Object.keys(oldInputs)) assert.deepEqual(inputs[key], oldInputs[key])
  for (const step of Object.values(steps)) assert.equal(step.env.OBSERVE_APP_TOKEN, '${{ inputs.observe_app_token }}')
  for (const name of ['tests/weixin-attach-workflow.test.js', 'scripts/test-weixin-windows-qualification.mjs', 'scripts/weixin-native-token-observation.mjs', 'tests/weixin-native-token-observation.test.js']) {
    const r = spawnSync('git', ['show', `80eef635199d5afe7610d898531c5b69858d9a7c:${name}`], { windowsHide: true, timeout: 10000 })
    assert.equal(r.status, 0); assert.deepEqual(fs.readFileSync(new URL('../' + name, import.meta.url)), r.stdout, name)
  }
})

for (const phase of ['plan', 'execute']) {
  test(`${phase} 实际inline own recorder：undefined/false原argv，true显式token flag，原exit23`, t => {
    const root = own(t), rows = []
    for (const [value, diagnostic, host] of [[undefined, 'true', '2026.10.4'], ['false', 'true', '2026.10.4'], [undefined, 'false', '2026.5.12'], ['false', 'false', '2026.9.8'], ['false', 'false', '2026.10.4'], ['true', 'true', '2026.10.4']]) {
      const env = { ...envFor(root), OBSERVE_APP_TOKEN: value, DIAGNOSTIC_ATTACH: diagnostic, OPENCLAW_HOST_VERSION: host, OWN_CAPTURE: path.join(root, `${phase}-${rows.length}.json`) }
      const r = run(steps[phase], env, root); assert.equal(r.status, 23, r.stderr)
      const actual = JSON.parse(fs.readFileSync(env.OWN_CAPTURE, 'utf8'))
      const args = phase === 'plan' ? ['--plan'] : ['--execute', '--root', 'candidate', '--sha', env.CANDIDATE_SHA, '--host', host]
      if (diagnostic === 'true') args.push('--diagnostic-attach'); else if (phase === 'execute') args.push('--scope', env.QUALIFICATION_SCOPE)
      if (value === 'true') args.push('--observe-app-token')
      if (phase === 'plan') args.push('--sha', env.CANDIDATE_SHA); else args.push('--output', root + '/weixin-native-' + host)
      assert.deepEqual(actual, { argv: args, nativeExecuted: false })
      rows.push({ value: value ?? 'undefined', diagnostic, host, actual, childExit: r.status })
    }
    evidence(phase + '-argv', { rows })
  })
  test(`${phase} 坏bool/true无diag/非10.4在child前拒绝`, t => {
    const root = own(t), rows = []
    for (const patch of [{ OBSERVE_APP_TOKEN: '' }, { OBSERVE_APP_TOKEN: 'TRUE' }, { OBSERVE_APP_TOKEN: '1' }, { OBSERVE_APP_TOKEN: 'true ' }, { OBSERVE_APP_TOKEN: 'null' }, { OBSERVE_APP_TOKEN: 'true', DIAGNOSTIC_ATTACH: 'false' }, { OBSERVE_APP_TOKEN: 'true', OPENCLAW_HOST_VERSION: '2026.9.8' }, { OBSERVE_APP_TOKEN: 'true', OPENCLAW_HOST_VERSION: '2026.5.12' }]) {
      const env = { ...envFor(root), ...patch, OWN_CAPTURE: path.join(root, `${phase}-bad-${rows.length}.json`) }, r = run(steps[phase], env, root)
      assert.notEqual(r.status, 0); assert.equal(fs.existsSync(env.OWN_CAPTURE), false, '不得先运行child再验证')
      rows.push({ patch, status: r.status, noChild: true })
    }
    evidence(phase + '-rejects', { rows })
  })
}

function tokenReport() {
  const date = '2026-10-17T01:00:00.0000000Z', ticks = String(BigInt(Date.parse(date)) * 10000n + 116444736000000000n)
  const subject = (pid, parentPid, exe) => ({ pid, parentPid, exe, cimCreationUtc: date, fileTimeCreationUtc: date, cimFileTimeTicks: ticks, fileTimeTicks: ticks, delta100ns: 0, birthComparison: 'same-cim-microsecond', userSid: 'S-1-5-21-1-2-3-1001', integritySid: 'S-1-16-8192', integrityRid: 8192, isElevated: false, elevationType: 3, tokenType: 1, sessionId: 1, uiAccess: false, linked: { state: 'present', exists: true } })
  return { status: 'diagnostic-ui-ipc-observed', scope: 'diagnostic-attach', executionMode: 'actual-github-hosted-windows-vm-weixin-attach-diagnostic', nativeQualification: false, candidateSha: 'a'.repeat(40), gaps: ['native: NOT EXECUTED'], diagnostic: { tokenObservationRequested: true, application: 'C:\\owned\\clawpanel.exe', appSpawnStartedAt: date, appIdentity: { pid: 1002, exe: 'C:\\owned\\clawpanel.exe', creationDate: date }, tokenObservation: { mode: 'readonly-win32-process-primary-token', neverQualification: true, app: subject(1002, 1001, 'C:\\owned\\clawpanel.exe'), parent: subject(1001, 1000, 'C:\\owned\\node.exe') } } }
}
function reportFile(root) { const dir = path.join(root, 'weixin-native-2026.10.4/public'); fs.mkdirSync(dir, { recursive: true }); return path.join(dir, 'report.json') }

test('requested summary：完整存储proof才标observed，缺/坏/矛盾proof和无report均红且neverqualification', t => {
  const root = own(t), file = reportFile(root), rows = []
  const mutations = [null, r => delete r.diagnostic.tokenObservation, r => r.diagnostic.tokenObservation = { mode: 'readonly-win32-process-primary-token', neverQualification: true }, r => r.diagnostic.tokenObservationRequested = false, r => r.diagnostic.tokenObservation.neverQualification = false, r => r.diagnostic.tokenObservation.app.pid++, r => r.diagnostic.tokenObservation.parent.userSid += '9', r => r.diagnostic.tokenObservation.app.environment = {}, r => r.diagnostic.appIdentity.creationDate = '2026-10-17T01:00:01.0000000Z', r => r.nativeQualification = true, r => r.status = 'pass-native']
  for (const mutation of mutations) {
    const report = tokenReport(); if (mutation) mutation(report); fs.writeFileSync(file, JSON.stringify(report))
    const summary = path.join(root, `requested-${rows.length}.md`), r = run(steps.summary, { ...envFor(root), OBSERVE_APP_TOKEN: 'true', GITHUB_STEP_SUMMARY: summary }, root)
    const text = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : ''
    assert.equal(r.status === 0, mutation === null, r.stderr)
    assert.ok(text.includes('neverQualification=true') && text.includes('NOT QUALIFIED'))
    assert.equal(text.includes('Token proof observed:'), mutation === null)
    if (mutation) assert.ok(!text.includes('Observed status:'))
    rows.push({ mutation: mutation ? mutation.toString() : 'synthetic full receipt; not actual VM token', status: r.status, text })
  }
  fs.unlinkSync(file)
  const summary = path.join(root, 'missing.md'), r = run(steps.summary, { ...envFor(root), OBSERVE_APP_TOKEN: 'true', GITHUB_STEP_SUMMARY: summary }, root)
  assert.notEqual(r.status, 0); assert.ok(!fs.readFileSync(summary, 'utf8').includes('Token proof observed:'))
  for (const patch of [{ OBSERVE_APP_TOKEN: '' }, { OBSERVE_APP_TOKEN: 'TRUE' }, { OBSERVE_APP_TOKEN: 'true', DIAGNOSTIC_ATTACH: 'false' }, { OBSERVE_APP_TOKEN: 'true', OPENCLAW_HOST_VERSION: '2026.9.8' }]) assert.notEqual(run(steps.summary, { ...envFor(root), ...patch, GITHUB_STEP_SUMMARY: summary }, root).status, 0)
  evidence('requested-summary', { rows, missingReportRejected: true })
})

test('undefined/false summary：与80eef原inline逐字相同，token报告字段不默默变成observed', t => {
  const root = own(t), file = reportFile(root), rows = []
  for (const observe of [undefined, 'false']) for (const diagnostic of ['false', 'true']) {
    fs.writeFileSync(file, JSON.stringify(diagnostic === 'true' ? tokenReport() : { status: 'failed', scope: 'complete', candidateSha: 'a'.repeat(40), gaps: ['old gap'] }))
    const env = { ...envFor(root), DIAGNOSTIC_ATTACH: diagnostic, OBSERVE_APP_TOKEN: observe }, a = path.join(root, `new-${rows.length}.md`), b = path.join(root, `old-${rows.length}.md`)
    const now = run(steps.summary, { ...env, GITHUB_STEP_SUMMARY: a }, root), old = run(oldSteps.summary, { ...env, GITHUB_STEP_SUMMARY: b }, root)
    assert.equal(now.status, old.status); assert.deepEqual(fs.readFileSync(a), fs.readFileSync(b)); assert.ok(!fs.readFileSync(a, 'utf8').includes('Token proof observed:'))
    rows.push({ observe: observe ?? 'undefined', diagnostic, byteEqual: true })
  }
  evidence('disabled-summary', { rows })
})
