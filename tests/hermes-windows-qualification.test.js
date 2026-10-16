import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import YAML from 'yaml'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = path.join(root, 'scripts/test-hermes-windows-qualification.mjs')
const load = () => import('../scripts/test-hermes-windows-qualification.mjs')
const sha = 'a'.repeat(40)
const proof = () => ({ platform: 'win32', runnerEnvironment: 'github-hosted', runnerOS: 'Windows', arch: 'x64', event: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'qingchencloud/clawpanel', workflowRef: 'qingchencloud/clawpanel/.github/workflows/hermes-qualification.yml@refs/heads/main', workflowSha: sha, toolingSha: sha, runId: '1234', attempt: '1', imageOS: 'win25', imageVersion: '20261016.1', virtualMachine: true, actualProfile: 'C:\\Users\\runneradmin', registeredProfile: 'C:\\Users\\runneradmin', userName: 'runneradmin', sid: 'S-1-5-21-1-2-3-1001' })

test('资格计划固定五阶段，实际安装协议及原生证据另立门禁', async () => {
  const q = await load()
  assert.deepEqual(q.STAGES, ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve'])
  const r = spawnSync(process.execPath, [script, '--plan'], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  const plan = JSON.parse(r.stdout)
  assert.equal(plan.installsOnLocalHost, false)
  assert.equal(plan.nativeTauriRequiredForFullQualification, true)
  assert.equal(plan.candidateSecrets, false)
  assert.equal(plan.retries, 0)
})

test('参数拒绝浮动或注入 SHA、未知参数和不精确版本', async () => {
  const q = await load()
  for (const bad of ['main', 'a'.repeat(7), `${sha}\n`, `${sha};echo x`]) assert.throws(() => q.parseArgs(['--sha', bad]), /SHA/)
  assert.throws(() => q.parseArgs(['--force']), /未知/)
  assert.throws(() => q.parseArgs(['--version', 'latest']), /版本/)
  assert.throws(() => q.parseArgs(['--variant', 'anything']), /variant/)
})

test('真实 runner 资格拒绝宿主、伪装环境、自托管、非 main、fork 和非手工入口', async t => {
  const { validateRunnerProof } = await load()
  assert.doesNotThrow(() => validateRunnerProof(proof()))
  for (const [name, patch] of Object.entries({ host: { platform: 'linux' }, selfHosted: { runnerEnvironment: 'self-hosted' }, pr: { event: 'pull_request' }, branch: { ref: 'refs/heads/wip' }, fork: { repository: 'other/clawpanel' }, otherWorkflow: { workflowRef: 'qingchencloud/clawpanel/.github/workflows/maintenance.yml@refs/heads/main' }, mismatch: { toolingSha: 'b'.repeat(40) }, notVM: { virtualMachine: false }, realUser: { actualProfile: 'C:\\Users\\keh5', registeredProfile: 'C:\\Users\\keh5' }, spoofedHome: { registeredProfile: 'C:\\Users\\someone' }, missingSid: { sid: '' }, missingImage: { imageVersion: '' } })) {
    await t.test(name, () => assert.throws(() => validateRunnerProof({ ...proof(), ...patch }), /资格/))
  }
})

test('隔离 env 白名单不继承凭据或双重大小写 PATH，所有用户目录私有化', async () => {
  const { isolationEnv } = await load()
  const home = path.join(root, '.tmp/qualification-env-only/home')
  const env = isolationEnv({ home, temp: path.join(root, '.tmp/qualification-env-only/temp'), parent: { PATH: 'C:\\Windows', Path: 'poison', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'secret', GITHUB_TOKEN: 'secret', SSH_AUTH_SOCK: 'secret', NODE_OPTIONS: '--require poison', PYTHONPATH: 'poison', NPM_CONFIG_PREFIX: 'poison' } })
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'HERMES_HOME', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'PLAYWRIGHT_BROWSERS_PATH']) assert.ok(path.relative(home, env[key]) === '' || !path.relative(home, env[key]).startsWith('..'), key)
  assert.equal(Object.keys(env).filter(k => k.toLowerCase() === 'path').length, 1)
  for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'PYTHONPATH']) assert.equal(env[key], undefined)
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.PYTHONNOUSERSITE, '1')
})

