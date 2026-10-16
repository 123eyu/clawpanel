#!/usr/bin/env node
// 仅驱动一次性 Windows runner 的真实 ClawPanel WebView2；不修改产品插件或权限。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const inside = (root, file) => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
export const NATIVE_STEPS = [
  'native-window-rust-ipc-gateway-online', 'actual-native-send-button-complete-reply',
  'native-refresh-restores-real-history', 'native-sustained-210s-42-health',
  'native-production-stop-pid-and-port', 'native-restart-keeps-history',
  'native-post-restart-full-reply', 'native-dashboard-profiles-stop-and-data-retained',
]

export function nativePlan() {
  return { installsOnLocalHost: false, webdriver: 'tauri-driver + Microsoft Edge Driver', uiRounds: 2, holdSeconds: 210, webFallback: false, productPluginsAdded: false }
}

export function nativeArgs(argv) {
  const values = new Set(['--root', '--sha', '--version', '--web-output', '--output', '--application', '--driver', '--native-driver', '--hold'])
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    assert.ok(!Object.hasOwn(o, key), `重复参数 ${key}`)
    if (key === '--execute' || key === '--plan') o[key] = true
    else { assert.ok(values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--'), `未知或缺值参数 ${key}`); o[key] = argv[++i] }
  }
  if (o['--sha']) assert.match(o['--sha'], /^[a-f0-9]{40}$/, 'SHA 必须完整且精确')
  if (o['--version']) assert.match(o['--version'], /^0\.\d+\.\d+$/, '版本必须精确')
  if (o['--hold']) assert.equal(o['--hold'], '210', '保留210秒验收，不缩短')
  assert.ok(!(o['--execute'] && o['--plan']), '模式互斥')
  return o
}

export function assertNativePage(p) {
  const u = new URL(p.url)
  assert.ok(((u.protocol === 'http:' && u.hostname === 'tauri.localhost') || (u.protocol === 'tauri:' && u.hostname === 'localhost')) && !u.port && !u.username && !u.password && p.ipc === true && p.windowLabel === 'main', 'native Tauri 来源/IPC/窗口身份不完整')
}

export function assertNativeComplete(r) {
  assertNativePage(r.nativePage)
  assert.ok(r.completed && r.hostUnchanged && r.nativeProcessesExited && r.driverPortsClosed)
  assert.ok(!r.error && !r.cleanupError && !r.hostOrSourceError && !r.providerError)
  assert.equal(r.rounds.length, 2)
  for (const round of r.rounds) {
    assert.deepEqual(round.steps, NATIVE_STEPS)
    assert.equal(round.samples.length, 42)
    assert.ok(round.elapsedSeconds >= 210)
    assert.deepEqual(round.observedErrors, [])
    assert.equal(round.historyReadbackAfterStop, true)
    assert.ok(round.samples.every(s => s.health?.version === r.expectedVersion))
    assert.equal(round.prompts.length, 2)
    for (const p of round.prompts) assert.equal(r.provider.filter(x => !x.title && x.authenticated && x.nonce === p.nonce && x.model === p.model).length, 1)
  }
  assert.ok(r.cleanup?.productionStop && r.cleanup.pidsExited && r.cleanup.portsClosed)
}

export class NativeWebDriver {
  constructor(base) {
    const u = new URL(base)
    assert.ok(u.protocol === 'http:' && u.hostname === '127.0.0.1', 'WebDriver 只接受回环')
    this.base = u.origin; this.session = null; this.events = []
  }
  async request(method, route, body) {
    const start = performance.now()
    const response = await fetch(this.base + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) })
    const data = await response.json()
    this.events.push({ method, route, status: response.status, durationMs: performance.now() - start })
    if (!response.ok || data.value?.error) throw new Error(`WebDriver ${route}: ${data.value?.message || data.value?.error || response.status}`)
    return data.value
  }
  async create(application) {
    const data = await this.request('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application } } } })
    assert.ok(data?.sessionId, '缺少真实 WebDriver session')
    this.session = data.sessionId
    await this.command('POST', '/timeouts', { script: 120000, pageLoad: 60000, implicit: 0 })
    return data
  }
  command(method, route, body) { assert.ok(this.session); return this.request(method, `/session/${this.session}${route}`, body) }
  script(script, args = []) { return this.command('POST', '/execute/sync', { script, args }) }
  async ipc(cmd, args = {}) {
    const data = await this.command('POST', '/execute/async', { script: `const [cmd,args,done]=arguments; if(!window.__TAURI__?.core?.invoke){done({ok:false,error:'missing native IPC'});return} window.__TAURI__.core.invoke(cmd,args).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));`, args: [cmd, args] })
    assert.ok(data?.ok, `native IPC ${cmd}: ${data?.error || 'missing reply'}`)
    return data.value
  }
  async element(selector) {
    const x = await this.command('POST', '/element', { using: 'css selector', value: selector })
    const id = x?.['element-6066-11e4-a52e-4f735466cecf']; assert.ok(id, `缺少真实元素 ${selector}`); return id
  }
  async send(prompt) {
    const input = await this.element('#hm-chat-input')
    await this.command('POST', `/element/${input}/clear`, {})
    await this.command('POST', `/element/${input}/value`, { text: prompt, value: [...prompt] })
    await until(async () => await this.script('return !!document.querySelector("#hm-chat-send") && !document.querySelector("#hm-chat-send").disabled'))
    const send = await this.element('#hm-chat-send')
    await this.command('POST', `/element/${send}/click`, {})
  }
  async screenshot(file) {
    const data = Buffer.from(await this.command('GET', '/screenshot'), 'base64')
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '截图不是 PNG')
    fs.writeFileSync(file, data)
  }
  async close() { if (this.session) { await this.command('DELETE', ''); this.session = null } }
}

