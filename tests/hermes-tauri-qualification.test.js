import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

const load = () => import('../scripts/test-hermes-tauri-qualification.mjs')

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
  const round = n => ({ round: n, steps: [...NATIVE_STEPS], samples: Array.from({ length: 42 }, () => ({ health: { version: '0.21.5' } })), elapsedSeconds: 210, observedErrors: [], historyReadbackAfterStop: true, prompts: [{ nonce: `native-${n}-a`, model: 'one' }, { nonce: `native-${n}-b`, model: 'one' }] })
  const rounds = [round(1), round(2)]
  const r = { completed: true, hostUnchanged: true, expectedVersion: '0.21.5', nativePage: { url: 'http://tauri.localhost/', ipc: true, windowLabel: 'main' }, rounds, cleanup: { productionStop: true, pidsExited: true, portsClosed: true }, nativeProcessesExited: true, driverPortsClosed: true, provider: rounds.flatMap(x => x.prompts.map(p => ({ ...p, title: false, authenticated: true }))) }
  assert.doesNotThrow(() => assertNativeComplete(r))
  for (const mutate of [
    x => { x.rounds[0].samples.pop() }, x => { x.rounds[1].elapsedSeconds = 209 },
    x => { x.rounds[0].steps.pop() }, x => { x.rounds[1].observedErrors.push('error') },
    x => { x.cleanup.pidsExited = false }, x => { x.nativeProcessesExited = false },
    x => { x.provider.push(x.provider[0]) }, x => { x.hostUnchanged = false }, x => { x.rounds[0].historyReadbackAfterStop = false },
  ]) { const bad = structuredClone(r); mutate(bad); assert.throws(() => assertNativeComplete(bad)) }
})