test('HKCU/HKLM PATH 类型、shell 和 global launcher 任一改变均失败，不自动恢复', async () => {
  const { assertHostUnchanged } = await load()
  const before = { registry: [{ hive: 'HKCU', name: 'Path', kind: 'ExpandString', sha256: 'a' }], shells: [{ path: 'profile.ps1', exists: false }], launchers: [{ path: 'hermes.exe', exists: false }], parentEnvSha256: 'x' }
  assert.doesNotThrow(() => assertHostUnchanged(before, structuredClone(before)))
  for (const patch of [{ registry: [{ ...before.registry[0], kind: 'String' }] }, { shells: [{ path: 'profile.ps1', exists: true }] }, { launchers: [{ path: 'hermes.exe', exists: true }] }, { parentEnvSha256: 'y' }]) assert.throws(() => assertHostUnchanged(before, { ...before, ...patch }), /宿主/)
})

test('private completion 要求真实 CLI/模块路径、commit、阶段成功，不接受 installed=true 自述', async () => {
  const { validatePrivateCompletion } = await load()
  const home = path.resolve(root, '.tmp/private-proof')
  const receipt = { version: '0.21.5', commit: sha, cli: path.join(home, 'bin/hermes.exe'), python: path.join(home, 'venv/python.exe'), modules: { 'hermes_cli.main': path.join(home, 'src/main.py'), fastapi: path.join(home, 'venv/fastapi.py'), uvicorn: path.join(home, 'venv/uvicorn.py') }, stages: ['repository', 'venv', 'python-deps', 'node-deps', 'config'].map(name => ({ name, exitCode: 0 })), requiredStages: ['repository', 'venv', 'python-deps', 'node-deps', 'config'] }
  const expected = { home, version: '0.21.5', commit: sha }
  assert.doesNotThrow(() => validatePrivateCompletion(receipt, expected))
  for (const bad of [{ installed: true }, { ...receipt, python: path.resolve(home, '../global/python.exe') }, { ...receipt, stages: receipt.stages.slice(1) }, { ...receipt, stages: receipt.stages.map(s => ({ ...s, exitCode: 1 })) }, { ...receipt, version: '0.22.2' }, { ...receipt, commit: 'b'.repeat(40) }]) assert.throws(() => validatePrivateCompletion(bad, expected), /completion/)
})

test('22.2 五 stage + PM products/preflight，dependency Python 不冒充 selected store', async () => {
  const { validatePrivateCompletion } = await load(), home = path.resolve(root, '.tmp/new-pm-proof'), managed = path.join(home, '.hermes')
  const dependencyPython = path.join(managed, 'installs/key/environments/env/Scripts/python.exe'), store = path.join(managed, 'tools/python/python.exe')
  const requiredStages = ['repository', 'venv', 'python-deps', 'config', 'complete']
  const receipt = { version: '0.22.2', commit: sha, reportedStatusPath: store, python: store, commandSpec: { program: dependencyPython, args: ['-I', '-B', '-c', 'original metadata'], role: 'pm-bootstrap-metadata' }, modules: { 'hermes_cli.main': path.join(managed, 'hermes-agent/hermes_cli/main.py'), fastapi: path.join(managed, 'installs/key/environments/env/fastapi.py'), uvicorn: path.join(managed, 'installs/key/environments/env/uvicorn.py') }, requiredStages, stages: requiredStages.map(name => ({ name, exitCode: 0 })), pm: { dependencyPython, selectedStorePython: store, completion: { commit: sha, current: true, same: true, completed: true, pending: false }, preflight: { commit: sha, current: true, same: true, completed: true, command: ['profile', 'list'] } } }
  const expected = { home, version: '0.22.2', commit: sha }
  assert.doesNotThrow(() => validatePrivateCompletion(receipt, expected))
  for (const bad of [{ ...receipt, pm: undefined }, { ...receipt, python: dependencyPython }, { ...receipt, requiredStages: ['repository', 'venv', 'python-deps', 'node-deps', 'config'] }, { ...receipt, pm: { ...receipt.pm, completion: { ...receipt.pm.completion, pending: true } } }, { ...receipt, pm: { ...receipt.pm, preflight: { ...receipt.pm.preflight, current: false } } }, { ...receipt, commandSpec: undefined }]) assert.throws(() => validatePrivateCompletion(bad, expected), /completion/)
})