async function until(predicate, timeout = 60000) {
  const end = performance.now() + timeout
  do { const v = await predicate(); if (v) return v; await wait(300) } while (performance.now() < end)
  throw new Error('native UI 有界等待失败')
}
async function freePort() { return await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) }) }
async function reachable(port) { return await new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)); s.setTimeout(1000, () => { s.destroy(); resolve(false) }) }) }
function physical(file) {
  const absolute = path.resolve(file)
  for (let p = absolute;; p = path.dirname(p)) {
    if (fs.existsSync(p)) assert.ok(!fs.lstatSync(p).isSymbolicLink(), `拒绝链接祖先 ${p}`)
    if (p === path.dirname(p)) break
  }
  return absolute
}

async function execute(o) {
  // 第一项是既有可信 VM/账户实证，传入路径或环境变量不构成本机安装授权。
  const qualification = await import('./test-hermes-windows-qualification.mjs')
  assert.equal(typeof qualification.actualRunnerProof, 'function', '一次性 runner 资格入口尚未具备')
  const proof = qualification.actualRunnerProof(); qualification.validateRunnerProof(proof)
  for (const key of ['--root', '--sha', '--version', '--web-output', '--output', '--application', '--driver', '--native-driver']) assert.ok(o[key], `缺少 ${key}`)
  const root = physical(o['--root']), output = physical(o['--output']), webOutput = physical(o['--web-output'])
  assert.ok(inside(physical(process.env.RUNNER_TEMP), output) && !fs.existsSync(output), 'native 输出必须是 RUNNER_TEMP 内全新目录')
  const prior = read(path.join(webOutput, 'report.json'))
  assert.equal(prior.status, 'passed-web-native-missing', '先完成真实 Web/安装生命周期，不用自述 receipt')
  assert.equal(prior.candidateSha, o['--sha'])
  const home = physical(path.join(webOutput, 'h')), app = physical(o['--application'])
  assert.ok(fs.statSync(home).isDirectory() && inside(root, app) && /clawpanel\.exe$/i.test(app), '应用或安装 HOME 越界')
  const git = spawnSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })
  assert.equal(git.status, 0); assert.equal(git.stdout.trim(), o['--sha'])
  fs.mkdirSync(output)
  const report = { schemaVersion: 1, status: 'failed', candidateSha: o['--sha'], expectedVersion: o['--version'], startedAt: new Date().toISOString(), scope: 'actual ClawPanel.exe / WebView2 / Rust IPC / W3C native driver', runner: proof, webQualification: { path: webOutput, sha256: hash(path.join(webOutput, 'report.json')) }, application: { path: app, sha256: hash(app) }, rounds: [], ipc: [], provider: [], nativePage: null, cleanup: null, errorObservationScope: 'observed flows after WebDriver attachment, not pre-attachment startup exceptions' }
  const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  const before = qualification.hostSnapshot(proof)
  fs.writeFileSync(path.join(output, 'host-before.json'), JSON.stringify(before, null, 2))
  const env = qualification.isolationEnv({ home, temp: path.join(output, 'tmp'), realProfile: proof.actualProfile })
  env.WEBVIEW2_USER_DATA_FOLDER = path.join(home, '.webview2-native-qualification')
  env.TAURI_WEBVIEW_AUTOMATION = '1'
  fs.mkdirSync(env.TEMP, { recursive: true })
  const panelDir = path.join(home, '.openclaw'), panelPath = path.join(panelDir, 'clawpanel.json')
  const originalPanel = fs.readFileSync(panelPath)
  const config = JSON.parse(originalPanel)
  Object.assign(config, { ignoreRisk: true, openclawDir: panelDir, engineMode: 'hermes', enabledEngines: ['hermes'], engineSetupChoice: 'explicit' })
  fs.writeFileSync(panelPath, JSON.stringify(config))
  if (!fs.existsSync(path.join(panelDir, 'openclaw.json'))) fs.writeFileSync(path.join(panelDir, 'openclaw.json'), '{}')
  const sources = Object.fromEntries(['src-tauri/src/commands/hermes.rs', 'src-tauri/src/lib.rs', 'src-tauri/Cargo.lock', 'package.json'].map(f => [f, hash(path.join(root, f))]))
  const watchedPids = new Set(), ports = new Set()
  let driver, provider, client, providerPort, driverPort, nativePort
  const nativePids = new Set()
  async function ipc(cmd, args) {
    const value = await client.ipc(cmd, args)
    report.ipc.push({ cmd, ok: true, at: new Date().toISOString() }); save(); return value
  }
  function runtimePids() {
    const code = `$h=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(env.HERMES_HOME).toString('base64')}'));@(Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($h)}|Select-Object ProcessId,ExecutablePath,CreationDate)|ConvertTo-Json -Compress`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    const data = r.stdout.trim() ? JSON.parse(r.stdout.replace(/^\uFEFF/, '')) : []
    return Array.isArray(data) ? data : [data]
  }
  function applicationPids() {
    const a = Buffer.from(app).toString('base64'), u = Buffer.from(env.WEBVIEW2_USER_DATA_FOLDER).toString('base64')
    const code = `$a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${a}'));$u=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${u}'));@(Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -ne $PID -and ($_.ExecutablePath -eq $a -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.Contains($u)))}|Select-Object ProcessId,ExecutablePath,CreationDate)|ConvertTo-Json -Compress`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    assert.equal(r.status, 0, r.stderr)
    const rows = r.stdout.trim() ? JSON.parse(r.stdout.replace(/^\uFEFF/, '')) : []
    return Array.isArray(rows) ? rows : [rows]
  }
  async function observe(item) {
    const seen = await client.script(`const k='__CLAWPANEL_HERMES_QUALIFICATION_ERRORS__';if(!window[k]){window[k]=[];addEventListener('error',e=>window[k].push(String(e.error?.stack||e.message).slice(0,4000)));addEventListener('unhandledrejection',e=>window[k].push(String(e.reason?.stack||e.reason).slice(0,4000)))}return window[k].splice(0);`)
    item.observedErrors.push(...seen); assert.deepEqual(item.observedErrors, [], 'native 交互期间存在未处理错误')
  }
  const processExists = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  async function stop() {
    if (!client?.session) return
    for (const x of runtimePids()) watchedPids.add(x.ProcessId)
    await ipc('hermes_gateway_action', { action: 'stop' })
    await ipc('hermes_dashboard_stop')
    await until(async () => (await Promise.all([...ports].map(reachable))).every(v => !v), 30000)
    await until(() => [...watchedPids].every(pid => !processExists(pid)), 30000)
    report.cleanup = { productionStop: true, pids: [...watchedPids], pidsExited: true, ports: [...ports], portsClosed: true }; save()
  }
  try {
    provider = http.createServer(async (req, res) => {
      try {
        let raw = ''; for await (const b of req) { raw += b; assert.ok(Buffer.byteLength(raw) <= 1048576) }
        const body = raw ? JSON.parse(raw) : {}
        if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: ['native-one', 'native-two'].map(id => ({ id, object: 'model', owned_by: 'qualification' })) })); return }
        assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer qualification-native-no-secret')
        const nonce = [...JSON.stringify(body.messages).matchAll(/native-acceptance-[a-f0-9-]{36}/g)].at(-1)?.[0]
        assert.ok(nonce, '模型请求缺少本轮 nonce')
        const system = (body.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n')
        const title = /^You are a title generator\./.test(system)
        report.provider.push({ nonce, model: body.model, title, stream: body.stream, authenticated: true }); save()
        const content = `原生完整回复：${nonce}；模型：${body.model}。`
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          for (const delta of [{ role: 'assistant', content: '' }, { content }, {}]) res.write('data: ' + JSON.stringify({ id: 'native-qualification', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] }) + '\n\n')
          res.end('data: [DONE]\n\n')
        } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'native-qualification', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })) }
      } catch (e) { report.providerError = String(e); save(); if (!res.headersSent) res.writeHead(500); res.end('qualification provider failed') }
    })
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); providerPort = provider.address().port
    driverPort = await freePort(); nativePort = await freePort()
    const log = fs.openSync(path.join(output, 'driver.log'), 'a')
    driver = spawn(physical(o['--driver']), ['--port', String(driverPort), '--native-port', String(nativePort), '--native-driver', physical(o['--native-driver'])], { env, windowsHide: true, stdio: ['ignore', log, log] })
    fs.closeSync(log)
    let spawnError; driver.once('error', e => { spawnError = e })
    await until(async () => { if (spawnError) throw spawnError; return await reachable(driverPort) }, 30000)
    client = new NativeWebDriver(`http://127.0.0.1:${driverPort}`); report.webdriver = await client.create(app)
    const startedApps = applicationPids(); assert.ok(startedApps.some(p => p.ExecutablePath.toLowerCase() === app.toLowerCase()), '没有实际 ClawPanel.exe 进程')
    report.application.processes = startedApps
    for (const p of startedApps) nativePids.add(p.ProcessId)
    report.nativePage = await client.script('return {url:location.href,ipc:!!window.__TAURI__?.core?.invoke && !!window.__TAURI_INTERNALS__?.invoke,windowLabel:window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label}')
    assertNativePage(report.nativePage)
    const resolved = await ipc('get_openclaw_dir'); assert.equal(path.resolve(resolved), path.resolve(panelDir), 'Rust 实际配置目录不是本轮私有 HOME')
    const status = await ipc('check_hermes'); assert.equal(status.installed, true); assert.equal(status.version, o['--version'])
    const gatewayPort = await freePort(); ports.add(gatewayPort)
    await ipc('hermes_env_set', { key: 'API_SERVER_HOST', value: '127.0.0.1' })
    await ipc('hermes_env_set', { key: 'API_SERVER_PORT', value: String(gatewayPort) })
    await ipc('hermes_set_gateway_url', { url: `http://127.0.0.1:${gatewayPort}` })
    for (let round = 1; round <= 2; round++) {
      const item = { round, steps: [], samples: [], prompts: [], observedErrors: [] }; report.rounds.push(item); save()
      await observe(item)
      const model = round === 1 ? 'native-one' : 'native-two'
      await ipc('configure_hermes', { provider: 'custom', apiKey: 'qualification-native-no-secret', model, baseUrl: `http://127.0.0.1:${providerPort}/v1` })
      await ipc('hermes_gateway_action', { action: 'start' }); assert.equal((await ipc('hermes_health_check')).version, o['--version'])
      await client.script("location.hash='/h/chat'; return true")
      await until(() => client.script('return !!document.querySelector("#hm-chat-input") && !!document.querySelector(".hm-chat-gw-status.is-online")'))
      item.steps.push('native-window-rust-ipc-gateway-online')
      const send = async () => {
        const nonce = 'native-acceptance-' + crypto.randomUUID(), reply = `原生完整回复：${nonce}；模型：${model}。`
        item.prompts.push({ nonce, model }); await client.send(nonce)
        await until(() => client.script('return document.body.innerText.includes(arguments[0])', [reply]), 120000)
        return reply
      }
      const reply = await send(); item.steps.push('actual-native-send-button-complete-reply')
      const sessionId = await client.script('return document.querySelector(".hm-chat-session-item.is-active")?.dataset.sid')
      assert.ok(sessionId, 'native UI 缺当前真实会话 ID'); item.sessionId = sessionId
      await client.command('POST', '/refresh', {})
      await observe(item)
      await until(() => client.script('return document.body.innerText.includes(arguments[0])', [reply]))
      item.steps.push('native-refresh-restores-real-history')
      const start = performance.now()
      for (let n = 0; n < 42; n++) { item.samples.push({ at: new Date().toISOString(), health: await ipc('hermes_health_check') }); await observe(item); save(); await wait(Math.max(0, start + (n + 1) * 5000 - performance.now())) }
      item.elapsedSeconds = (performance.now() - start) / 1000; assert.ok(item.elapsedSeconds >= 210); item.steps.push('native-sustained-210s-42-health')
      await stop(); item.steps.push('native-production-stop-pid-and-port')
      await ipc('hermes_gateway_action', { action: 'start' })
      await client.command('POST', '/refresh', {})
      await observe(item)
      await until(() => client.script('return document.body.innerText.includes(arguments[0])', [reply]))
      item.steps.push('native-restart-keeps-history')
      await send(); item.steps.push('native-post-restart-full-reply')
      const profiles = await ipc('hermes_profiles_list'); assert.ok(profiles)
      const dash = await ipc('hermes_dashboard_start'); assert.equal(dash.started, true)
      const probe = await ipc('hermes_dashboard_probe'); assert.ok(probe.running || probe.reachable || probe.status === 'running', 'native Dashboard 未真实就绪')
      if (probe.port) ports.add(Number(probe.port)); else ports.add(9119)
      await stop(); item.steps.push('native-dashboard-profiles-stop-and-data-retained')
      const detail = await ipc('hermes_session_detail', { sessionId })
      assert.ok(item.prompts.every(p => JSON.stringify(detail).includes(`原生完整回复：${p.nonce}；模型：${model}。`)), 'native 停止后实际 CLI 历史缺完整回复')
      item.historyReadbackAfterStop = true
      await observe(item); await client.screenshot(path.join(output, `round-${round}.png`)); save()
    }
    for (const prompt of report.rounds.flatMap(x => x.prompts)) assert.equal(report.provider.filter(x => x.nonce === prompt.nonce && x.model === prompt.model && !x.title).length, 1, 'native 聊天请求缺失/重放')
    assert.ok(!report.providerError)
    report.completed = true
  } catch (e) { report.error = e.stack; }
  finally {
    try { if (client?.session) { await client.screenshot(path.join(output, 'final.png')); await stop(); for (const p of applicationPids()) nativePids.add(p.ProcessId); await client.close() } } catch (e) { report.cleanupError = String(e) }
    if (driver?.pid) {
      const killed = spawnSync('taskkill.exe', ['/PID', String(driver.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
      report.driverCleanup = { pid: driver.pid, exit: killed.status }
    }
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
    fs.writeFileSync(panelPath, originalPanel)
    try {
      assert.deepEqual(Object.fromEntries(Object.keys(sources).map(f => [f, hash(path.join(root, f))])), sources, 'native源码发生漂移')
      assert.equal(hash(app), report.application.sha256)
      // driver 清理未关闭的应用仅按实际 EXE/私有 WebView2 路径归属清理，不按名称扫全机。
      for (const p of applicationPids()) { nativePids.add(p.ProcessId); spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true, encoding: 'utf8' }) }
      await until(() => [...nativePids].every(pid => !processExists(pid)), 30000)
      report.nativeProcessesExited = true; report.nativePids = [...nativePids]
      await until(async () => (await Promise.all([driverPort, nativePort, providerPort].filter(Boolean).map(reachable))).every(v => !v), 30000)
      report.driverPortsClosed = true
      const after = qualification.hostSnapshot(proof); fs.writeFileSync(path.join(output, 'host-after.json'), JSON.stringify(after, null, 2)); qualification.assertHostUnchanged(before, after); report.hostUnchanged = true
    } catch (e) { report.hostOrSourceError = String(e) }
    if (client) fs.writeFileSync(path.join(output, 'webdriver-commands.json'), JSON.stringify(client.events, null, 2))
    report.finishedAt = new Date().toISOString()
    try { assertNativeComplete(report); report.status = 'passed-native-tauri' } catch (e) { report.status = 'failed'; report.gateError = String(e) }
    save()
  }
  console.log(JSON.stringify({ status: report.status, sha: o['--sha'], rounds: report.rounds.length, output }))
  return report.status === 'passed-native-tauri' ? 0 : 1
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const o = nativeArgs(process.argv.slice(2)); if (!o['--execute']) console.log(JSON.stringify(nativePlan())); else process.exitCode = await execute(o) }
  catch (e) { console.error(e.message); process.exitCode = 1 }
}
