// 先留失败契约；真实Win32 E2E只读本测试spawn的Node父子，不启动GUI/安装器或查询其它进程。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { parseArgs, processObservationSource, createAttachDeadline } from '../scripts/test-weixin-windows-qualification.mjs'
let m = {}
try { m = await import('../scripts/weixin-native-token-observation.mjs') } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e }
const artifact = (name, data) => {
  if (process.env.CLAWPANEL_TOKEN_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.CLAWPANEL_TOKEN_EVIDENCE_DIR, { recursive: true })
    fs.writeFileSync(path.join(process.env.CLAWPANEL_TOKEN_EVIDENCE_DIR, name + '.json'), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
  }
}
const spec = () => ({ app: { pid: 1234, exe: 'C:\\own\\clawpanel.exe', startedAt: 1000, returnedAt: 1010 }, parent: { pid: 1233, exe: 'C:\\own\\node.exe' }, expectedSid: 'S-1-5-21-1-2-3-1001' })
test('R11显式双开关；普通plan/正式execute/仅attach都不默默查询token', () => {
  assert.equal(parseArgs(['--plan', '--diagnostic-attach', '--observe-app-token'])['--observe-app-token'], true)
  for (const args of [['--plan', '--observe-app-token'], ['--execute', '--observe-app-token'], ['--diagnostic-attach', '--observe-app-token', '--scope', 'complete']]) assert.throws(() => parseArgs(args))
  assert.equal(parseArgs(['--plan'])['--observe-app-token'], undefined)
  assert.equal(parseArgs(['--diagnostic-attach'])['--observe-app-token'], undefined)
})
test('禁用token时PS source逐字等于base；开启只利用已有CIM，不加查询/重试', () => {
  assert.equal(typeof m.tokenObservationSource, 'function')
  const base = processObservationSource('C:\\own', [49234], [], 1233)
  assert.equal(m.tokenObservationSource(base), base)
  const source = m.tokenObservationSource(base, spec())
  assert.equal((source.match(/Get-CimInstance/g) || []).length, 1)
  assert.equal((source.match(/Get-NetTCPConnection/g) || []).length, 1)
  for (const forbidden of ['AdjustToken', 'SetTokenInformation', 'DuplicateToken', 'CreateRestrictedToken', 'CreateProcessWith', 'LogonUser', 'Impersonate', 'ReadProcessMemory', 'GetEnvironmentStrings', 'TokenPrivileges', 'HKLM:', 'HKCU:', 'Add-Type']) assert.ok(!source.includes(forbidden), forbidden)
  assert.ok(source.includes('tokenObservation='))
  assert.ok(source.includes('TOKEN_SID_MISMATCH'))
  assert.ok(source.includes('TokenLinkedToken'))
  assert.ok(source.includes('CloseHandle'))
  assert.ok(source.includes('SetLastError'))
  assert.ok(m.tokenEncodedCommandLength(source) < 32767)
  assert.throws(() => m.tokenEncodedCommandLength('x'.repeat(13000)), /32767/)
})
test('请求缺owner/重复PID/相对exe/无SID等在生成PS之前拒绝，不能接任意process/env', () => {
  assert.equal(typeof m.tokenObservationSource, 'function')
  const base = processObservationSource('C:\\own', [], [], 1233)
  for (const change of [s => { delete s.app }, s => { delete s.parent }, s => { delete s.expectedSid }, s => { s.app.pid = 0 }, s => { s.app.pid = s.parent.pid }, s => { s.app.exe = 'relative' }, s => { s.app.returnedAt = s.app.startedAt - 1 }, s => { s.expectedSid = 'SYSTEM' }, s => { s.app.extra = 'untrusted' }, s => { s.rawToken = true }]) {
    const s = spec(); change(s); assert.throws(() => m.tokenObservationSource(base, s))
  }
})
test('CIM微秒/FILETIME100ns仅同bucket，保留原值；相邻微秒/毫秒/秒都红', () => {
  assert.equal(typeof m.sameCimMicrosecond, 'function')
  const cim = 134051254383918800n
  for (let delta = 0n; delta <= 9n; delta++) assert.equal(m.sameCimMicrosecond(String(cim), String(cim + delta)), true)
  for (const delta of [-10000000n, -10n, -1n, 10n, 10000n, 10000000n]) assert.equal(m.sameCimMicrosecond(String(cim), String(cim + delta)), false)
  for (const value of [Number(cim), '1e18', '-1', null]) assert.throws(() => m.sameCimMicrosecond(value, String(cim)))
})
test('public proof严格白名单/完整身份，不得混raw token/env/handles或把unknown变false', () => {
  assert.equal(typeof m.publicTokenObservation, 'function')
  const r = spec(), date = '2026-10-17T01:00:00.0000000Z', ticks = String(BigInt(Date.parse(date)) * 10000n + 116444736000000000n)
  r.app.startedAt = Date.parse(date); r.app.returnedAt = r.app.startedAt + 10
  const subject = p => ({ pid: p.pid, parentPid: r.parent.pid, exe: p.exe, cimCreationUtc: date, fileTimeCreationUtc: date, cimFileTimeTicks: ticks, fileTimeTicks: ticks, delta100ns: 0, birthComparison: 'same-cim-microsecond', userSid: r.expectedSid, integritySid: 'S-1-16-12288', integrityRid: 12288, isElevated: true, elevationType: 1, tokenType: 1, sessionId: 1, uiAccess: false, linked: { state: 'none-by-default-type', exists: false } })
  const proof = { mode: 'readonly-win32-process-primary-token', neverQualification: true, app: subject(r.app), parent: subject(r.parent) }
  assert.deepEqual(m.publicTokenObservation(proof, r), proof, 'Default+High不能假降为medium')
  for (const change of [p => { p.environment = {} }, p => { p.app.handle = 1 }, p => { delete p.parent }, p => { p.app.pid++ }, p => { p.app.exe += '.wrong' }, p => { p.app.userSid += '1' }, p => { p.app.fileTimeTicks = String(BigInt(ticks) + 10n) }, p => { p.parent.sessionId++ }, p => { p.app.linked.exists = true }, p => { p.app.linked.state = 'unknown' }, p => { p.app.isElevated = null }, p => { p.app.elevationType = 3 }, p => { p.neverQualification = false }]) {
    const p = structuredClone(proof); change(p); assert.throws(() => m.publicTokenObservation(p, r))
  }
})

