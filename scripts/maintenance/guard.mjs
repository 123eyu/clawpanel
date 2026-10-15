import fs from 'node:fs'
import { assertReport, git, policy, readJson, safeFile } from './core.mjs'

export function guard(root, report, patchFile, resultFile) {
  assertReport(report)
  const result = readJson(resultFile)
  if (result.status === 'no_change' && !fs.readFileSync(patchFile, 'utf8').trim()) return { ok: true, skipped: true, autoRelease: false }
  if (!report.complete || report.errors?.length || !report.selected || report.selected.risk === 'high') throw new Error('报告未完整或候选需要人工确认')
  const source = policy.sources.find(item => item.id === report.selected.id)
  if (!source || !source.allowedPaths.length || report.selected.engine !== source.engine) throw new Error('候选不在受管范围')
  if (git(root, ['rev-parse', 'HEAD']) !== report.baseSha) throw new Error('候选基线 SHA 已变化')
  if (git(root, ['status', '--porcelain'])) throw new Error('候选 checkout 存在已有改动')
  if (result.status !== 'candidate' || !['low', 'medium'].includes(result.risk) || typeof result.summary !== 'string' || !result.summary.trim() || !Array.isArray(result.tests)) throw new Error('适配结果需要确认或格式错误')
  if (fs.statSync(patchFile).size > policy.limits.patchBytes) throw new Error('候选补丁超过大小上限')
  const patch = fs.readFileSync(patchFile, 'utf8')
  if (!patch.trim() || /GIT binary patch|Binary files |(?:new|old|deleted file|new file) mode (?!100644)\d+|^index .+ (?:120000|160000)/m.test(patch)) throw new Error('补丁为空或包含二进制/符号链接/子模块/模式变化')
  const stats = git(root, ['apply', '--numstat', '-z', patchFile]).split('\0').filter(Boolean)
  if (!stats.length || stats.length > policy.limits.patchFiles) throw new Error('补丁文件数量越界')
  const files = [], blocked = /^(?:\.github\/|scripts\/maintenance|scripts\/test-maintenance|tests\/maintenance|docs\/maintenance|package(?:-lock)?\.json$|src-tauri\/(?:Cargo|tauri\.conf)|.*(?:^|\/)(?:AGENTS\.md|SKILL\.md)$)/i
  let changed = 0
  for (const stat of stats) {
    const match = /^(\d+)\t(\d+)\t([^\t\r\n]+)$/.exec(stat)
    if (!match) throw new Error('补丁文件统计无效')
    const [, additions, deletions, name] = match
    safeFile(root, name)
    if (blocked.test(name)) throw new Error(`补丁修改受保护文件: ${name}`)
    const extra = /^(?:tests\/[a-z0-9-]+\.test\.js|src\/locales\/(?:[a-z-]+\.json|modules\/[a-z-]+\.js)|docs\/[a-z0-9/-]+\.md)$/i.test(name)
    const allowed = source.allowedPaths.some(allowed => allowed.endsWith('/') ? name.startsWith(allowed) : name === allowed)
    if (!allowed && !extra) throw new Error(`补丁超出候选范围: ${name}`)
    changed += Number(additions) + Number(deletions)
    files.push(name)
  }
  if (changed > policy.limits.patchLines) throw new Error('补丁行数超过预算')
  const sensitive = /auth|password|credential|approval|signature|ignoreRisk|api[_-]?key|chmod|chown|\beval\s*\(|\bexec\s*\(|\bspawn\s*\(|\bfetch\s*\(/i
  let current = ''
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) current = line.slice(6)
    if (/^[+-](?![+-])/.test(line) && !current.startsWith('tests/') && !current.startsWith('docs/') && sensitive.test(line)) throw new Error('补丁涉及认证/权限/执行/网络边界，需要人工确认')
  }
  git(root, ['apply', '--check', patchFile])
  return { ok: true, baseSha: report.baseSha, fingerprint: report.fingerprint, engine: source.engine, files, changedLines: changed, autoRelease: false }
}