test('单次生产 install/update/reinstall 保持900秒，Provider chat/title明确分开', async () => {
  const source = fs.readFileSync(script, 'utf8')
  assert.doesNotMatch(source, /1800000/)
  for (const cmd of ['install_hermes', 'update_hermes']) assert.match(source, new RegExp(`api\\('${cmd}'[^\\n]+900000`))
  const { classifyProviderRequest } = await load()
  assert.equal(classifyProviderRequest({ messages: [{ role: 'system', content: 'You are a title generator. You output ONLY a thread title. Nothing else.' }] }), 'title')
  assert.equal(classifyProviderRequest({ messages: [{ role: 'system', content: 'You are Hermes, an AI assistant.' }] }), 'chat')
  assert.equal(classifyProviderRequest({ messages: [{ role: 'system', content: 'unknown helper task' }] }), 'unattributed')
})

test('API/mock 不能冒充用户 UI，native missing 不能冒充完整资格', async () => {
  const { qualificationStatus } = await load()
  const stages = ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve'].map(name => ({ name, status: 'passed' }))
  const report = { stages, hostUnchanged: true, browser: { actualChromium: true, screenshots: ['a.png'], trace: 'trace.zip', pageErrors: [], completeReply: true, historyAfterReload: true }, nativeTauri: { status: 'not-run' } }
  assert.equal(qualificationStatus(report), 'passed-web-native-missing')
  assert.equal(qualificationStatus({ ...report, nativeTauri: { status: 'passed' } }), 'passed-web-native-missing', '外部自述不升级 native 证据')
  for (const bad of [{ ...report, hostUnchanged: false }, { ...report, stages: stages.slice(1) }, { ...report, browser: { ...report.browser, actualChromium: false } }, { ...report, browser: { ...report.browser, pageErrors: ['error'] } }, { ...report, browser: { ...report.browser, historyAfterReload: false } }]) assert.equal(qualificationStatus(bad), 'failed')
})

test('手工资格 workflow 不绕过 Daily main guard，不写权限/凭据，不运行候选工具', () => {
  const p = path.join(root, '.github/workflows/hermes-qualification.yml')
  const src = fs.readFileSync(p, 'utf8')
  const w = YAML.parse(src)
  assert.deepEqual(Object.keys(w.on), ['workflow_dispatch'])
  assert.deepEqual(w.permissions, { contents: 'read' })
  const job = w.jobs.qualify
  assert.equal(job['runs-on'], 'windows-2025')
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/)
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/)
  assert.match(job.if, /github\.repository == 'qingchencloud\/clawpanel'/)
  const checkouts = job.steps.filter(s => s.uses?.startsWith('actions/checkout@'))
  assert.equal(checkouts.length, 2)
  for (const step of checkouts) { assert.equal(step.with['persist-credentials'], false); assert.match(step.uses, /@[a-f0-9]{40}$/) }
  assert.equal(checkouts[0].with.path, 'tooling')
  assert.equal(checkouts[0].with.ref, '${{ github.sha }}')
  assert.equal(checkouts[1].with.path, 'candidate')
  assert.equal(checkouts[1].with.ref, '${{ matrix.sha }}')
  assert.doesNotMatch(src, /secrets\.|codex-action|pull_request_target|workflow_call|schedule:|GH_TOKEN|GITHUB_TOKEN|contents: write|id-token: write|git push|Set-ExecutionPolicy/i)
  assert.match(src, /tooling\/scripts\/test-hermes-windows-qualification\.mjs/)
  assert.doesNotMatch(src, /run:.*\$\{\{ inputs\./)
  const daily = fs.readFileSync(path.join(root, '.github/workflows/maintenance.yml'), 'utf8')
  assert.match(daily, /inputs\.runtime_selftest.*github\.repository == 'qingchencloud\/clawpanel'.*github\.ref == 'refs\/heads\/main'/)
  assert.match(daily, /--cap-drop=ALL --security-opt=no-new-privileges/)
})

