#!/usr/bin/env node
// 可信手工资格入口。--execute 只接受 GitHub 托管的一次性 Windows VM，绝不回退到本机安装。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { classifyHermesMetadataRequest } from './hermes-qualification-provider.mjs'

export const STAGES = ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve']
const tooling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const hash = file => digest(fs.readFileSync(file))
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const exactSha = value => typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value)
const within = (home, file) => { const rel = path.relative(path.resolve(home), path.resolve(file)); return !rel.startsWith('..') && !path.isAbsolute(rel) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

export function parseArgs(args) {
  const flags = new Set(['--plan', '--execute', '--help', '--matrix'])
  const values = new Set(['--root', '--sha', '--version', '--variant', '--output', '--verify-linux-evidence', '--publish-evidence'])
  const o = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    assert.ok(!Object.hasOwn(o, key), `重复参数 ${key}`)
    if (flags.has(key)) o[key] = true
    else { assert.ok(values.has(key) && args[i + 1] && !args[i + 1].startsWith('--'), `未知或缺值参数 ${key}`); o[key] = args[++i] }
  }
  if (o['--sha']) assert.ok(exactSha(o['--sha']), 'SHA 必须是小写完整40位')
  if (o['--version']) assert.match(o['--version'], /^0\.\d+\.\d+$/, '必须精确版本')
  if (o['--variant']) assert.ok(['old', 'new'].includes(o['--variant']), 'variant 必须 old/new')
  assert.ok([o['--plan'], o['--execute'], o['--matrix'], o['--verify-linux-evidence'], o['--publish-evidence']].filter(Boolean).length <= 1, '模式互斥')
  return o
}

export function matrixFromInputs(env) {
  assert.ok(['baseline', 'candidate', 'both'].includes(env.TARGET), 'target 无效')
  const include = []
  for (const [target, variant, key, version] of [['baseline', 'old', 'BASELINE_SHA', '0.21.5'], ['candidate', 'new', 'CANDIDATE_SHA', '0.22.2']]) {
    if (env.TARGET !== target && env.TARGET !== 'both') continue
    assert.ok(exactSha(env[key]), `${key} 必须是完整 SHA，不接受分支/浮动 tag`)
    include.push({ variant, sha: env[key], version })
  }
  return { include }
}

export function runnerProofFailures(p) {
  // 除 ImageOS 精确两项 allowlist 外保留原有合取门禁；原因不拼入环境值或凭据。
  const checks = {
    platform: p.platform === 'win32', architecture: p.arch === 'x64',
    'runner-environment': p.runnerEnvironment === 'github-hosted', 'runner-os': p.runnerOS === 'Windows',
    event: p.event === 'workflow_dispatch', 'main-ref': p.ref === 'refs/heads/main', repository: p.repository === 'qingchencloud/clawpanel',
    'workflow-ref': p.workflowRef === 'qingchencloud/clawpanel/.github/workflows/hermes-qualification.yml@refs/heads/main',
    'workflow-sha-format': exactSha(p.workflowSha), 'workflow-sha-match': p.workflowSha === p.toolingSha,
    'run-id': /^\d+$/.test(p.runId || ''), 'run-attempt': /^\d+$/.test(p.attempt || ''),
    'virtual-machine': p.virtualMachine === true, 'image-os': ['win25', 'win25-vs2026'].includes(p.imageOS), 'image-version': !!p.imageVersion,
    'user-name': p.userName?.toLowerCase() === 'runneradmin', 'sid-format': /^S-1-5-21-\d+-\d+-\d+-\d+$/.test(p.sid || ''),
    'actual-profile': /^[a-z]:\\Users\\runneradmin$/i.test(p.actualProfile || ''), 'profile-registration': p.actualProfile?.toLowerCase() === p.registeredProfile?.toLowerCase(),
  }
  return Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
}

export function validateRunnerProof(p) {
  const failures = runnerProofFailures(p)
  assert.equal(failures.length, 0, `Windows 资格门禁失败：仅可信 main 手工 GitHub-hosted VM + 真实 runneradmin SID/ProfileList；环境变量不是宿主隔离证明；failedConditions=${failures.join(',')}`)
}

export function isolationEnv({ home, temp, parent = process.env, realProfile = parent.USERPROFILE }) {
  home = path.resolve(home); temp = path.resolve(temp)
  const env = {}
  for (const k of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (parent[k]) env[k] = parent[k]
  const inherited = parent.PATH || parent.Path || ''
  const entries = inherited.split(';').filter(p => p && (!realProfile || !p.toLowerCase().startsWith(realProfile.toLowerCase() + '\\')))
  env.PATH = [path.join(home, '.hermes/hermes-agent/venv/Scripts'), path.join(home, '.hermes/bin'), path.join(home, '.local/bin'), path.join(home, '.npm-global'), ...entries].join(';')
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), TMP: temp, TEMP: temp,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    HERMES_HOME: path.join(home, '.hermes'), OPENCLAW_CONFIG_DIR: path.join(home, '.openclaw'),
    NPM_CONFIG_PREFIX: path.join(home, '.npm-global'), NPM_CONFIG_CACHE: path.join(home, '.npm-cache'), NPM_CONFIG_USERCONFIG: path.join(home, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(home, 'global-npmrc'), NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    UV_CACHE_DIR: path.join(home, '.uv-cache'), UV_PYTHON_INSTALL_DIR: path.join(home, '.uv-python'), UV_TOOL_DIR: path.join(home, '.uv-tools'), UV_TOOL_BIN_DIR: path.join(home, '.local/bin'), UV_INSTALL_DIR: path.join(home, '.local/bin'),
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PLAYWRIGHT_BROWSERS_PATH: path.join(home, '.browsers'), CI: '1' })
  return env
}

export function assertHostUnchanged(before, after) { assert.deepEqual(after, before, '宿主 registry类型/值、PATH、shell、global launcher 或父环境发生变更；不自动恢复掩盖失败') }

export function assertSameSource(root, files) {
  for (const [file, expected] of Object.entries(files)) {
    const f = path.resolve(root, file)
    assert.ok(within(root, f) && fs.existsSync(f) && fs.lstatSync(f).isFile() && !fs.lstatSync(f).isSymbolicLink(), `源码缺失/越界 ${file}`)
    assert.equal(hash(f), expected, `源码字节 SHA256 不同 ${file}`)
  }
}

