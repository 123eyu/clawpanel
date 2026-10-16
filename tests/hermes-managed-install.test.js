import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const wrapper = path.join(root, 'scripts/hermes-managed-install.ps1')
const sha = s => crypto.createHash('sha256').update(s).digest('hex')
const psQuote = s => `'${s.replaceAll("'", "''")}'`
// 只有结构化适配入口处理此合成源；产品执行入口仍须固定官方原字节 hash。
const fixture = `function Set-ManagedNodeFirstOnUserPath {
param([string]$NodeDir)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$updated = "$NodeDir;$userPath"
[Environment]::SetEnvironmentVariable("Path", $updated, "User")
}
function Install-Git {
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$userPathItems = @($userPath, 'git-sink')
[Environment]::SetEnvironmentVariable("Path", ($userPathItems -join ";"), "User")
}
function Set-GitBashEnvVar {
$candidate = 'private-bash-sink'
[Environment]::SetEnvironmentVariable("HERMES_GIT_BASH_PATH", $candidate, "User")
}
`

function runPs(body) {
  assert.ok(fs.existsSync(wrapper), '缺共享固定 PS wrapper')
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "hermes managed 'sink-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH'))
  for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[k] = temp
  const source = path.join(temp, 'fixture.ps1'), entry = path.join(temp, 'test.ps1')
  fs.writeFileSync(source, fixture)
  fs.writeFileSync(entry, `$ErrorActionPreference='Stop'\n$wrapperPath=${psQuote(wrapper)}\n. $wrapperPath\n$fixturePath=${psQuote(source)}\n$temp=${psQuote(temp)}\n${body}\n`)
  try {
    const before = JSON.stringify(process.env), original = sha(fs.readFileSync(source))
    const r = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-File', entry], { env, encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(r.status, 0, `${r.error || ''}\n${r.stdout}\n${r.stderr}`)
    assert.equal(JSON.stringify(process.env), before)
    assert.equal(sha(fs.readFileSync(source)), original, '不得修改原输入字节')
    return JSON.parse(r.stdout.trim())
  } finally {
    assert.equal(path.dirname(fs.realpathSync(temp)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

test('JS读取和Rust include同一wrapper，固定旧pin及11stage经过wrapper而非原版直启', () => {
  const web = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8')
  const rust = fs.readFileSync(path.join(root, 'src-tauri/src/commands/hermes.rs'), 'utf8')
  assert.match(web, /readFileSync\(new URL\('\.\/hermes-managed-install\.ps1', import\.meta\.url\)\)/)
  assert.match(web, /'-File', wrapperPath, '-InstallerPath', scriptPath/)
  assert.match(web, /ensureHermesManagedWrapper\(plan\)/)
  assert.match(rust, /include_str!\("\.\.\/\.\.\/\.\.\/scripts\/hermes-managed-install\.ps1"\)/)
  assert.match(rust, /\.arg\(wrapper_path\)[^]*?\.arg\("-InstallerPath"\)[^]*?\.arg\(script_path\)/)
  assert.match(rust, /build_hermes_installer_stage_command\(&script_path, &wrapper_path, stage\)/)
  const ps = fs.readFileSync(wrapper, 'utf8')
  assert.match(ps, /0a80dfeb7434229933bac32e73140d10086dff81bd84b156e71be9abc87cddf2/)
  assert.match(ps, /f97608f178d1ffeca59860195ab7da295f7c8e5f/)
  assert.doesNotMatch(ps, /Set-ItemProperty|RegOverridePredefKey|SetEnvironmentVariable\([^\n]*['"](?:User|Machine)['"]/)
})

test('安装Env仅子环境钉UV隔离，移除跨版本PSModulePath，不改父环境与镜像', async () => {
  const { buildHermesInstallEnv } = await import('../scripts/dev-api.js')
  const base = { PATH: 'fixture-path', PSModulePath: 'PS7-only', pSmOdUlEpAtH: 'other', UV_NO_MODIFY_PATH: '0' }
  const original = { ...base }
  const env = buildHermesInstallEnv({ pypiMirror: 'https://fixture.invalid/simple' }, base)
  assert.equal(env.UV_NO_MODIFY_PATH, process.platform === 'win32' ? '1' : '0')
  assert.equal(Object.keys(env).some(k => k.toLowerCase() === 'psmodulepath'), process.platform !== 'win32')
  assert.equal(env.UV_DEFAULT_INDEX, 'https://fixture.invalid/simple')
  assert.deepEqual(base, original)
  const text = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8').match(/export function buildHermesInstallEnv\([^]*?\n\}/)?.[0]
  assert.ok(text)
  for (const windows of [true, false]) {
    const build = new Function('buildHermesRuntimeEnv', 'isWindows', `${text.replace(/^export /, '')};return buildHermesInstallEnv`)(e => ({ ...e }), windows)
    const actual = build({}, base)
    assert.equal(actual.UV_NO_MODIFY_PATH, windows ? '1' : '0', 'POSIX 环境不得被 Windows 修复改变')
    assert.equal(Object.keys(actual).some(k => k.toLowerCase() === 'psmodulepath'), !windows)
  }
})

test('Web真实私有cache写入与Windows11个实际argv均绑定同一wrapper原始字节', async () => {
  const { ensureHermesManagedWrapper, hermesInstallerPlan } = await import('../scripts/dev-api.js')
  assert.equal(typeof ensureHermesManagedWrapper, 'function')
  assert.equal(typeof hermesInstallerPlan, 'function')
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hermes-wrapper-bytes-'))
  try {
    const plan = hermesInstallerPlan(temp)
    fs.mkdirSync(path.dirname(plan.scriptPath), { recursive: true })
    const before = fs.readFileSync(wrapper)
    const cache = ensureHermesManagedWrapper(plan)
    assert.equal(path.dirname(cache), path.dirname(plan.scriptPath))
    assert.equal(path.basename(cache), `clawpanel-managed-${sha(before)}.ps1`)
    assert.deepEqual(fs.readFileSync(cache), before)
    fs.writeFileSync(cache, 'corrupt private cache')
    assert.equal(ensureHermesManagedWrapper(plan), cache)
    assert.deepEqual(fs.readFileSync(cache), before)
    assert.deepEqual(fs.readFileSync(wrapper), before)
    if (process.platform === 'win32') {
      assert.equal(plan.stages.length, 11)
      for (const stage of plan.stages) {
        const argv = plan.argsForStage(plan.scriptPath, stage, cache)
        assert.equal(argv[argv.indexOf('-File') + 1], cache)
        assert.equal(argv[argv.indexOf('-InstallerPath') + 1], plan.scriptPath)
        assert.equal(argv[argv.indexOf('-Stage') + 1], stage)
        assert.equal(argv[argv.indexOf('-Commit') + 1], 'f97608f178d1ffeca59860195ab7da295f7c8e5f')
      }
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('PS5真实临时sink：精确5节点适配/原字节不变，签名类型key目标数量异常均失败', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$source=[IO.File]::ReadAllText($fixturePath)
$r=Get-ClawPanelLegacyDefinitions $source
if($r.Redirections -ne 5){throw 'count'}
foreach($d in $r.Definitions){
  $a=[ScriptBlock]::Create($d).Ast
  $bad=@($a.FindAll({param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Value -eq 'User'},$true))
  if($bad.Count){throw 'unsafe fixture execution'}
  . ([ScriptBlock]::Create($d))
}
[Environment]::SetEnvironmentVariable('Path','process-sink','Process')
Set-ManagedNodeFirstOnUserPath 'node-sink'
Install-Git
Set-GitBashEnvVar
if($env:Path -ne 'node-sink;process-sink;git-sink' -or $env:HERMES_GIT_BASH_PATH -ne 'private-bash-sink'){throw 'process sink'}
$badSources=@(
  $source.Replace('[string]$NodeDir','[int]$NodeDir'),
  $source.Replace('[Environment]::SetEnvironmentVariable','[System.Environment]::SetEnvironmentVariable'),
  $source.Replace('"HERMES_GIT_BASH_PATH"','"UNEXPECTED"'),
  $source.Replace('"User"','"Machine"'),
  $source.Replace('function Install-Git {','function Install-Git { param($extra)'),
  ($source + $source),
  $source.Replace('$updated, "User"','$updated, "User", "extra"'),
  $source.Replace('"Path", "User"','"Path", "User"); [Environment]::GetEnvironmentVariable("Path", "User"')
)
$rejected=0
foreach($s in $badSources){try{ $null=Get-ClawPanelLegacyDefinitions $s }catch{$rejected++}}
if($rejected -ne $badSources.Count){throw "negative accepted: $rejected"}
@{pid=$PID;redirections=$r.Redirections;negativeRejected=$rejected;path=$env:Path;kind='isolated-process-sink-not-install'}|ConvertTo-Json -Compress
`)
  assert.equal(r.redirections, 5)
  assert.equal(r.negativeRejected, 8)
  assert.ok(r.pid > 0)
  t.diagnostic(JSON.stringify(r))
})

test('PS5真实子进程：跨stage私有PATH/UV继承，winget入口阻断且catch吞错后仍红', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$privateHome=Join-Path $temp 'private home'
$null=New-Item -ItemType Directory -Force (Join-Path $privateHome 'bin')
$null=New-Item -ItemType Directory -Force (Join-Path $privateHome 'node')
Initialize-ClawPanelLegacyEnvironment $privateHome 'baseline;BASELINE;tail'
Sync-ClawPanelLegacyPath
$first=$env:Path
$env:Path='damaged-stage-path'
Sync-ClawPanelLegacyPath
if($env:Path -ne $first -or $first -notlike '*baseline;tail'){throw 'stage path'}
$child=Join-Path $temp 'child.ps1'
[IO.File]::WriteAllText($child,'@{pid=$PID;flag=$env:UV_NO_MODIFY_PATH}|ConvertTo-Json -Compress')
$childResult=(& "$PSHOME/powershell.exe" -NoProfile -File $child)|ConvertFrom-Json
if($childResult.flag -ne '1'){throw 'nested uv flag'}
$script:ClawPanelWingetAttempted=$false
$caught=$false
$blockedFrames=New-Object 'System.Collections.Generic.List[object]'
try { Invoke-ClawPanelManagedStage { try { winget install example }catch{}; '{"stage":"node","ok":true,"skipped":false,"reason":null,"duration_ms":1}' } | ForEach-Object {$blockedFrames.Add($_)} }catch{$caught=$true}
if(-not $caught -or -not $script:ClawPanelWingetAttempted){throw 'swallowed forbidden fallback'}
if($blockedFrames.Count -ne 1 -or ($blockedFrames[0]|ConvertFrom-Json).ok){throw 'false stage frame'}
$blockedFrames.Clear()
try { Invoke-ClawPanelManagedStage { winget install example } | ForEach-Object {$blockedFrames.Add($_)} }catch{}
if($blockedFrames.Count -ne 1 -or ($blockedFrames[0]|ConvertFrom-Json).ok){throw 'missing failed stage frame'}
@{pid=$PID;childPid=$childResult.pid;flag=$childResult.flag;wingetBlocked=$caught;path=$first;kind='isolated-process-sink-not-install'}|ConvertTo-Json -Compress
`)
  assert.equal(r.wingetBlocked, true)
  assert.equal(r.flag, '1')
  assert.notEqual(r.pid, r.childPid)
  t.diagnostic(JSON.stringify(r))
})

test('PS5执行入口在任何安装前拒绝未知stage/错pin/非固定vendor hash', { skip: process.platform !== 'win32' }, t => {
  const r = runPs(`
$rejected=0
foreach($stage in @('', 'path', 'system-packages', 'gateway')){try{Assert-ClawPanelLegacyStage $stage}catch{$rejected++}}
if($rejected -ne 4){throw 'stage accepted'}
foreach($stage in @('uv','git','node','repository','python','venv','dependencies','node-deps','config-templates','platform-sdks','bootstrap-marker')){Assert-ClawPanelLegacyStage $stage}
$hashRejected=$false
try{ $null=Read-ClawPanelLegacyInstaller $fixturePath }catch{$hashRejected=$true}
if(-not $hashRejected){throw 'fixture accepted as vendor'}
$cli=@()
foreach($case in @(@('path','f97608f178d1ffeca59860195ab7da295f7c8e5f',2),@('uv','wrong-pin',1),@('uv','f97608f178d1ffeca59860195ab7da295f7c8e5f',1))){
  $savedEap=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  $o=(& "$PSHOME/powershell.exe" -NoProfile -File $wrapperPath -InstallerPath $fixturePath -HermesHome $temp -InstallDir (Join-Path $temp 'source') -Branch 'v2026.9.24' -Commit $case[1] -ForceCommit -SkipSetup -SkipComputerUse -NonInteractive -Json -Stage $case[0] 2>$null)
  $ErrorActionPreference=$savedEap
  if($LASTEXITCODE -ne $case[2]){throw "CLI exit: $LASTEXITCODE"}
  $frame=$o|ConvertFrom-Json
  if($frame.ok){throw 'CLI accepted unsafe source'}
  $cli+=@{exit=$LASTEXITCODE;stage=$case[0];ok=$frame.ok}
}
@{pid=$PID;rejected=$rejected;hashRejected=$hashRejected;cli=$cli}|ConvertTo-Json -Depth 4 -Compress
`)
  assert.equal(r.rejected, 4)
  assert.equal(r.hashRejected, true)
  assert.deepEqual(r.cli.map(x => x.exit), [2, 1, 1])
  t.diagnostic(JSON.stringify(r))
})
