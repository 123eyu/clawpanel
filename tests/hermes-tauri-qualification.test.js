import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const load = () => import('../scripts/test-hermes-tauri-qualification.mjs')
const home = 'C:\\qualification\\h'
const listener = (port = 18791) => ({ port, pid: 401, creationDate: '2026-10-16T01:00:00.000Z', executablePath: home + '\\.hermes\\venv\\Scripts\\python.exe', commandLine: 'python -m hermes_cli gateway run' })
const stopped = () => ({ productionStop: true, identities: [listener()], present: [], listeners: [], ports: [18791], reachablePorts: [], pidsExited: true, portsClosed: true })
function completeFixture(NATIVE_STEPS) {
  const round = n => ({ round: n, steps: [...NATIVE_STEPS], gatewayListeners: [listener()], profiles: { active: 'default', profiles: [{ name: 'default' }] }, stopProofs: [stopped(), stopped()], samples: Array.from({ length: 42 }, (_, i) => ({ startedMs: i * 5000, finishedMs: i * 5000 + 100, health: { status: 'ok', platform: 'hermes-agent', version: '0.21.5' }, listeners: [listener()] })), elapsedSeconds: 210, observedErrors: [], historyReadbackAfterStop: true, prompts: [{ nonce: `native-${n}-a`, model: 'one' }, { nonce: `native-${n}-b`, model: 'one' }] })
  const rounds = [round(1), round(2)]
  return { completed: true, hostUnchanged: true, runtimeHome: home, gatewayPort: 18791, expectedVersion: '0.21.5', nativePage: { url: 'http://tauri.localhost/', ipc: true, windowLabel: 'main' }, rounds, cleanup: { ...stopped(), final: stopped() }, nativeInstallerLifecycle: ['update', 'uninstall', 'reinstall'].map(name => ({ name, passed: true, dataPreserved: true })), nativeProcessesExited: true, driverPortsClosed: true, provider: rounds.flatMap(x => x.prompts.map(p => ({ ...p, title: false, authenticated: true }))) }
}
const appSha = 'a'.repeat(40), seedSha = 'b'.repeat(40)
const oldCommit = 'f97608f178d1ffeca59860195ab7da295f7c8e5f', newCommit = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
const digest = '1'.repeat(64)
function seedFixture() {
  const runner = { sid: 'S-1-5-21-1-2-3-4', actualProfile: 'C:\\Users\\runneradmin', runId: '123', attempt: '1', imageOS: 'win25', imageVersion: '20261016', virtualMachine: true }
  return { appSha, seedSha, home, webOutput: 'C:\\qualification', runner, seedProof: { ...runner }, release: { version: '0.21.5', commit: oldCommit }, completion: { version: '0.21.5', commit: oldCommit }, prior: { status: 'passed-web-native-missing', candidateSha: seedSha, expectedVersion: '0.21.5', hostUnchanged: true, environment: { home, hermesHome: home + '\\.hermes', sourceSha: seedSha }, stages: ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve'].map(name => ({ name, status: 'passed' })), browser: { actualChromium: true, completeReply: true, historyAfterReload: true, pageErrors: [], trace: 'trace.zip', screenshots: ['history.png'], prompts: [{ nonce: 'hq-seed', reply: 'seed reply', model: 'seed' }] } } }
}
function bindingFixture() {
  return { candidateSha: appSha, rootSha: appSha, sourceHashes: Object.fromEntries(['scripts/dev-api.js', 'src-tauri/src/commands/hermes.rs', 'src-tauri/src/lib.rs', 'src-tauri/Cargo.lock', 'package.json'].map(f => [f, digest])), sourceManifestSha256: digest, application: { path: 'C:\\candidate\\clawpanel.exe', sha256: digest }, build: { status: 'passed', candidateSha: appSha, hostUnchanged: true, sourceManifestSha256: digest, application: { path: 'C:\\candidate\\clawpanel.exe', sha256: digest } } }
}
function compatibilityFixture(NATIVE_STEPS) {
  const r = completeFixture(NATIVE_STEPS)
  delete r.nativeInstallerLifecycle
  Object.assign(r, { mode: 'new-app-old-runtime-native', status: 'passed-native-old-runtime-compatibility', seedSha, candidateSha: appSha, ipc: [], application: bindingFixture().application, webQualification: { path: 'C:\\qualification', sha256: digest } })
  r.compatibility = { seed: seedFixture(), appPin: { version: '0.22.2', commit: newCommit }, binding: bindingFixture(), blockedInstallerCommands: [], runtimeChecks: ['before-ui', 'after-round-1', 'after-round-2', 'after-ui'].map(phase => ({ phase, installed: true, version: '0.21.5', commit: oldCommit, hermesHome: home + '\\.hermes' })), finalRuntimeHead: oldCommit, seedMemoryPreserved: true, seedHistoryPreserved: true }
  return r
}

test('实际 Rust 配置目录契约是对象，拒绝字符串、缺失配置和其他 HOME', async () => {
  const { assertNativeConfigDir } = await load()
  assert.equal(typeof assertNativeConfigDir, 'function')
  const dir = process.cwd()
  assert.doesNotThrow(() => assertNativeConfigDir({ path: dir, isCustom: true, configExists: true }, dir))
  for (const bad of [dir, { path: dir }, { path: dir, isCustom: false, configExists: true }, { path: dir, isCustom: true, configExists: false }, { path: dir + '/other', isCustom: true, configExists: true }]) assert.throws(() => assertNativeConfigDir(bad, dir))
})

test('native 必须实际走 Rust 更新、卸载及保留历史重装，不由既有 Web 安装代替', () => {
  const source = fs.readFileSync(new URL('../scripts/test-hermes-tauri-qualification.mjs', import.meta.url), 'utf8')
  assert.match(source, /ipc\('update_hermes', \{\}, 900000\)/)
  assert.match(source, /ipc\('uninstall_hermes', \{ cleanConfig: false \}\)/)
  assert.match(source, /ipc\('install_hermes', \{ method: 'uv-tool', extras: \[\] \}, 900000\)/)
  assert.match(source, /nativeInstallerLifecycle/)
  assert.match(source, /hermes-install-log/)
})

test('native Tauri 计划只在一次性 Windows runner 执行，不以 Web 代替', async () => {
  const q = await load()
  const plan = q.nativePlan()
  assert.equal(plan.installsOnLocalHost, false)
  assert.equal(plan.webdriver, 'tauri-driver + Microsoft Edge Driver')
  assert.equal(plan.uiRounds, 2)
  assert.equal(plan.holdSeconds, 210)
  assert.equal(plan.webFallback, false)
  assert.equal(plan.productPluginsAdded, false)
})

test('native 参数拒绝浮动 SHA、未知参数和缩短长会话验收', async () => {
  const { nativeArgs } = await load()
  assert.throws(() => nativeArgs(['--sha', 'main']), /SHA/)
  assert.throws(() => nativeArgs(['--execute', '--hold', '10']), /210/)
  assert.throws(() => nativeArgs(['--mock']), /未知/)
  assert.throws(() => nativeArgs(['--version', 'latest']), /版本/)
})

test('native 来源拒绝普通 Web、远程页面、无真实 IPC 及窗口身份', async () => {
  const { assertNativePage } = await load()
  const identity = { url: 'http://tauri.localhost/', ipc: true, windowLabel: 'main' }
  assert.doesNotThrow(() => assertNativePage(identity))
  assert.doesNotThrow(() => assertNativePage({ ...identity, url: 'tauri://localhost/' }))
  for (const bad of [
    { url: 'http://127.0.0.1:1420/' }, { url: 'https://example.test/' },
    { url: 'http://tauri.localhost.evil/' }, { ipc: false }, { windowLabel: '' },
  ]) assert.throws(() => assertNativePage({ ...identity, ...bad }), /native/)
})

test('W3C 真实协议错误不伪造成功、不回退到 HTTP API', async () => {
  const { NativeWebDriver } = await load()
  const calls = []
  const server = http.createServer(async (req, res) => {
    calls.push(req.url)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ value: { error: 'session not created', message: 'driver mismatch' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new NativeWebDriver(`http://127.0.0.1:${server.address().port}`)
    await assert.rejects(client.create('C:\\candidate\\clawpanel.exe'), /driver mismatch/)
    assert.deepEqual(calls, ['/session'])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('本机 execute 在任何候选/driver 启动前拒绝', async () => {
  await load()
  const r = spawnSync(process.execPath, [new URL('../scripts/test-hermes-tauri-qualification.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--execute'], {
    env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', GITHUB_WORKFLOW_REF: '' },
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /一次性|资格|runner/)
})

test('native 完整回执拒绝短测、漏步骤、运行错误和原生进程残留', async () => {
  const { assertNativeComplete, NATIVE_STEPS } = await load()
  const r = completeFixture(NATIVE_STEPS)
  assert.doesNotThrow(() => assertNativeComplete(r))
  for (const mutate of [
    x => { x.rounds[0].samples.pop() }, x => { x.rounds[1].elapsedSeconds = 209 },
    x => { x.rounds[0].steps.pop() }, x => { x.rounds[1].observedErrors.push('error') },
    x => { x.cleanup.pidsExited = false }, x => { x.nativeProcessesExited = false },
    x => { x.provider.push(x.provider[0]) }, x => { x.hostUnchanged = false }, x => { x.rounds[0].historyReadbackAfterStop = false },
    x => { x.nativeInstallerLifecycle.pop() }, x => { x.nativeInstallerLifecycle[0].passed = false }, x => { x.nativeInstallerLifecycle[2].dataPreserved = false },
  ]) { const bad = structuredClone(r); mutate(bad); assert.throws(() => assertNativeComplete(bad)) }
})

test('完整门禁拒绝补采、错误health、空PID及伪profiles证明', async () => {
  const { assertNativeComplete, NATIVE_STEPS } = await load()
  for (const mutate of [
    r => { r.rounds[0].samples.forEach(s => { s.startedMs = 0; s.finishedMs = 100 }) },
    r => { r.rounds[0].samples[0].finishedMs = 5000 },
    r => { r.rounds[0].samples[1].health.status = 'error' },
    r => { r.rounds[0].samples[1].health.platform = 'other' },
    r => { r.rounds[0].samples[1].health.version = '0.22.2' },
    r => { r.rounds[0].gatewayListeners = [] },
    r => { r.rounds[0].samples[1].listeners = [] },
    r => { r.rounds[0].samples[1].listeners[0].creationDate = '2026-10-16T01:01:00.000Z' },
    r => { r.rounds[0].stopProofs = [] },
    r => { r.cleanup.identities = [] },
    r => { r.cleanup.final.present = [listener()] },
    r => { r.cleanup.final.listeners = [listener()] },
    r => { r.cleanup.final.reachablePorts = [18791] },
    r => { r.cleanup.final.ports = [] },
    r => { r.rounds[0].profiles = { active: 'default', profiles: [] } },
    r => { r.rounds[0].profiles = { active: 'default', profiles: { name: 'default' } } },
  ]) { const bad = completeFixture(NATIVE_STEPS); mutate(bad); assert.throws(() => assertNativeComplete(bad)) }
})

test('严格42窗口调度：慢IPC跨窗立即失败，不补采；健康三字段实际校验', async () => {
  const { collectNativeSamples } = await load()
  assert.equal(typeof collectNativeSamples, 'function')
  let clock = 0, count = 0
  const item = { samples: [] }
  const options = { item, version: '0.21.5', home, port: 18791, expected: [listener()], now: () => clock, sleep: async ms => { clock += ms }, sample: async () => { count++; clock += 100; return { health: { status: 'ok', platform: 'hermes-agent', version: '0.21.5' }, listeners: [listener()] } } }
  await collectNativeSamples(options)
  assert.equal(clock, 210000); assert.equal(count, 42); assert.equal(item.samples.length, 42)
  for (const duration of [5000, 60000]) {
    clock = 0; count = 0
    await assert.rejects(collectNativeSamples({ ...options, item: { samples: [] }, sample: async () => { count++; clock += duration; return { health: { status: 'ok', platform: 'hermes-agent', version: '0.21.5' }, listeners: [listener()] } } }), /窗口/)
    assert.equal(count, 1, '跨窗后不得补采剩余41条')
  }
  for (const patch of [{ status: 'error' }, { platform: 'wrong' }, { version: '0.22.2' }]) {
    clock = 0
    await assert.rejects(collectNativeSamples({ ...options, item: { samples: [] }, sample: async () => ({ health: { status: 'ok', platform: 'hermes-agent', version: '0.21.5', ...patch }, listeners: [listener()] }) }))
  }
})

test('监听身份绑定私有HOME+端口+PID+CreationDate，拒绝空集、换代和伪归属', async () => {
  const { assertNativeListeners } = await load()
  assert.equal(typeof assertNativeListeners, 'function')
  const options = { home, ports: [18791], expected: [listener()] }
  assert.doesNotThrow(() => assertNativeListeners([listener()], options))
  for (const rows of [[], [{ ...listener(), pid: 0 }], [{ ...listener(), port: 9119 }], [{ ...listener(), creationDate: null }], [{ ...listener(), creationDate: '2026-10-16T01:02:00.000Z' }], [{ ...listener(), executablePath: 'C:\\Windows\\python.exe', commandLine: 'python' }], [{ ...listener(), executablePath: home + '-other\\python.exe' }]]) assert.throws(() => assertNativeListeners(rows, options))
  assert.doesNotThrow(() => assertNativeListeners([{ ...listener(), executablePath: 'C:\\Python\\python.exe', commandLine: `python "${home}\\.hermes\\hermes-agent\\hermes.py"` }], { home, ports: [18791] }))
})

test('STOP非空身份与全部端口强校验，PID复用不得误认旧进程存活', async () => {
  const { assertNativeStopped } = await load()
  assert.equal(typeof assertNativeStopped, 'function')
  assert.doesNotThrow(() => assertNativeStopped(stopped()))
  assert.doesNotThrow(() => assertNativeStopped({ ...stopped(), present: [{ ...listener(), creationDate: '2026-10-16T02:00:00.000Z' }] }))
  for (const patch of [{ identities: [] }, { ports: [] }, { present: [listener()] }, { listeners: [listener()] }, { reachablePorts: [18791] }]) assert.throws(() => assertNativeStopped({ ...stopped(), ...patch }))
})

test('清理每项独立：截图/STOP失败也执行dashboard、session和最终PID端口校验', async () => {
  const { runNativeCleanup } = await load()
  assert.equal(typeof runNativeCleanup, 'function')
  const calls = []
  const failures = await runNativeCleanup(Object.fromEntries(['screenshot', 'gatewayStop', 'dashboardStop', 'sessionClose', 'driver', 'provider', 'native', 'runtimeFinal', 'portsFinal', 'hostFinal'].map(name => [name, async () => { calls.push(name); if (['screenshot', 'gatewayStop', 'sessionClose'].includes(name)) throw new Error(name + ' failed') }])))
  assert.deepEqual(calls, ['screenshot', 'gatewayStop', 'dashboardStop', 'sessionClose', 'driver', 'provider', 'native', 'runtimeFinal', 'portsFinal', 'hostFinal'])
  assert.deepEqual(failures.map(x => x.step), ['screenshot', 'gatewayStop', 'sessionClose'])
})

test('profiles必须实际数组并含default，明确每次refresh监听空窗', async () => {
  const { assertNativeProfiles } = await load()
  assert.equal(typeof assertNativeProfiles, 'function')
  assert.doesNotThrow(() => assertNativeProfiles({ active: 'default', profiles: [{ name: 'default' }] }))
  for (const bad of [null, true, {}, { active: 'default', profiles: [] }, { profiles: { name: 'default' } }, { profiles: [{ name: 'other' }] }]) assert.throws(() => assertNativeProfiles(bad))
  const source = fs.readFileSync(new URL('../scripts/test-hermes-tauri-qualification.mjs', import.meta.url), 'utf8')
  assert.match(source, /errorObservationScope:[^\n]*every refresh/)
})

test('native Provider只读metadata逐项404留证，不当聊天；unknown/坏JSON/错误chat认证仍红', async () => {
  const { createNativeProvider } = await load()
  assert.equal(typeof createNativeProvider, 'function')
  const report = { provider: [], metadata: [] }
  const server = await createNativeProvider({ report })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (route, body, key = 'qualification-native-no-secret') => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  try {
    const metadata = await request('/api/show', { name: 'native-one' })
    assert.equal(metadata.status, 404)
    assert.equal(report.provider.length, 0)
    assert.equal(report.metadata.length, 1)
    assert.ok(report.metadata[0].kind)
    assert.equal(report.metadata[0].provider, 'ollama')
    assert.equal(report.metadata[0].method, 'POST'); assert.equal(report.metadata[0].path, '/api/show'); assert.equal(report.metadata[0].status, 404)
    assert.ok(!report.providerError)
    for (const route of ['/api/tags', '/v1/models/native-one']) {
      assert.equal((await fetch(base + route)).status, 404)
      const record = report.metadata.at(-1)
      assert.equal(record.kind, 'metadata'); assert.equal(record.method, 'GET'); assert.equal(record.path, route); assert.equal(record.status, 404)
    }
    assert.equal(report.metadata.length, 3); assert.equal(report.provider.length, 0)
    const catalog = await fetch(base + '/v1/models')
    assert.equal(catalog.status, 200)
    assert.deepEqual((await catalog.json()).data.map(m => m.id), ['native-one', 'native-two'])
    assert.equal(report.metadata.at(-1).provider, 'openai-catalog'); assert.equal(report.metadata.at(-1).status, 200)
    assert.equal(report.metadata.length, 4); assert.equal(report.provider.length, 0)
    const nonce = 'native-acceptance-12345678-1234-1234-1234-123456789abc'
    const body = { model: 'native-one', messages: [{ role: 'user', content: nonce }], stream: false }
    const chat = await request('/v1/chat/completions', body)
    assert.equal(chat.status, 200)
    assert.equal((await chat.json()).choices[0].message.content, `原生完整回复：${nonce}；模型：native-one。`)
    assert.equal(report.provider.length, 1); assert.equal(report.provider[0].nonce, nonce); assert.equal(report.provider[0].authenticated, true)
    for (const [route, data, key] of [['/api/unknown', {}, undefined], ['/v1/models', {}, undefined], ['/api/show', '{bad', undefined], ['/api/show', { model: 'native-one' }, undefined], ['/api/show', { name: 'undeclared' }, undefined], ['/v1/chat/completions', body, 'wrong'], ['/v1/chat/completions', { ...body, messages: [] }, undefined]]) {
      delete report.providerError
      assert.equal((await request(route, data, key)).status, 500)
      assert.ok(report.providerError)
      assert.equal(report.metadata.length, 4, 'unknown或坏请求不得冒充metadata')
      assert.equal(report.provider.length, 1, '错误请求不得计入chat')
    }
    delete report.providerError
    const getWithBody = await new Promise((resolve, reject) => {
      const req = http.request(base + '/v1/models', { method: 'GET', headers: { 'content-length': '2' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject); req.end('{}')
    })
    assert.equal(getWithBody, 500); assert.ok(report.providerError); assert.equal(report.metadata.length, 4)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('兼容参数固定21.5与两个不同完整SHA，非seed模式仍保留完整安装资格', async () => {
  const { nativeArgs } = await load()
  assert.equal(nativeArgs(['--sha', appSha, '--seed-sha', seedSha, '--version', '0.21.5'])['--seed-sha'], seedSha)
  for (const args of [ ['--seed-sha', 'main'], ['--seed-sha', seedSha], ['--sha', appSha, '--seed-sha', appSha, '--version', '0.21.5'], ['--sha', appSha, '--seed-sha', seedSha, '--version', '0.22.2'] ]) assert.throws(() => nativeArgs(args))
})

test('兼容seed必须完整旧Web生命周期、同VM、精确HOME与旧source pin', async () => {
  const { assertNativeCompatibilitySeed } = await load()
  assert.equal(typeof assertNativeCompatibilitySeed, 'function')
  assert.doesNotThrow(() => assertNativeCompatibilitySeed(seedFixture()))
  for (const mutate of [ x => { delete x.seedSha }, x => { x.prior.candidateSha = appSha }, x => { x.prior.status = 'failed' }, x => { x.prior.stages.pop() }, x => { x.prior.environment.home += '-other' }, x => { x.home += '-other' }, x => { x.seedProof.runId = 'other' }, x => { x.seedProof.sid += '-other' }, x => { x.release.commit = newCommit }, x => { x.completion.version = '0.22.2' }, x => { x.prior.browser.pageErrors.push('bad') }, x => { x.prior.hostUnchanged = false } ]) { const x = seedFixture(); mutate(x); assert.throws(() => assertNativeCompatibilitySeed(x)) }
})

test('新app必须真实22.2双端pin，build应用与完整新源码绑定不接受旧seed清单', async () => {
  const { assertNativeCompatibilityPins, assertNativeCompatibilityBinding } = await load()
  assert.equal(typeof assertNativeCompatibilityPins, 'function'); assert.equal(typeof assertNativeCompatibilityBinding, 'function')
  const pins = { web: `const HERMES_STABLE_VERSION = '0.22.2'\nconst HERMES_STABLE_COMMIT = '${newCommit}'`, rust: `const HERMES_STABLE_VERSION: &str = "0.22.2";\nconst HERMES_STABLE_COMMIT: &str = "${newCommit}";` }
  assert.deepEqual(assertNativeCompatibilityPins(pins), { version: '0.22.2', commit: newCommit })
  for (const key of ['web', 'rust']) { assert.throws(() => assertNativeCompatibilityPins({ ...pins, [key]: pins[key].replace('0.22.2', '0.21.5') })); assert.throws(() => assertNativeCompatibilityPins({ ...pins, [key]: pins[key].replace(newCommit, oldCommit) })) }
  assert.doesNotThrow(() => assertNativeCompatibilityBinding(bindingFixture()))
  for (const mutate of [ x => { x.rootSha = seedSha }, x => { x.sourceHashes = {} }, x => { x.build.candidateSha = seedSha }, x => { x.build.application.sha256 = '2'.repeat(64) }, x => { x.build.application.path += '-other' }, x => { x.build.sourceManifestSha256 = '2'.repeat(64) }, x => { x.build.status = 'failed' } ]) { const x = bindingFixture(); mutate(x); assert.throws(() => assertNativeCompatibilityBinding(x)) }
})

test('兼容IPC在送出前拒绝所有installer，普通真实W3C IPC仍送出并留证', async () => {
  const { NativeWebDriver } = await load()
  const calls = []
  const server = http.createServer(async (req, res) => { let body = ''; for await (const b of req) body += b; calls.push(JSON.parse(body)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value: { ok: true, value: { installed: true } } })) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new NativeWebDriver(`http://127.0.0.1:${server.address().port}`, { compatibility: true }); client.session = 'actual-protocol-test'
    for (const cmd of ['install_hermes', 'update_hermes', 'uninstall_hermes']) await assert.rejects(client.ipc(cmd), /installer|安装/)
    assert.equal(calls.length, 0)
    assert.deepEqual(client.blockedInstallerCommands, ['install_hermes', 'update_hermes', 'uninstall_hermes'])
    assert.equal((await client.ipc('check_hermes')).installed, true); assert.equal(calls.length, 1); assert.equal(calls[0].args[0], 'check_hermes')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('兼容独立门禁：缺seed/偷调installer/少UI/升级旧source均红，绝不补绿full', async () => {
  const { assertNativeCompatibilityComplete, assertNativeComplete, NATIVE_STEPS } = await load()
  assert.equal(typeof assertNativeCompatibilityComplete, 'function')
  const good = compatibilityFixture(NATIVE_STEPS)
  assert.doesNotThrow(() => assertNativeCompatibilityComplete(good)); assert.throws(() => assertNativeComplete(good))
  assert.throws(() => assertNativeCompatibilityComplete(completeFixture(NATIVE_STEPS)))
  for (const mutate of [ x => { delete x.seedSha }, x => { x.candidateSha = seedSha }, x => { x.expectedVersion = '0.22.2' }, x => { x.runtimeHome += '-other' }, x => { x.compatibility.appPin.commit = oldCommit }, x => { x.compatibility.binding.rootSha = seedSha }, x => { x.application.sha256 = '3'.repeat(64) }, x => { x.ipc.push({ cmd: 'install_hermes', ok: false }) }, x => { x.compatibility.blockedInstallerCommands.push('update_hermes') }, x => { x.nativeInstallerLifecycle = [] }, x => { x.rounds.pop() }, x => { x.rounds[0].steps.pop() }, x => { x.rounds[0].samples.pop() }, x => { x.rounds[0].elapsedSeconds = 209 }, x => { x.compatibility.runtimeChecks[2].commit = newCommit }, x => { x.compatibility.runtimeChecks[0].version = '0.22.2' }, x => { x.compatibility.runtimeChecks.pop() }, x => { x.compatibility.finalRuntimeHead = newCommit }, x => { x.compatibility.seedHistoryPreserved = false }, x => { x.compatibility.seedMemoryPreserved = false }, x => { x.hostUnchanged = false } ]) { const x = structuredClone(good); mutate(x); assert.throws(() => assertNativeCompatibilityComplete(x)) }
  const forged = structuredClone(good); forged.nativeInstallerLifecycle = completeFixture(NATIVE_STEPS).nativeInstallerLifecycle; assert.throws(() => assertNativeComplete(forged))
  for (const status of [undefined, 'failed', 'passed-native-tauri']) { const bad = structuredClone(good); bad.status = status; assert.throws(() => assertNativeCompatibilityComplete(bad)) }
})

test('兼容新source读取绑定实际Git blob与build manifest，篡改源码或EXE先红', async () => {
  const { readNativeCompatibilityBinding } = await load()
  assert.equal(typeof readNativeCompatibilityBinding, 'function')
  // macOS 的 /var 临时根本身是链接；fixture 先选物理根，不放松产品拒绝链接的门禁。
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-native-compat-source-'))
  try {
    const git = args => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
    git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'fixture'])
    const files = Object.keys(bindingFixture().sourceHashes)
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'fixture\n') }
    git(['add', '--', ...files]); git(['-c', 'core.autocrlf=false', 'commit', '-qm', 'fixture'])
    const sha = git(['rev-parse', 'HEAD']), app = path.join(dir, 'clawpanel.exe'), manifest = path.join(dir, 'source-sha256.json'), receipt = path.join(dir, 'build-receipt.json')
    fs.writeFileSync(app, 'fixture exe')
    const crypto = await import('node:crypto'), hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
    fs.writeFileSync(manifest, JSON.stringify({ sha, files: Object.fromEntries(files.map(f => [f, hash(path.join(dir, f))])) }))
    fs.writeFileSync(receipt, JSON.stringify({ status: 'passed', candidateSha: sha, hostUnchanged: true, sourceManifestSha256: hash(manifest), application: { path: app, sha256: hash(app) } }))
    assert.doesNotThrow(() => readNativeCompatibilityBinding({ root: dir, app, sha, buildReceipt: receipt }))
    fs.appendFileSync(app, 'changed'); assert.throws(() => readNativeCompatibilityBinding({ root: dir, app, sha, buildReceipt: receipt })); fs.writeFileSync(app, 'fixture exe')
    fs.appendFileSync(path.join(dir, files[0]), 'changed'); assert.throws(() => readNativeCompatibilityBinding({ root: dir, app, sha, buildReceipt: receipt }))
  } finally {
    const relative = path.relative(base, fs.realpathSync(dir))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(dir).startsWith('hermes-native-compat-source-'), '只清理本测试独占临时目录')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