// 仅从原始证据生成另一个全新公开副本。保留原件；HOME、完整 env、运行时和缓存从不进入副本。
// ZIP 内的 trace/network/snapshot 也逐成员脱敏，不因扩展名是 zip 而漏掉随机 Gateway 密钥。
export async function publishEvidence({ roots, output }) {
  output = path.resolve(output); physical(output); assert.ok(!fs.existsSync(output), '公开输出必须全新')
  for (const [label, root] of Object.entries(roots)) {
    assert.match(label, /^[a-z][a-z0-9-]*$/); physical(root)
    assert.ok(fs.statSync(root).isDirectory() && !within(root, output) && !within(output, root), '公开输出与原始证据不得重叠')
  }
  const source = String.raw`
import sys,json,pathlib,os,re,hashlib,zipfile,io
plan=json.load(sys.stdin);out=pathlib.Path(plan['output']);out.mkdir(parents=True,exist_ok=False)
denied={'h','home','t','tmp','source','node_modules','.hermes','.env','.git','.npm-cache','.uv-cache','.browsers','cache','caches'}
deniedfiles={'isolationenv.json','environment.json','env.json'}
extensions={'.json','.jsonl','.log','.txt','.md','.png','.zip'}
secrets=set();files=[];manifest=[]
def linked(p):return p.is_symlink() or (hasattr(p,'is_junction') and p.is_junction())
def remember(v):
 v=v.strip().strip('"\'')
 if len(v)>=8 and not v.startswith('[REDACTED') and v not in {'qualification-local-no-secret'}:secrets.add(v)
def discover(t):
 for m in re.finditer(r'(?im)^\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*([^\r\n]+)',t):remember(m[1])
 for m in re.finditer(r'(?i)["\'](?:API_SERVER_KEY|apiKey|api_key|accessPassword|gateway_token|gatewayToken|token|secret|password|authorization)["\']\s*:\s*["\']([^"\'\r\n]{8,})["\']',t):remember(m[1].removeprefix('Bearer '))
 for m in re.finditer(r'(?i)\bBearer\s+([A-Za-z0-9._~+/-]{8,})',t):remember(m[1])
def texts(data,iszip):
 if iszip:
  with zipfile.ZipFile(io.BytesIO(data)) as z:
   for n in z.namelist():
    try:yield z.read(n).decode('utf-8')
    except UnicodeDecodeError:pass
 else:
  try:yield data.decode('utf-8')
  except UnicodeDecodeError:pass
for label,r in plan['roots'].items():
 root=pathlib.Path(r)
 # 只读取已知测试 HOME 的 dotenv 用于脱敏，不枚举/公开私有运行时、数据库或缓存。
 for rel in ['h/.hermes/.env','runtime/home/.hermes/.env','runtime-final/home/.hermes/.env','runtime-at-timeout/home/.hermes/.env']:
  p=root/rel
  if p.is_file() and not any(linked(x) for x in [p,*list(p.parents)[:len(pathlib.Path(rel).parts)]]):discover(p.read_text(encoding='utf-8-sig'))
 for current,dirs,names in os.walk(root,followlinks=False):
  dirs[:]=[d for d in sorted(dirs) if d.lower() not in denied and not linked(pathlib.Path(current,d))]
  for name in sorted(names):
   p=pathlib.Path(current,name)
   if linked(p) or name.lower() in denied or name.lower() in deniedfiles or p.suffix.lower() not in extensions:continue
   data=p.read_bytes();iszip=p.suffix.lower()=='.zip'
   for text in texts(data,iszip):discover(text)
   files.append((label,p.relative_to(root),data,iszip))
ordered=sorted(secrets,key=len,reverse=True)
def scrub(data):
 try:t=data.decode('utf-8')
 except UnicodeDecodeError:return data
 for secret in ordered:t=t.replace(secret,'[REDACTED]')
 return t.encode('utf-8')
for label,rel,data,iszip in files:
 if iszip:
  b=io.BytesIO()
  with zipfile.ZipFile(io.BytesIO(data)) as original,zipfile.ZipFile(b,'w') as public:
   for info in original.infolist():
    assert not pathlib.PurePosixPath(info.filename).is_absolute() and '..' not in pathlib.PurePosixPath(info.filename).parts,'trace member path escape'
    public.writestr(info,scrub(original.read(info.filename)))
  clean=b.getvalue()
 else:clean=scrub(data)
 dest=out/label/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(clean)
 manifest.append({'path':str(pathlib.PurePosixPath(label,*rel.parts)),'rawSha256':hashlib.sha256(data).hexdigest(),'publishedSha256':hashlib.sha256(clean).hexdigest(),'redactedOrRepacked':clean!=data})
summary={'schemaVersion':1,'scope':'sanitized evidence copy; original status/assertions unchanged; not a qualification upgrade','privateHomeUploaded':False,'fullEnvironmentUploaded':False,'redactedValueHashes':sorted(hashlib.sha256(s.encode()).hexdigest() for s in secrets),'files':manifest}
(out/'publication-manifest.json').write_text(json.dumps(summary,indent=2),encoding='utf-8');print(json.dumps({'files':len(files),'privateHomeUploaded':False,'fullEnvironmentUploaded':False}))
`
  const env = {}; for (const k of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.env[k]) env[k] = process.env[k]
  Object.assign(env, { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' })
  const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', source], { env, input: JSON.stringify({ roots, output }), encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(r.status, 0, `公开副本失败；不上传原件: ${r.stderr}`); return JSON.parse(r.stdout)
}

export function validatePrivateCompletion(r, expected) {
  assert.ok(r && r.version === expected.version && r.commit === expected.commit, 'private completion 版本/commit 缺失或不匹配')
  for (const p of [r.python, ...['hermes_cli.main', 'fastapi', 'uvicorn'].map(k => r.modules?.[k])]) assert.ok(typeof p === 'string' && within(expected.home, p), 'private completion 路径越出 HOME')
  if (expected.version === '0.22.2') {
    assert.deepEqual(r.requiredStages, ['repository', 'venv', 'python-deps', 'config', 'complete'], 'private completion 22.2 实际五 stage 不符')
    const pm = r.pm, managed = path.join(expected.home, '.hermes')
    assert.ok(pm && r.python === pm.selectedStorePython && within(path.join(managed, 'tools'), r.python) && typeof pm.dependencyPython === 'string' && within(path.join(managed, 'installs'), pm.dependencyPython) && pm.dependencyPython !== r.python, 'private completion 混淆 dependency Python 与 selected store Python')
    assert.ok(r.commandSpec?.program === pm.dependencyPython && r.commandSpec.role === 'pm-bootstrap-metadata' && r.commandSpec.args?.[0] === '-I', 'private completion 缺真实 command spec')
    for (const proof of [pm.completion, pm.preflight]) assert.ok(proof?.commit === expected.commit && proof.current === true && proof.same === true && proof.completed === true, 'private completion/products/preflight 回执缺失')
    assert.equal(pm.completion.pending, false, 'private completion 仍有 pending debt')
    assert.deepEqual(pm.preflight.command, ['profile', 'list'], 'private completion 未通过原 preflight Python helper')
  } else assert.ok(typeof r.cli === 'string' && within(expected.home, r.cli), 'private completion 旧 CLI 越界')
  assert.ok(r.requiredStages?.length >= 5 && r.requiredStages.every(name => r.stages?.some(s => s.name === name && s.exitCode === 0)), 'private completion 缺真实安装阶段成功回执')
}

export function classifyProviderRequest(body) {
  const system = (body.messages || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n').trim()
  if (/^(?:You are a title generator\.|Create a concise title for an AI coding-assistant session|You generate concise (?:chat|conversation) titles)/.test(system)) return 'title'
  if (/^(?:You are Hermes(?: Agent)?[, .]|You are (?:an? |a helpful )AI assistant)/.test(system)) return 'chat'
  return 'unattributed'
}

export function qualificationStatus(r) {
  if (!STAGES.every(name => r.stages?.some(s => s.name === name && s.status === 'passed')) || !r.hostUnchanged) return 'failed'
  const b = r.browser
  if (!b?.actualChromium || !b.trace || !b.screenshots?.length || b.pageErrors?.length !== 0 || !b.completeReply || !b.historyAfterReload) return 'failed'
  // 本入口没有 native GUI driver；拒绝用外部 passed 自述升级证据。
  return 'passed-web-native-missing'
}

function physical(file) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.existsSync(p)) assert.ok(!fs.lstatSync(p).isSymbolicLink(), `路径含 reparse/symlink: ${p}`)
    if (p === path.dirname(p)) break
  }
  return file
}
function ps(code) {
  // Windows PowerShell 5.1 自行建立模块路径，不继承 PS7 的不兼容模块；仅改子环境副本。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.replace(/^\uFEFF/, ''))
}
export function actualRunnerProof() {
  assert.ok(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Windows 资格门禁：本机/自托管不启动候选')
  const local = ps(`$id=[Security.Principal.WindowsIdentity]::GetCurrent();$sid=$id.User.Value;$p=(Get-ItemProperty -LiteralPath ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$sid)).ProfileImagePath;$c=Get-CimInstance Win32_ComputerSystem;@{sid=$sid;userName=($id.Name -split '\\\\')[-1];actualProfile=[Environment]::GetFolderPath('UserProfile');registeredProfile=$p;virtualMachine=($c.Model -match 'Virtual Machine')}|ConvertTo-Json`)
  const git = spawnSync('git', ['--no-optional-locks', '-C', tooling, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }); assert.equal(git.status, 0)
  return { ...local, platform: process.platform, arch: process.arch, runnerEnvironment: process.env.RUNNER_ENVIRONMENT, runnerOS: process.env.RUNNER_OS, event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, repository: process.env.GITHUB_REPOSITORY, workflowRef: process.env.GITHUB_WORKFLOW_REF, workflowSha: process.env.GITHUB_WORKFLOW_SHA, toolingSha: git.stdout.trim(), runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion }
}

export function hostSnapshot(proof) {
  const profile64 = Buffer.from(proof.actualProfile).toString('base64')
  const data = ps(`
$ErrorActionPreference='Stop'
function Get-ClawPanelUtf8Sha256($s){$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
$registry=@();foreach($p in @('HKCU:\\Environment','HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment','HKCU:\\Software\\Microsoft\\Command Processor')){if(Test-Path -LiteralPath $p){$k=Get-Item -LiteralPath $p;foreach($n in ($k.GetValueNames()|Sort-Object)){$v=$k.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$registry+=@{hive=$p;name=$n;kind=$k.GetValueKind($n).ToString();sha256=(Get-ClawPanelUtf8Sha256 (ConvertTo-Json -InputObject $v -Compress))}}}else{$registry+=@{hive=$p;absent=$true}}}
$real=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${profile64}'))
$shells=@();$paths=@($PROFILE.AllUsersAllHosts,$PROFILE.AllUsersCurrentHost,$PROFILE.CurrentUserAllHosts,$PROFILE.CurrentUserCurrentHost,"$real\\.bashrc","$real\\.bash_profile","$real\\.profile","$real\\.zshrc","$real\\Documents\\PowerShell\\profile.ps1","$real\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1")
foreach($p in ($paths|Sort-Object -Unique)){$exists=Test-Path -LiteralPath $p;$shells+=@{path=$p;exists=$exists;sha256=$(if($exists){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash}else{$null})}}
$launchers=@();$dirs=@(($env:PATH -split ';')+@("$real\\AppData\\Roaming\\npm","$real\\.local\\bin","$real\\.hermes\\bin"))|Sort-Object -Unique
foreach($d in $dirs){if($d -and (Test-Path -LiteralPath $d)){foreach($f in (Get-ChildItem -LiteralPath $d -File -ErrorAction Stop|Where-Object {$_.Name -match '^(hermes|uv|node|npm|python|git)([.-].*|[0-9.]*\\.exe|\\.cmd|\\.ps1)?$'}|Sort-Object FullName)){$launchers+=@{path=$f.FullName;bytes=$f.Length;sha256=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash}}}}
@{registry=$registry;shells=$shells;launchers=$launchers;executionPolicy=@(Get-ExecutionPolicy -List|ForEach-Object {@{scope=$_.Scope.ToString();value=$_.ExecutionPolicy.ToString()}})}|ConvertTo-Json -Depth 7`)
  return { ...data, parentEnvSha256: digest(JSON.stringify(Object.entries(process.env).sort())) }
}

// 只旁听真实 spawn 的参数/输出/退出，不替换返回值、环境、信号或阶段执行。
export function spawnAuditSource(log) {
  return `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawn;const file=${JSON.stringify(log)};cp.spawn=function(...args){const child=Reflect.apply(original,this,args);const a=Array.isArray(args[1])?args[1]:[];const i=a.findIndex(x=>String(x).toLowerCase()==='-stage');const record=v=>fs.appendFileSync(file,JSON.stringify({pid:child.pid,program:args[0],args:a,stage:i>=0?a[i+1]:null,...v,at:new Date().toISOString()})+'\\n');if(child.pid)record({event:'start'});let stdout='',stderr='';child.stdout?.on('data',d=>{stdout=(stdout+d).slice(-1048576)});child.stderr?.on('data',d=>{stderr=(stderr+d).slice(-1048576)});child.on('close',(code,signal)=>record({event:'close',exitCode:code,signal,stdout,stderr}));return child};syncBuiltinESMExports();`
}

async function reachable(port) { return new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port }); s.on('connect', () => { s.destroy(); resolve(true) }); s.on('error', () => resolve(false)); s.setTimeout(750, () => { s.destroy(); resolve(false) }) }) }
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)) }) }) }
async function until(fn, timeout = 120000) { const start = Date.now(); while (Date.now() - start < timeout) { const x = await fn(); if (x) return x; await wait(500) } throw new Error('有界等待超时') }

