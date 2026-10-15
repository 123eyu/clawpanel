import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dshHasUpdate } from '../deepseek-harness.js'

export const project = path.resolve(import.meta.dirname, '../..')
export const policy = JSON.parse(fs.readFileSync(path.join(project, '.github/maintenance/policy.json'), 'utf8'))
if (policy.autoRelease !== false) throw new Error('第一阶段必须保持 autoRelease=false')

export const redact = value => String(value ?? '')
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
  .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
  .replace(/\bBearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
  .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password|authorization|cookie)\s*["']?\s*[:=]\s*["']?)([^\s,"'<>}]+)/gi, '$1[REDACTED]')
  .replaceAll('@', '＠').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b)
    return left === right ? 0 : left < right ? -1 : 1
  })
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export const candidateId = report => /^[a-f0-9]{64}$/.test(report.candidateKey || '') ? report.candidateKey : report.fingerprint
export const trackerTitle = '[Maintenance] 每日维护待确认'
export function botLogin() {
  const login = process.env.MAINTENANCE_BOT_LOGIN || 'github-actions[bot]'
  if (!/^[a-z0-9[\]-]+$/i.test(login)) throw new Error('通知机器人身份无效')
  return login
}
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
export function git(root, args, extraEnv = {}) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', ...args], { cwd: root, env: { ...process.env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 12 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(redact(result.error?.message || result.stderr || 'Git 操作失败'))
  return result.stdout.trimEnd()
}
export function version(value) {
  const text = String(value ?? '')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z.-]+)?$/.test(text)) throw new Error('无效精确版本')
  return text
}
export const newer = (current, target) => dshHasUpdate(version(current), version(target))
export const prerelease = value => version(value).split('+')[0].includes('-')
export function baseline(root, spec) {
  const content = fs.readFileSync(path.join(root, spec.path), 'utf8')
  const value = spec.keys ? spec.keys.reduce((obj, key) => obj?.[key], JSON.parse(content)) : new RegExp(spec.pattern).exec(content)?.[1]
  if (typeof value !== 'string' || !value) throw new Error(`版本基线读取失败: ${spec.path}`)
  return value
}
export function baseUrl(value, fallback, fixture) {
  const url = new URL(value || fallback)
  if (url.username || url.password || url.search || url.hash) throw new Error('数据源地址包含不受支持的部分')
  if (fixture) {
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('fixture 仅允许本机回环 HTTP')
  } else if (url.href !== fallback) throw new Error('真实巡检只访问固定官方数据源')
  return url.href.replace(/\/$/, '')
}
export function safeFile(root, name) {
  if (!name || name.includes('\\') || name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '))) throw new Error('不安全的补丁路径')
  let current = path.resolve(root)
  for (const part of name.split('/')) {
    current = path.join(current, part)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('补丁路径涉及符号链接')
  }
  return current
}
export function assertReport(report) {
  if (report.schemaVersion !== 1 || report.repository !== policy.repository || report.autoRelease !== false || !/^[a-f0-9]{40}$/.test(report.baseSha) || !/^[a-f0-9]{64}$/.test(report.fingerprint)) throw new Error('维护报告格式不正确')
}