const psValue = text => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text).toString('base64')}'))`
function ps(source) {
  const prefix = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n"
  const encoded = Buffer.from(prefix + source, 'utf16le').toString('base64')
  assert.ok(encoded.length + 250 < 32767, 'PS命令行超过原32767')
  return spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath')) })
}
async function ownChain(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-token-own-')))
  const program = `const {spawn}=require('node:child_process');const start=Date.now();const child=spawn(process.execPath,['-e','process.stdout.write("ready");setTimeout(()=>process.exit(0),29000)'],{stdio:['ignore','pipe','pipe'],windowsHide:true});const returnedAt=Date.now();let ready=false;child.stdout.once('data',()=>{ready=true;process.stdout.write(JSON.stringify({pid:child.pid,exe:process.execPath,startedAt:start,returnedAt})+'\\n')});child.on('close',(code,signal)=>{process.stdout.write(JSON.stringify({reaped:true,code,signal})+'\\n');process.exit(0)});process.stdin.once('data',()=>{if(child.exitCode===null)child.kill()});setTimeout(()=>{if(child.exitCode===null)child.kill()},29500)`
  const startedAt = Date.now(), parent = spawn(process.execPath, ['-e', program], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), returnedAt = Date.now(), reaped = once(parent, 'close')
  let stdout = '', stderr = ''; parent.stdout.on('data', b => { stdout += b.toString('utf8') }); parent.stderr.on('data', b => { stderr += b.toString('utf8') })
  t.after(async () => {
    parent.stdin.end('close\n'); const [code, signal] = await reaped
    assert.equal(code, 0, stderr); assert.ok(stdout.includes('"reaped":true'), '自己的Node child必须实际close/reap')
    assert.equal(fs.realpathSync.native(root), root); assert.equal(fs.readdirSync(root).length, 0); fs.rmdirSync(root)
    artifact('own-node-reap', { scope: 'two actually spawned Node children only; not native GUI', parentPid: parent.pid, code, signal, stdout, stderr, ownEmptyCwdRemoved: true })
  })
  while (!stdout.includes('\n')) await once(parent.stdout, 'data')
  return { app: JSON.parse(stdout.split('\n')[0]), parent: { pid: parent.pid, exe: process.execPath, startedAt, returnedAt } }
}
test('真实Win32 E2E：仅自有Node app+parent，先CIM owner参考，再原生SID/IL/elevation/link读取及错误负控', { skip: process.platform !== 'win32' }, async t => {
  const own = await ownChain(t)
  // 参考SID只针对自己spawn且仍持有的Node parent；不调用whoami、用户其它进程、env或registry。
  const ref = ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${own.parent.pid}';if(!$p -or $p.ExecutablePath -ine ${psValue(own.parent.exe)}){throw 'OWN_REFERENCE_EXE'};$start=[DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds();if($start -lt ${own.parent.startedAt} -or $start -gt ${own.parent.returnedAt}){throw 'OWN_REFERENCE_BIRTH'};$r=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid;if($r.ReturnValue -ne 0){throw 'OWN_REFERENCE_SID'};@{sid=$r.Sid;creationDate=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`)
  assert.equal(ref.status, 0, ref.stderr)
  const reference = JSON.parse(ref.stdout); artifact('own-node-reference', { own, reference, actualOwnCimOwnerOnly: true })
  assert.equal(typeof m.tokenObservationSource, 'function', '先红：缺少真实token观察入口')
  const request = { app: own.app, parent: { pid: own.parent.pid, exe: own.parent.exe }, expectedSid: reference.sid }
  const base = `$all=@(Get-CimInstance Win32_Process -Filter 'ProcessId=${own.app.pid} OR ProcessId=${own.parent.pid}');$owned=@();$listeners=@();@{processes=@($owned|ForEach-Object {$_});present=@();listeners=$listeners}|ConvertTo-Json -Compress -Depth 6`
  const initial = ps(m.tokenObservationSource(base, request))
  assert.equal(initial.status, 0, initial.stderr)
  const data = JSON.parse(initial.stdout).tokenObservation
  assert.deepEqual(m.publicTokenObservation(data, request), data)
  assert.equal(data.mode, 'readonly-win32-process-primary-token'); assert.equal(data.neverQualification, true)
  for (const role of ['app', 'parent']) {
    const p = data[role]; assert.equal(p.pid, own[role].pid); assert.equal(p.exe.toLowerCase(), own[role].exe.toLowerCase()); assert.equal(p.userSid, reference.sid)
    assert.equal(m.sameCimMicrosecond(p.cimFileTimeTicks, p.fileTimeTicks), true)
    assert.ok(Number.isInteger(p.integrityRid) && p.integritySid.startsWith('S-1-16-')); assert.equal(typeof p.isElevated, 'boolean'); assert.ok([1, 2, 3].includes(p.elevationType)); assert.equal(p.tokenType, 1)
    assert.ok(['present', 'none-by-default-type'].includes(p.linked.state)); assert.equal(typeof p.linked.exists, 'boolean')
  }
  assert.equal(data.app.parentPid, own.parent.pid)
  const serialized = JSON.stringify(data)
  assert.doesNotMatch(serialized, /handle|pointer|rawToken|privileges|environment|password|cookie/i)
  const failures = []
  for (const [name, change, reason, replacement, sourceChange] of [
    ['wrong-exe', s => { s.app.exe += '.wrong' }, 'TOKEN_CIM_OWNER'],
    ['wrong-SID', s => { s.expectedSid = 'S-1-5-21-1-2-3-9999' }, 'TOKEN_SID_MISMATCH'],
    ['wrong-parent', s => { s.parent.pid = own.app.pid + 1000000 }, 'TOKEN_PARENT_OWNER'],
    ['adjacent-CIM-microsecond', () => {}, 'TOKEN_BIRTH_MISMATCH', `$all[0].CreationDate=$all[0].CreationDate.AddTicks(-10);`],
    ['own-token-open-denied', () => {}, 'TOKEN_NATIVE_OpenProcessToken:5', null, s => s.replace('OpenProcessToken($hp,0x8,', 'OpenProcessToken($hp,0x0,')],
    ['linked-query-unknown', () => {}, 'TOKEN_BUFFER_SIZE:9999:87', null, s => s.replace('$TokenLinkedToken=19', '$TokenLinkedToken=9999')],
  ]) {
    const s = structuredClone(request); change(s)
    // 只在fixture复制的own CIM对象里改预期birth；原生目标仍限两个own PID。
    let fixtureBase = base
    if (replacement) fixtureBase = base.replace('$owned=@();', `$all=@($all|ForEach-Object {[pscustomobject]@{ProcessId=$_.ProcessId;ParentProcessId=$_.ParentProcessId;ExecutablePath=$_.ExecutablePath;CreationDate=$_.CreationDate}});${replacement}$owned=@();`)
    const source = m.tokenObservationSource(fixtureBase, s), r = ps(sourceChange ? sourceChange(source) : source)
    assert.notEqual(r.status, 0, name); assert.ok(r.stderr.includes(reason), name + ': ' + r.stderr); failures.push({ name, status: r.status, reason, error: r.stderr })
  }
  artifact('actual-win32-own-node', { scope: 'actual readonly Win32 of exclusively owned Node parent/child; not app/VM/native acceptance', proof: data, negativeResults: failures, noGUI: true, noTokenMutationOrLaunch: true })
})
test('实际snapshot预算/白名单/原55和15以及正式cleanup不扩改', () => {
  const source = fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs', import.meta.url), 'utf8'), base = spawnSync('git', ['show', 'ddf9451c5888fbd7b1db2f0bf5c968883a9a3d36:scripts/test-weixin-windows-qualification.mjs'], { windowsHide: true, encoding: 'utf8', timeout: 10000 })
  assert.equal(base.status, 0)
  const take = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)))
  assert.equal(take(source, 'export function processObservationSource(', '\nfunction processSnapshot('), take(base.stdout, 'export function processObservationSource(', '\nfunction processSnapshot('))
  assert.equal(take(source, 'export function assertNativeComplete(', '\nfunction tarEntries('), take(base.stdout, 'export function assertNativeComplete(', '\nfunction tarEntries('))
  const formal = take(base.stdout, '  try{const snap=processSnapshot(output,[...ports]);', '  try{if(report.sessionLaunch)'); assert.ok(source.includes(formal))
  assert.ok(source.includes('--observe-app-token')); assert.ok(source.includes('tokenObservation')); assert.ok(/Math\.min\(30000,deadline\.remaining\(\)\)/.test(source))
  assert.match(source, /maxBuffer:16\*1024\*1024/); assert.match(source, /limitMs=60000/)
  assert.throws(() => createAttachDeadline(60001)); assert.doesNotMatch(source, /CreateProcessWithToken|CreateRestrictedToken|AdjustTokenPrivileges/)
})