export function verifyLinuxEvidence(output, sha, version) {
  const runtime = read(path.join(output, 'runtime/report.json'))
  assert.equal(runtime.status, 'passed'); assert.equal(runtime.cases.length, 11); assert.ok(runtime.cases.every(c => c.status === 'passed')); assert.equal(runtime.versions.hermes, version)
  const ready = read(path.join(output, 'server/ready.json')); assert.equal(ready.home, '/tmp/runtime/home'); assert.equal(ready.sourceSha, sha); assert.equal(ready.version, version)
  for (const n of [1, 2]) {
    const dir = path.join(output, `browser-round${n}`), r = read(path.join(dir, 'report.json'))
    assert.equal(r.ok, true); assert.equal(r.steps.length, 8); assert.deepEqual(r.errors, [])
    assert.ok(r.hold.elapsedSeconds >= 210); assert.equal(r.hold.health.length, 42); assert.ok(r.hold.health.every(h => h.status === 200 && Number.isFinite(Date.parse(h.at))))
    assert.ok(Date.parse(r.hold.health.at(-1).at) - Date.parse(r.hold.health[0].at) >= 200000)
    assert.ok(fs.statSync(path.join(dir, 'trace.zip')).size > 1000)
    assert.ok(fs.readdirSync(dir).some(f => f.endsWith('.png') && fs.statSync(path.join(dir, f)).size > 1000))
  }
  const stop = read(path.join(output, 'server/stop.json'))
  assert.equal(stop.status, 'passed'); assert.equal(stop.productionStop, true); assert.equal(stop.pidsExited, true); assert.equal(stop.portsClosed, true)
  return { status: 'passed-linux-fresh11-and-two-warm-long-ui', sha, version, nativeTauri: 'not-run', coldInstallations: 1, uiRounds: 2 }
}