test('真实宿主 execute 在任何 candidate/install 命令前失败，伪装容器变量也无效', async () => {
  assert.ok(fs.existsSync(script), '先有可信资格入口，红灯阶段不执行候选')
  const tempRoot = fs.realpathSync(os.tmpdir())
  const tmp = fs.mkdtempSync(path.join(tempRoot, 'hermes-qualification-negative-'))
  try {
    const output = path.join(tmp, 'evidence')
    const r = spawnSync(process.execPath, [script, '--execute', '--root', root, '--sha', sha, '--version', '0.22.2', '--variant', 'new', '--output', output], { env: { ...process.env, GITHUB_ACTIONS: 'false', MAINTENANCE_ISOLATED_RUNTIME: '1' }, encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'))
    assert.equal(report.status, 'failed')
    assert.match(report.error, /资格/)
    assert.deepEqual(report.commands, [])
    assert.equal(report.installerStarted, false)
  } finally {
    const rel = path.relative(tempRoot, fs.realpathSync(tmp))
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('Linux 长 UI job 使用原可信容器门禁，fresh11 后同容器同 HOME 两轮 hold210', () => {
  const src = fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8')
  const job = YAML.parse(src).jobs['linux-long-ui']
  assert.equal(job['runs-on'], 'ubuntu-latest')
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'.*github\.ref == 'refs\/heads\/main'/)
  const body = job.steps.map(s => s.run || '').join('\n')
  assert.match(body, /tooling\/\.github\/maintenance\/Runtime\.Dockerfile/)
  assert.match(body, /--user.*--cap-drop=ALL.*--security-opt=no-new-privileges/)
  assert.match(body, /dst=\/tooling,readonly/)
  assert.match(body, /MAINTENANCE_ISOLATED_RUNTIME=1/)
  assert.match(body, /maintenance-runtime-smoke\.mjs.*--output \/tmp\/runtime/)
  assert.match(body, /127\.0\.0\.1::1420/)
  assert.match(body, /--host 0\.0\.0\.0 --port 1420/)
  assert.match(body, /for round in 1 2/)
  assert.match(body, /hermes-qualification-browser\.py.*--base-url.*--output.*--hold 210/)
  assert.match(body, /docker logs/)
  assert.match(body, /docker cp/)
  assert.match(body, /--signal=TERM/)
  assert.doesNotMatch(body, /--privileged|docker\.sock|--network=host|--user root|chmod 777|sudo/)
  assert.doesNotMatch(src, /secrets\.|codex-action|workflow_call|pull_request_target/)
})

test('不同路径源码必须逐文件与 Web git blob SHA256 一致，丢失或改字节失败', async () => {
  const { assertSameSource } = await load(); assert.equal(typeof assertSameSource, 'function')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-source-contract-'))
  try {
    fs.writeFileSync(path.join(tmp, 'one.txt'), 'one\n')
    const { createHash } = await import('node:crypto'), files = { 'one.txt': createHash('sha256').update('one\n').digest('hex') }
    assert.doesNotThrow(() => assertSameSource(tmp, files))
    fs.writeFileSync(path.join(tmp, 'one.txt'), 'one\r\n'); assert.throws(() => assertSameSource(tmp, files), /源码/)
    fs.rmSync(path.join(tmp, 'one.txt')); assert.throws(() => assertSameSource(tmp, files), /源码/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('Windows file URL preload 实际子进程保留 PID、stdout 和非零退出，不吞失败', async () => {
  const { spawnAuditSource } = await load(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-observer-contract-'))
  try {
    const observer = path.join(tmp, 'observer.mjs'), log = path.join(tmp, 'audit.jsonl')
    fs.writeFileSync(observer, spawnAuditSource(log))
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(observer).href, '--input-type=module', '-e', `import {spawn} from 'node:child_process';const c=spawn(process.execPath,['-e','process.stdout.write("actual-child");process.exitCode=7']);c.stdout.pipe(process.stdout);c.on('close',code=>process.exitCode=code)`], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    assert.equal(r.status, 7, r.stderr); assert.equal(r.stdout, 'actual-child')
    const receipts = fs.readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x)); assert.equal(receipts.length, 2)
    assert.equal(receipts[0].event, 'start'); const receipt = receipts[1]; assert.equal(receipt.event, 'close'); assert.equal(receipts[0].pid, receipt.pid); assert.ok(receipt.pid > 0); assert.equal(receipt.exitCode, 7); assert.equal(receipt.stdout, 'actual-child')
    assert.match(fs.readFileSync(script, 'utf8'), /\['--import', pathToFileURL\(audit\)\.href/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('产物仅上传新公开副本，不带 HOME/env/caches，日志与 trace 随机 Gateway key 脱敏且原件保留', async () => {
  const { publishEvidence } = await load(); assert.equal(typeof publishEvidence, 'function')
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hermes-publication-contract-'))
  try {
    const raw = path.join(tmp, 'raw'), output = path.join(tmp, 'public'), key = 'random-gateway-contract-7e282ce1234'
    fs.mkdirSync(path.join(raw, 'h/.hermes'), { recursive: true }); fs.mkdirSync(path.join(raw, 'runtime/home'), { recursive: true })
    fs.writeFileSync(path.join(raw, 'h/.hermes/.env'), `API_SERVER_KEY=${key}\n`)
    fs.writeFileSync(path.join(raw, 'runtime/home/private'), key)
    fs.writeFileSync(path.join(raw, 'isolationenv.json'), JSON.stringify({ HOME: raw }))
    fs.writeFileSync(path.join(raw, 'report.json'), JSON.stringify({ status: 'failed', API_SERVER_KEY: key, nonce: 'fake-provider-nonce' }))
    fs.writeFileSync(path.join(raw, 'serve.log'), `Authorization: Bearer ${key}\n`)
    const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"w");z.writestr("trace.network",sys.argv[2]);z.close()', path.join(raw, 'trace.zip'), JSON.stringify({ key })], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(py.status, 0, py.stderr)
    await publishEvidence({ roots: { web: raw }, output })
    assert.ok(!fs.existsSync(path.join(output, 'web/h')) && !fs.existsSync(path.join(output, 'web/runtime/home')) && !fs.existsSync(path.join(output, 'web/isolationenv.json')))
    assert.ok(!fs.readFileSync(path.join(output, 'web/report.json'), 'utf8').includes(key))
    assert.ok(fs.readFileSync(path.join(output, 'web/report.json'), 'utf8').includes('fake-provider-nonce'))
    assert.ok(!fs.readFileSync(path.join(output, 'web/serve.log'), 'utf8').includes(key))
    const check = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read("trace.network").decode())', path.join(output, 'web/trace.zip')], { encoding: 'utf8', windowsHide: true }); assert.equal(check.status, 0, check.stderr); assert.ok(!check.stdout.includes(key))
    assert.ok(fs.readFileSync(path.join(raw, 'serve.log'), 'utf8').includes(key), '原始失败证据不覆盖')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('workflow 只上传脱敏 public 副本；导出供 native 严格复用而本轮不追加 native 步骤', async () => {
  const q = await load(); assert.equal(typeof q.actualRunnerProof, 'function'); assert.equal(typeof q.hostSnapshot, 'function')
  const w = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8'))
  for (const job of [w.jobs.qualify, w.jobs['linux-long-ui']]) {
    const publish = job.steps.findIndex(s => s.run?.includes('--publish-evidence'))
    const upload = job.steps.findIndex(s => s.uses?.startsWith('actions/upload-artifact@'))
    assert.ok(publish >= 0 && upload > publish)
    assert.equal(job.steps[publish].if, 'always()')
    assert.match(job.steps[upload].with.path, /hermes-public-/)
    assert.doesNotMatch(job.steps[upload].with.path, /hermes-qualification-/)
  }
})

test('testjob-envcontext: job env 禁用 runner.temp；step 写 GITHUB_ENV，artifact 路径仍合法', () => {
  const w = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8'))
  for (const job of Object.values(w.jobs)) assert.doesNotMatch(JSON.stringify(job.env || {}), /\$\{\{\s*runner\./, 'job-level env 没有 runner 上下文；GitHub dispatch 会返回422')
  const job = w.jobs['linux-long-ui']
  assert.equal(job.env.EVIDENCE, undefined); assert.equal(job.env.PLAYWRIGHT_BROWSERS_PATH, undefined)
  const init = job.steps.findIndex(s => s.id === 'runtime_paths')
  const use = job.steps.findIndex(s => s.run?.includes('test ! -e "$EVIDENCE"'))
  assert.ok(init >= 0 && init < use, '使用证据路径之前先通过 step 写入 GITHUB_ENV')
  const run = job.steps[init].run
  assert.match(run, /printf 'EVIDENCE=%s\/hermes-qualification-%s\\n' "\$RUNNER_TEMP" "\$VARIANT" >> "\$GITHUB_ENV"/)
  assert.match(run, /printf 'PLAYWRIGHT_BROWSERS_PATH=%s\/hermes-browser-cache\\n' "\$RUNNER_TEMP" >> "\$GITHUB_ENV"/)
  for (const j of [w.jobs.qualify, job]) assert.equal(j.steps.find(s => s.uses?.startsWith('actions/upload-artifact@')).with.path, '${{ runner.temp }}/hermes-public-${{ matrix.variant }}/')
})

test('publication fixture 先规范系统 tmp 物理路径，覆盖 mac /var 到 /private/var 别名', () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.match(source, /fs\.mkdtempSync\(path\.join\(fs\.realpathSync\(os\.tmpdir\(\)\), 'hermes-publication-contract-'\)\)/)
})

test('publication 保留真实 symlink/junction 拒绝：输入或输出祖先为链接均失败', async () => {
  const { publishEvidence } = await load(), base = fs.realpathSync(os.tmpdir())
  const tmp = fs.mkdtempSync(path.join(base, 'hermes-publication-symlink-')), actual = path.join(tmp, 'actual'), alias = path.join(tmp, 'alias')
  try {
    fs.mkdirSync(actual); fs.writeFileSync(path.join(actual, 'report.json'), '{"status":"failed"}')
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const output = path.join(tmp, 'public')
    await assert.rejects(publishEvidence({ roots: { web: alias }, output }), /reparse|symlink/)
    assert.equal(fs.existsSync(output), false)
    await assert.rejects(publishEvidence({ roots: { web: actual }, output: path.join(alias, 'public') }), /reparse|symlink/)
    assert.equal(fs.existsSync(path.join(actual, 'public')), false)
  } finally {
    if (fs.existsSync(alias)) fs.unlinkSync(alias)
    const relative = path.relative(base, fs.realpathSync(tmp)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('runner admission 失败前落盘实际 proof 与逐条件 reason，诊断不放宽 guard', async () => {
  const { runnerProofFailures } = await load(); assert.equal(typeof runnerProofFailures, 'function')
  assert.deepEqual(runnerProofFailures(proof()), [])
  const bad = { ...proof(), virtualMachine: false, registeredProfile: 'C:\\Users\\other', workflowSha: 'b'.repeat(40) }
  assert.deepEqual(runnerProofFailures(bad).sort(), ['profile-registration', 'virtual-machine', 'workflow-sha-match'])
  assert.ok(runnerProofFailures(bad).every(s => /^[a-z-]+$/.test(s)), '只记录静态原因名，不拼入实际环境或凭据')
  const src = fs.readFileSync(script, 'utf8'), begin = src.indexOf('proof = actualRunnerProof()'), validate = src.indexOf('validateRunnerProof(proof)', begin)
  assert.ok(begin >= 0 && validate > begin)
  for (const name of ['runner-proof.json', 'runner-admission.json']) { const write = src.indexOf(`write('${name}'`, begin); assert.ok(write > begin && write < validate, `${name} 必须早于 validate`) }
})

test('Linux Python Chromium 固定实际发布的 playwright1.58.0，不混用 npm1.58.2', () => {
  const w = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/hermes-qualification.yml'), 'utf8'))
  const body = w.jobs['linux-long-ui'].steps.map(s => s.run || '').join('\n')
  assert.match(body, /pip" install 'playwright==1\.58\.0'/)
  assert.doesNotMatch(body, /playwright==1\.58\.2/)
  assert.match(fs.readFileSync(script, 'utf8'), /playwright@1\.58\.2/, '保留已发布的 Windows npm 版本，不误改')
})