async function execute(o) {
  for (const k of ['--root', '--sha', '--version', '--variant', '--output']) assert.ok(o[k], `缺少 ${k}`)
  const output = path.resolve(o['--output']); physical(output); assert.ok(!fs.existsSync(output), '输出必须全新'); fs.mkdirSync(output, { recursive: true })
  const r = { schemaVersion: 1, status: 'failed', candidateSha: o['--sha'], expectedVersion: o['--version'], variant: o['--variant'], startedAt: new Date().toISOString(), commands: [], installerStarted: false, stages: STAGES.map(name => ({ name, status: 'missing' })), nativeTauri: { status: 'not-run', qualificationComplete: false }, limitations: ['仅手工一次性托管 Windows 的真实 Web 验收，不证明 native Tauri GUI', 'HOME 隔离不是 Windows HKCU 沙箱；因此本机/self-hosted 均在候选执行前拒绝', '不自动恢复宿主变更，不自动重试，不使用业务凭据或收费模型'] }
  const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(r, null, 2))
  const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2))
  let env, home, project, before, proof, web, provider, base, runtimePort, dashboardPort, browser, context, cli, python, release, lastSession, stopped = true, installCursor = 0
  const runtimePids = new Set(), pendingCommands = new Set(), calls = [], providerHTTP = [], apiReceipts = []
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  async function run(program, args, { cwd = project, timeout = 120000 } = {}) {
    const index = r.commands.length, item = { program, args, cwd, startedAt: new Date().toISOString() }; r.commands.push(item); save()
    const log = path.join(output, `command-${index}`)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); item.pid = child.pid; if (child.pid) pendingCommands.add(child.pid)
      let stdout = '', stderr = ''; child.stdout.on('data', d => { fs.appendFileSync(log + '.stdout.log', d); stdout = (stdout + d).slice(-16777216) }); child.stderr.on('data', d => { fs.appendFileSync(log + '.stderr.log', d); stderr = (stderr + d).slice(-16777216) })
      const timer = setTimeout(() => { child.kill(); reject(new Error(`命令超时: ${program}`)) }, timeout)
      child.once('error', e => { clearTimeout(timer); reject(e) }); child.once('close', code => { clearTimeout(timer); pendingCommands.delete(child.pid); Object.assign(item, { exitCode: code, finishedAt: new Date().toISOString() }); save(); resolve({ code, stdout, stderr }) })
    })
    assert.equal(result.code, 0, `${program}: ${result.stderr.slice(-3000)}`); return result.stdout.trim()
  }
  const git = args => run('git', ['--no-optional-locks', ...args])
  async function api(cmd, args = {}, timeout = 120000) {
    const response = await fetch(base + '/__api/' + cmd, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(timeout) })
    const value = await response.json(); apiReceipts.push({ cmd, status: response.status, at: new Date().toISOString(), result: value }); write('api-receipts.json', apiReceipts)
    assert.ok(response.ok && !value?.error, `${cmd}: ${JSON.stringify(value)}`); return value
  }
  async function stage(name, fn) {
    const s = r.stages.find(x => x.name === name); Object.assign(s, { status: 'running', startedAt: new Date().toISOString() }); save()
    try { s.actual = await fn(); assertHostUnchanged(before, hostSnapshot(proof)); s.status = 'passed' }
    catch (e) { s.status = 'failed'; s.error = e.stack; throw e }
    finally { s.finishedAt = new Date().toISOString(); save() }
  }
  async function completion() {
    const status = await api('check_hermes'); assert.equal(status.installed, true); assert.equal(status.version, o['--version'])
    const source = path.join(env.HERMES_HOME, 'hermes-agent')
    const actualCommit = await git(['-C', path.join(env.HERMES_HOME, 'hermes-agent'), 'rev-parse', 'HEAD'])
    const snippet = "import sys,json,importlib; print(json.dumps({'python':sys.executable,'modules':{n:importlib.import_module(n).__file__ for n in ['hermes_cli.main','fastapi','uvicorn']}}))"
    let probe, pm, commandSpec
    if (o['--version'] === '0.22.2') {
      let canonical = fs.realpathSync(source); canonical = canonical.startsWith('\\\\?\\UNC\\') ? '\\\\' + canonical.slice(8) : canonical.replace(/^\\\\\?\\/, '')
      const key = digest(canonical).slice(0, 16), state = path.join(env.HERMES_HOME, 'installs', key), factsFile = path.join(state, 'facts.json')
      physical(factsFile); const dependencyEnvironment = read(factsFile).packages?.venv?.environment
      assert.ok(typeof dependencyEnvironment === 'string' && path.isAbsolute(dependencyEnvironment), 'PM facts 缺真实 environment')
      physical(dependencyEnvironment); assert.ok(within(path.join(state, 'environments'), fs.realpathSync(dependencyEnvironment))); assert.ok(fs.statSync(path.join(dependencyEnvironment, 'pyvenv.cfg')).isFile())
      const dependencyPython = path.join(dependencyEnvironment, 'Scripts/python.exe'); physical(dependencyPython); assert.ok(within(home, fs.realpathSync(dependencyPython)))
      const helper = fs.readFileSync(path.join(project, 'scripts/hermes-pm-runtime.js'), 'utf8')
      const original = name => { const body = helper.match(new RegExp('export const ' + name + ' = String.raw`([\\s\\S]*?)\\n`'))?.[1]; assert.ok(body && body.includes(release.commit), `缺原始 PM helper ${name}`); return body }
      const launch = original('HERMES_PRIVATE_LAUNCH_SCRIPT'), metadata = original('HERMES_PRIVATE_METADATA_SCRIPT')
      const index = r.commands.length
      probe = JSON.parse(await run(dependencyPython, ['-I', '-B', '-c', launch, source, env.HERMES_HOME, release.commit, '--python-json', snippet]))
      const stderr = fs.readFileSync(path.join(output, `command-${index}.stderr.log`), 'utf8')
      const preflightLine = stderr.split(/\r?\n/).findLast(s => s.startsWith('CLAWPANEL_HERMES_PRIVATE_PREFLIGHT ')); assert.ok(preflightLine, '缺原始 selected-store preflight 回执')
      const preflight = JSON.parse(preflightLine.slice('CLAWPANEL_HERMES_PRIVATE_PREFLIGHT '.length))
      python = fs.realpathSync(probe.python); assert.ok(within(path.join(env.HERMES_HOME, 'tools'), python), 'probe 未进入 selected store Python')
      commandSpec = { program: dependencyPython, args: ['-I', '-B', '-c', metadata, source, release.commit], role: 'pm-bootstrap-metadata', actualSelectedInterpreter: python }
      const versionText = await run(commandSpec.program, commandSpec.args); assert.ok(versionText.includes(o['--version']), '实际 Hermes metadata 版本不符，不能用 Python --version 代替')
      const events = fs.readFileSync(path.join(output, 'spawn-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)).slice(installCursor)
      const lines = events.filter(e => e.exitCode === 0).flatMap(e => String(e.stdout || '').split(/\r?\n/))
      const completed = lines.findLast(s => s.startsWith('CLAWPANEL_HERMES_PRIVATE_COMPLETION ')); assert.ok(completed, '缺原始 PM private products completion 回执')
      const completionProof = JSON.parse(completed.slice('CLAWPANEL_HERMES_PRIVATE_COMPLETION '.length))
      for (const p of [completionProof.bootRecord, preflight.bootRecord]) { assert.ok(typeof p === 'string'); physical(p); assert.ok(within(env.HERMES_HOME, fs.realpathSync(p))); const boot = read(p); assert.equal(boot.identity, release.commit); assert.ok(Object.values(boot.results || {}).length && Object.values(boot.results).every(s => s.ok === true), '原始 boot record 不完整') }
      pm = { factsFile, dependencyEnvironment, dependencyPython, selectedStorePython: python, completion: completionProof, preflight, helperSha256: r.sourceHashes['scripts/hermes-pm-runtime.js'] }
    } else {
      // 旧版本只使用真实验证过的受管 venv；status.path 可能是解释器，不能当 CLI 执行。
      cli = path.join(source, 'venv/Scripts/hermes.exe'); python = path.join(source, 'venv/Scripts/python.exe')
      for (const f of [cli, python]) { physical(f); assert.ok(within(home, fs.realpathSync(f))) }
      commandSpec = { program: cli, args: ['--version'], role: 'legacy-managed-hermes-cli' }
      assert.ok((await run(commandSpec.program, commandSpec.args)).includes(o['--version']))
      probe = JSON.parse(await run(python, ['-c', snippet])); assert.equal(fs.realpathSync(probe.python), fs.realpathSync(python))
    }
    const events = fs.readFileSync(path.join(output, 'spawn-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x))
    const receipt = { ...probe, python, cli: cli || null, reportedStatusPath: status.path, commandSpec, pm, commit: actualCommit, version: status.version, requiredStages: release.stages, stages: events.slice(installCursor).filter(e => e.stage).map(e => ({ name: e.stage, exitCode: e.exitCode, pid: e.pid, at: e.at })) }
    validatePrivateCompletion(receipt, { home, version: o['--version'], commit: release.commit })
    const installer = path.join(env.HERMES_HOME, '.clawpanel-cache', `install-${release.tag}.ps1`); assert.equal(hash(installer), release.installerSha256)
    write('privatecompletion.json', receipt); return receipt
  }
  function markInstall() { const f = path.join(output, 'spawn-audit.jsonl'); installCursor = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0 }
  async function capturePids() {
    const encoded = Buffer.from(env.HERMES_HOME).toString('base64')
    const rows = ps(`$h=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));@(Get-CimInstance Win32_Process|Where-Object {$_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($h)}|Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate)|ConvertTo-Json -Depth 4`)
    for (const p of (Array.isArray(rows) ? rows : rows ? [rows] : [])) runtimePids.add(p.ProcessId)
    assert.ok(runtimePids.size, '没有真实 Hermes runtime PID'); write('runtime-pids.json', { pids: [...runtimePids], actual: rows }); return rows
  }
  async function stopRuntime() {
    if (!base || stopped) return
    await api('hermes_dashboard_stop'); await api('hermes_gateway_action', { action: 'stop' })
    await until(async () => !(await reachable(runtimePort)) && !(await reachable(dashboardPort)) && [...runtimePids].every(pid => !alive(pid)), 30000)
    write('stop-pids-ports.json', { productionStop: true, pids: [...runtimePids], pidsExited: true, ports: [runtimePort, dashboardPort], portsClosed: true }); stopped = true
  }
  const history = async () => {
    const sessions = await api('hermes_sessions_list', { limit: 100 }); const list = Array.isArray(sessions) ? sessions : sessions.sessions
    assert.ok(list?.length, '真实历史为空')
    for (const s of list) { const detail = await api('hermes_session_detail', { sessionId: s.id || s.session_id }); if (JSON.stringify(detail).includes(lastSession.reply)) return detail }
    throw new Error('真实 CLI 历史没有完整本轮回复')
  }
  try {
    proof = actualRunnerProof(); write('runner-proof.json', proof)
    r.runnerAdmission = { passed: false, failedConditions: runnerProofFailures(proof) }
    r.runnerAdmission.passed = r.runnerAdmission.failedConditions.length === 0
    write('runner-admission.json', r.runnerAdmission); save(); validateRunnerProof(proof)
    r.toolingDependencies = Object.fromEntries(['scripts/test-hermes-windows-qualification.mjs', 'scripts/hermes-qualification-provider.mjs'].map(file => [file, hash(path.join(tooling, file))]))
    write('tooling-dependencies.json', { sha: proof.toolingSha, files: r.toolingDependencies })
    assert.ok(within(physical(process.env.RUNNER_TEMP), output), '输出不在本次 RUNNER_TEMP')
    assert.ok(within(physical(process.env.GITHUB_WORKSPACE), physical(o['--root'])), '候选不在 checkout workspace')
    before = hostSnapshot(proof); write('host-before.json', before)
    home = path.join(output, 'h'); assert.ok(home.length <= 96, 'Windows 私有 HOME 路径过长'); fs.mkdirSync(home)
    env = isolationEnv({ home, temp: path.join(output, 't'), realProfile: proof.actualProfile })
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'HERMES_HOME', 'OPENCLAW_CONFIG_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'TEMP']) fs.mkdirSync(physical(env[key]), { recursive: true })
    for (const key of ['GIT_CONFIG_GLOBAL', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG']) fs.writeFileSync(env[key], '')
    write('isolationenv.json', env)
    write('isolation-proof.json', { fullEnvironmentSha256: digest(JSON.stringify(env)), credentialInheritance: false, privatePaths: Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'HERMES_HOME', 'OPENCLAW_CONFIG_DIR'].map(k => [k, env[k]])), pathVariableCount: Object.keys(env).filter(k => k.toLowerCase() === 'path').length })
    project = path.join(output, 'source'); fs.mkdirSync(project)
    await stage('source-isolation', async () => {
      assert.equal(await git(['-C', o['--root'], 'rev-parse', 'HEAD']), o['--sha'])
      assert.equal(await git(['-C', o['--root'], 'status', '--porcelain', '--untracked-files=no']), '')
      const source = {}, tree = (await git(['-C', o['--root'], 'ls-tree', '-r', '--full-tree', o['--sha']])).split('\n')
      for (const line of tree) {
        const m = line.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/); assert.ok(m, '拒绝 symlink/submodule/特殊 Git tree entry')
        const [, , oid, file] = m; assert.ok(within(project, path.resolve(project, file)))
        const bytes = spawnSync('git', ['--no-optional-locks', '-C', o['--root'], 'show', `${o['--sha']}:${file}`], { env, windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 * 1024 })
        assert.equal(bytes.status, 0); assert.equal(crypto.createHash('sha1').update(`blob ${bytes.stdout.length}\0`).update(bytes.stdout).digest('hex'), oid)
        const target = path.join(project, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes.stdout); source[file] = hash(target)
      }
      write('source-sha256.json', { sha: o['--sha'], method: 'literal git show raw bytes + ls-tree blob SHA1 + readback SHA256', files: source }); r.sourceHashes = source
      assertSameSource(project, source)
      const webSource = fs.readFileSync(path.join(project, 'scripts/dev-api.js'), 'utf8'), rust = fs.readFileSync(path.join(project, 'src-tauri/src/commands/hermes.rs'), 'utf8')
      const version = webSource.match(/HERMES_STABLE_VERSION = '([^']+)'/)?.[1], tag = webSource.match(/HERMES_STABLE_TAG = '([^']+)'/)?.[1], commit = webSource.match(/HERMES_STABLE_COMMIT = '([^']+)'/)?.[1]
      assert.equal(version, o['--version']); assert.ok(exactSha(commit)); assert.ok(rust.includes(`HERMES_STABLE_VERSION: &str = "${version}"`) && rust.includes(commit))
      const stages = webSource.match(/stages:\s*\[([^\]]+)\]/)?.[1].match(/'([^']+)'/g)?.map(x => x.slice(1, -1))
      const installerSha256 = webSource.match(/HERMES_INSTALLER_SHA256\s*=\s*\{\s*windows:\s*'([a-f0-9]{64})'/)?.[1]
      assert.ok(stages?.length >= 5 && installerSha256, '缺真实 Windows 安装协议/hash')
      if (version === '0.22.2') assert.deepEqual(stages, ['repository', 'venv', 'python-deps', 'config', 'complete'], '22.2 upstream stage 协议不符，不虚构 node-deps')
      release = { version, tag, commit, stages, installerSha256 }; write('release.json', release)
      await run(process.execPath, [npmCli, 'ci'], { timeout: 600000 }); await run(process.execPath, [path.join(project, 'node_modules/vite/bin/vite.js'), 'build'])
      const dist = {}; function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else { assert.ok(e.isFile()); dist[path.relative(project, f)] = hash(f) } } } walk(path.join(project, 'dist')); write('dist-sha256.json', dist); r.distHashes = dist
      r.nativeTauri.entryEvidence = { scope: 'source-only, not native execution', file: 'src-tauri/src/commands/hermes.rs', sha256: source['src-tauri/src/commands/hermes.rs'], commands: ['install_hermes', 'update_hermes', 'uninstall_hermes'] }
      return { tracked: Object.keys(source).length, dist: Object.keys(dist).length, release }
    })
    runtimePort = await freePort(); dashboardPort = await freePort(); const webPort = await freePort(); assert.equal(new Set([runtimePort, dashboardPort, webPort]).size, 3)
    fs.writeFileSync(path.join(env.OPENCLAW_CONFIG_DIR, 'clawpanel.json'), JSON.stringify({ ignoreRisk: true, openclawDir: env.OPENCLAW_CONFIG_DIR, engineMode: 'hermes', enabledEngines: ['hermes'], engineSetupChoice: 'explicit' }))
    fs.writeFileSync(path.join(env.OPENCLAW_CONFIG_DIR, 'openclaw.json'), '{}\n')
    r.environment = { home, hermesHome: env.HERMES_HOME, output, source: project, checkout: path.resolve(o['--root']), sourceSha: o['--sha'] }
    const audit = path.join(home, 'spawn-audit.mjs'); fs.writeFileSync(audit, spawnAuditSource(path.join(output, 'spawn-audit.jsonl')))
    web = spawn(process.execPath, ['--import', pathToFileURL(audit).href, path.join(project, 'scripts/serve.js'), '--host', '127.0.0.1', '--port', String(webPort)], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    r.webPid = web.pid; r.webPort = webPort; web.stdout.on('data', d => fs.appendFileSync(path.join(output, 'serve.stdout.log'), d)); web.stderr.on('data', d => fs.appendFileSync(path.join(output, 'serve.stderr.log'), d)); web.on('exit', (code, signal) => { r.webExit = { code, signal, at: new Date().toISOString() }; save() })
    base = `http://127.0.0.1:${webPort}`; await until(() => reachable(webPort), 30000)
    await stage('install-privatecompletion', async () => { r.installerStarted = true; markInstall(); save(); await api('install_hermes', { method: 'uv-tool' }, 900000); return completion() })
    await stage('runtime-ui', async () => {
      const providerModels = ['qualification-one', 'qualification-two']
      provider = http.createServer(async (req, res) => {
        let raw = '', receipt
        const authMatches = req.headers.authorization === 'Bearer qualification-local-no-secret'
        const record = fields => {
          receipt = { seq: providerHTTP.length + 1, at: new Date().toISOString(), method: req.method, path: req.url, bodySha256: digest(raw), authMatches, ...fields }
          providerHTTP.push(receipt); write('provider-http.json', providerHTTP)
        }
        try {
        for await (const d of req) { raw += d; if (raw.length > 8388608) { r.providerError = 'provider request body too large'; record({ kind: 'unknown', body: {}, responseStatus: 413, accepted: false }); save(); res.writeHead(413); return res.end() } }
        const metadata = classifyHermesMetadataRequest(req.method, req.url, raw, providerModels)
        if (metadata) {
          record({ kind: 'metadata', body: req.method === 'POST' ? JSON.parse(raw) : {}, responseStatus: metadata.status, provider: metadata.provider, accepted: true })
          write('provider-metadata.json', providerHTTP.filter(row => row.kind === 'metadata'))
          res.writeHead(metadata.status, { 'content-type': 'application/json' })
          if (metadata.status === 200) return res.end(JSON.stringify({ data: providerModels.map(id => ({ id, object: 'model' })) }))
          return res.end(JSON.stringify({ error: 'metadata protocol not provided by this OpenAI fixture' }))
        }
        assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions')
        const b = JSON.parse(raw), nonce = [...JSON.stringify(b.messages || []).matchAll(/hq-[a-f0-9-]{36}/g)].at(-1)?.[0], reply = `Hermes qualification reply ${nonce} ${b.model}.`
        const purpose = classifyProviderRequest(b), system = (b.messages || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n')
        record({ kind: purpose === 'unattributed' ? 'unknown' : purpose, body: { model: b.model }, model: b.model, nonce, responseStatus: 200, accepted: authMatches && purpose !== 'unattributed' })
        calls.push({ at: new Date().toISOString(), kind: receipt.kind, method: req.method, path: req.url, bodySha256: digest(raw), purpose, systemPrefix: system.slice(0, 200), systemSha256: digest(system), url: req.url, nonce, model: b.model, stream: b.stream, messages: b.messages, authenticated: req.headers.authorization === 'Bearer qualification-local-no-secret' }); write('provider-requests.json', calls)
        assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer qualification-local-no-secret')
        if (b.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const delta of [{ role: 'assistant', content: '' }, { content: reply }, {}]) res.write('data: ' + JSON.stringify({ id: 'qualification', object: 'chat.completion.chunk', model: b.model, choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] }) + '\n\n'); res.end('data: [DONE]\n\n') }
        else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'qualification', object: 'chat.completion', model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })) }
        } catch (e) { r.providerError = String(e); if (!receipt) record({ kind: 'unknown', body: {}, responseStatus: 500, accepted: false }); else { receipt.responseStatus = 500; receipt.accepted = false; write('provider-http.json', providerHTTP) }; if (!res.headersSent) res.writeHead(500); res.end('qualification provider error'); save() }
      }); await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
      r.providerPort = provider.address().port
      const url = `http://127.0.0.1:${provider.address().port}/v1`
      await api('configure_hermes', { provider: 'custom', apiKey: 'qualification-local-no-secret', baseUrl: url, model: 'qualification-one' })
      // 只修改一次性 HOME 内配置，选随机 dashboard 端口，不覆盖真实用户文件。
      // 在隔离子进程内用候选锁定的 YAML 库合并，避免追加重复 dashboard 键破坏已有配置。
      const merge = `import fs from 'node:fs';import YAML from ${JSON.stringify(pathToFileURL(path.join(project, 'node_modules/yaml/browser/index.js')).href)};const f=process.argv[1];const c=YAML.parse(fs.readFileSync(f,'utf8'))||{};c.dashboard={...(c.dashboard||{}),port:Number(process.argv[2])};c.qualification_marker=process.argv[3];fs.writeFileSync(f,YAML.stringify(c));`
      await run(process.execPath, ['--input-type=module', '-e', merge, path.join(env.HERMES_HOME, 'config.yaml'), String(dashboardPort), o['--sha']])
      await api('hermes_env_set', { key: 'API_SERVER_HOST', value: '127.0.0.1' }); await api('hermes_env_set', { key: 'API_SERVER_PORT', value: String(runtimePort) }); await api('hermes_set_gateway_url', { url: `http://127.0.0.1:${runtimePort}` })
      const profiles = await api('hermes_profiles_list'); assert.ok(profiles.profiles.some(p => p.name === 'default')); await api('hermes_profile_use', { name: 'default' })
      stopped = false; await api('hermes_gateway_action', { action: 'start' }); await api('hermes_health_check'); await api('hermes_capabilities'); await api('hermes_gateway_action', { action: 'status' })
      const dash = await api('hermes_dashboard_start'); assert.equal(dash.started, true); assert.equal((await api('hermes_dashboard_probe')).running, true); await capturePids()
      await run(process.execPath, [npmCli, 'install', '--prefix', path.join(home, 'browser-tools'), '--no-save', '--ignore-scripts', '--package-lock=false', 'playwright@1.58.2'], { timeout: 600000 })
      await run(process.execPath, [path.join(home, 'browser-tools/node_modules/playwright/cli.js'), 'install', 'chromium'], { timeout: 600000 })
      const { chromium } = await import(pathToFileURL(path.join(home, 'browser-tools/node_modules/playwright/index.mjs')))
      browser = await chromium.launch({ headless: true }); context = await browser.newContext({ locale: 'zh-CN' }); await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
      const pageErrors = [], screenshots = [], prompts = []; context.on('page', p => p.on('pageerror', e => pageErrors.push(String(e))))
      const page = await context.newPage(); await page.goto(base + '/#/h/chat'); await page.locator('#hm-chat-input').waitFor()
      const dashPage = await context.newPage(); const dashResponse = await dashPage.goto(`http://127.0.0.1:${dashboardPort}`); assert.equal(dashResponse.status(), 200); await dashPage.locator('body').waitFor(); await dashPage.screenshot({ path: path.join(output, 'dashboard.png'), fullPage: true }); screenshots.push('dashboard.png'); await dashPage.close()
      for (const model of ['qualification-one', 'qualification-two', 'qualification-two']) {
        if (prompts.length === 1) { await api('hermes_sync_provider', { provider: 'custom', apiKey: 'qualification-local-no-secret', baseUrl: url, model, setDefault: true }); await page.reload(); await page.locator('#hm-chat-input').waitFor() }
        if (prompts.length === 2) { const beforeCalls = calls.length; await context.setOffline(true); await page.waitForTimeout(1500); await context.setOffline(false); await page.reload(); await page.locator('#hm-chat-input').waitFor(); assert.equal(calls.length, beforeCalls, '重连不应重放聊天') }
        await page.locator('#hm-chat-new-chat').click(); const nonce = 'hq-' + crypto.randomUUID(), reply = `Hermes qualification reply ${nonce} ${model}.`; prompts.push({ nonce, model, reply }); lastSession = { reply }
        await page.locator('#hm-chat-input').fill(nonce); await page.locator('#hm-chat-send').click(); await page.getByText(reply, { exact: false }).first().waitFor({ timeout: 120000 }); await page.locator('#hm-chat-stop').waitFor({ state: 'hidden', timeout: 120000 })
        const name = `chat-${prompts.length}.png`; await page.screenshot({ path: path.join(output, name), fullPage: true }); screenshots.push(name)
      }
      await history(); await page.reload(); await page.getByText(lastSession.reply, { exact: false }).first().waitFor({ timeout: 30000 }); await page.screenshot({ path: path.join(output, 'history.png'), fullPage: true }); screenshots.push('history.png')
      assert.deepEqual(pageErrors, []); assert.equal(calls.filter(c => c.purpose === 'unattributed').length, 0, '额外 Provider 请求未归因，保留 system/raw 回执，不冒充 chat/title')
      for (const p of prompts) { assert.equal(calls.filter(c => c.purpose === 'chat' && c.nonce === p.nonce && c.model === p.model).length, 1, '聊天请求必须恰好一次'); assert.ok(calls.filter(c => c.purpose === 'title' && c.nonce === p.nonce).length <= 1, '同 nonce 标题请求重复') }
      assert.ok(calls.every(c => c.authenticated && prompts.some(p => p.nonce === c.nonce)), '未知 nonce 或认证不符')
      r.providerAttribution = { chats: calls.filter(c => c.purpose === 'chat').length, titles: calls.filter(c => c.purpose === 'title').length, unknown: 0, prompts }
      await context.tracing.stop({ path: path.join(output, 'trace.zip') }); await browser.close(); browser = null
      r.browser = { actualChromium: true, screenshots, trace: 'trace.zip', pageErrors, completeReply: true, historyAfterReload: true, prompts }; write('browser-report.json', r.browser)
      return { profiles, dash, providerRequests: calls.length }
    })
    const sentinel = path.join(env.HERMES_HOME, 'memories/qualification.txt'); fs.mkdirSync(path.dirname(sentinel), { recursive: true }); fs.writeFileSync(sentinel, o['--sha']); const sentinelHash = hash(sentinel)
    const preserve = async () => { assert.equal(hash(sentinel), sentinelHash); assert.ok(fs.readFileSync(path.join(env.HERMES_HOME, 'config.yaml'), 'utf8').includes(`qualification_marker: ${o['--sha']}`)); assert.ok((await api('hermes_profiles_list')).profiles.some(p => p.name === 'default')); assert.equal((await api('hermes_read_config')).model_raw, 'qualification-two'); return history() }
    await stage('update-stop', async () => { await stopRuntime(); markInstall(); await api('update_hermes', {}, 900000); await completion(); await preserve(); return { productionStop: true, updateVerified: true } })
    await stage('uninstall-reinstall-preserve', async () => { await api('uninstall_hermes', { cleanConfig: false }); assert.equal((await api('check_hermes')).installed, false); assert.equal(hash(sentinel), sentinelHash); markInstall(); await api('install_hermes', { method: 'uv-tool' }, 900000); await completion(); await preserve(); stopped = false; await api('hermes_gateway_action', { action: 'start' }); await api('hermes_health_check'); assert.equal((await api('hermes_dashboard_start')).started, true); await capturePids(); await stopRuntime(); return { cleanConfig: false, actualHistoryReRead: true, memoryHash: sentinelHash, reinstalled: true, restartedAndStopped: true } })
  } catch (e) { r.error = e.stack; }
  finally {
    try { if (browser) { if (context) await context.tracing.stop({ path: path.join(output, 'failed-trace.zip') }); await browser.close() } } catch (e) { r.browserCleanupError = String(e) }
    try { await stopRuntime() } catch (e) { r.stopError = String(e) }
    // HTTP 安装超时也保留未退出的真实阶段 PID；只清理本观察器亲自记录且尚无 close 的子进程。
    const observed = path.join(output, 'spawn-audit.jsonl'), pendingObserved = new Set()
    if (fs.existsSync(observed)) {
      try { for (const line of fs.readFileSync(observed, 'utf8').trim().split('\n').filter(Boolean)) { const e = JSON.parse(line); if (e.event === 'start') pendingObserved.add(e.pid); if (e.event === 'close') pendingObserved.delete(e.pid) } }
      catch (e) { r.cleanupError = `子进程观察日志不完整: ${e.message}` }
    }
    const pending = [...new Set([...pendingObserved, ...pendingCommands])]
    write('pending-owned-children.json', { pids: pending, at: new Date().toISOString() })
    for (const pid of pending) if (alive(pid)) { const k = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { env, windowsHide: true, encoding: 'utf8' }); write(`owned-child-${pid}-taskkill.json`, { pid, status: k.status, stdout: k.stdout, stderr: k.stderr }) }
    if (web && alive(web.pid)) { const k = spawnSync('taskkill.exe', ['/PID', String(web.pid), '/T', '/F'], { env, windowsHide: true, encoding: 'utf8' }); write('owned-web-taskkill.json', { pid: web.pid, status: k.status, stdout: k.stdout, stderr: k.stderr }) }
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
    try {
      await until(async () => (!web || !alive(web.pid)) && (!r.webPort || !(await reachable(r.webPort))) && (!r.providerPort || !(await reachable(r.providerPort))) && pending.every(pid => !alive(pid)) && [...runtimePids].every(pid => !alive(pid)), 15000)
      write('infrastructure-stop.json', { webPid: web?.pid || null, webExited: true, webPort: r.webPort, providerPort: r.providerPort, allPortsClosed: true, pendingOwnedPids: pending, pendingOwnedPidsExited: true, runtimePids: [...runtimePids], runtimePidsExited: true })
    } catch (e) { r.cleanupError = String(e) }
    if (before) { try { const after = hostSnapshot(proof); write('host-after.json', after); assertHostUnchanged(before, after); r.hostUnchanged = true } catch (e) { r.hostUnchanged = false; r.hostChangeError = e.message } }
    if (r.sourceHashes) { r.sourceDrift = Object.keys(r.sourceHashes).filter(f => !fs.existsSync(path.join(project, f)) || hash(path.join(project, f)) !== r.sourceHashes[f]); if (r.sourceDrift.length) r.error = '源文件发生漂移' }
    if (r.distHashes) { r.distDrift = Object.keys(r.distHashes).filter(f => !fs.existsSync(path.join(project, f)) || hash(path.join(project, f)) !== r.distHashes[f]); if (r.distDrift.length) r.error = 'dist 发生漂移' }
    if (r.toolingDependencies) { r.toolingDrift = Object.keys(r.toolingDependencies).filter(f => !fs.existsSync(path.join(tooling, f)) || hash(path.join(tooling, f)) !== r.toolingDependencies[f]); if (r.toolingDrift.length) r.error = '可信 tooling 发生漂移' }
    if (env) { for (const name of ['gateway-run.log', 'dashboard-run.log']) { const f = path.join(env.HERMES_HOME, name); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(output, name)) } }
    r.status = r.error || r.stopError || r.browserCleanupError || r.cleanupError || r.providerError ? 'failed' : qualificationStatus(r); r.finishedAt = new Date().toISOString(); save()
  }
  console.log(JSON.stringify({ status: r.status, candidateSha: r.candidateSha, output, nativeTauri: 'not-run' }))
  return r.status === 'passed-web-native-missing' ? 0 : 1
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o['--matrix']) { console.log(JSON.stringify(matrixFromInputs(process.env))); return 0 }
  if (o['--verify-linux-evidence']) { assert.ok(exactSha(o['--sha'])); console.log(JSON.stringify(verifyLinuxEvidence(o['--verify-linux-evidence'], o['--sha'], o['--version']))); return 0 }
  if (o['--publish-evidence']) { assert.ok(o['--output'], '公开副本必须指定新 output'); console.log(JSON.stringify(await publishEvidence({ roots: { evidence: path.resolve(o['--publish-evidence']) }, output: o['--output'] }))); return 0 }
  if (o['--execute']) return execute(o)
  console.log(JSON.stringify({ stages: STAGES, installsOnLocalHost: false, nativeTauriRequiredForFullQualification: true, candidateSecrets: false, retries: 0, usage: '--execute --root candidate --sha <40hex> --version <0.x.y> --variant old|new --output <fresh RUNNER_TEMP/dir>', nativeTauri: 'separate missing gate, not upgraded by external receipt' }))
  return 0
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code }).catch(e => { console.error(e.stack); process.exitCode = 1 })
