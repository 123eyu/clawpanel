/** 完整反馈材料：先全文脱敏再分片，原文只用于风险扫描/摘要外的完整性指纹。 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { policy, redact } from './core.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const hex = /^[a-f0-9]{64}$/
const partName = /^feedback\/[a-f0-9]{64}-\d{4}\.txt$/
export const feedbackEntries = report => [
  ...(report.intake?.issues || []), ...(report.intake?.pullRequests || []), ...(report.intake?.backlogIssues || []),
  ...(report.intake?.releasePeriod?.issues || []), ...(report.intake?.releasePeriod?.pullRequests || []),
].flatMap(item => [item, ...(item.comments || []), ...(item.reviews || [])])

// 保留正文语义，额外屏蔽常见日志/URL秘密；分片边界不会把凭据拆开后再脱敏。
export const redactFeedback = value => redact(value)
  .replace(/([?&](?:key|api[_-]?key|token|access[_-]?token|secret|password|auth|signature)=)[^\s&#)]+/gi, '$1[REDACTED]')
  .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]')
  .replace(/\b(?:xox[baprs]-[\w-]+|AIza[\w-]{30,})\b/g, '[REDACTED]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')

function limits() {
  const result = Object.fromEntries(['InlineBytes', 'ChunkBytes', 'ItemBytes', 'TotalBytes', 'Chunks'].map(key => [key, policy.limits['feedback' + key]]))
  if (Object.values(result).some(value => !Number.isSafeInteger(value) || value <= 0) || result.InlineBytes > result.ChunkBytes || result.ChunkBytes > result.ItemBytes || result.ItemBytes > result.TotalBytes || result.Chunks > 9999) throw new Error('反馈预算配置无效')
  return result
}

// 不接受输入提供的路径。对真实文件系统逐级检查，包括输出目录的祖先链接。
function checkedPath(root, relative = '') {
  if (relative && !partName.test(relative)) throw new Error('反馈材料引用路径无效')
  const target = relative ? path.join(path.resolve(root), relative) : path.resolve(root)
  let current = path.parse(target).root
  for (const segment of target.slice(current.length).split(path.sep)) {
    current = path.join(current, segment)
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('反馈材料路径涉及符号链接') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return target
}

// UTF8切片按码点而不是UTF16下标，避免中文/emoji在材料中被替换成乱码。
function chunksOf(value, maximum) {
  const chunks = []
  let text = '', bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maximum) { chunks.push(text); text = ''; bytes = 0 }
    text += character
    bytes += size
  }
  if (text) chunks.push(text)
  return chunks
}

export class FeedbackStore {
  constructor(output) {
    this.output = checkedPath(output)
    this.budget = limits()
    this.rawBytes = 0
    this.redactedBytes = 0
    this.parts = 0
    this.cache = new Map()
  }
  capture(value) {
    const original = String(value ?? ''), sourceSha256 = hash(original)
    const clean = redactFeedback(original), sourceBytes = Buffer.byteLength(original), bytes = Buffer.byteLength(clean)
    if (Math.max(sourceBytes, bytes) > this.budget.ItemBytes) throw new Error('单条反馈字节超过硬预算')
    if (this.rawBytes + sourceBytes > this.budget.TotalBytes || this.redactedBytes + bytes > this.budget.TotalBytes) throw new Error('反馈总字节超过硬预算')
    const sha256 = hash(clean), pieces = bytes > this.budget.InlineBytes ? chunksOf(clean, this.budget.ChunkBytes) : []
    if (this.parts + pieces.length > this.budget.Chunks) throw new Error('反馈材料片数超过硬预算')
    // 相同正文可复用磁盘材料，但每次采集的字节/片引用仍计预算，防重复内容绕过总量门禁。
    this.rawBytes += sourceBytes
    this.redactedBytes += bytes
    this.parts += pieces.length
    if (this.cache.has(sourceSha256)) return structuredClone(this.cache.get(sourceSha256))
    const result = { body: pieces.length ? [...clean].slice(0, 1800).join('') + '\n[完整脱敏内容见 bodyMaterial]' : clean,
      bodyTruncated: false, bodyIsSummary: !!pieces.length, bodySha256: sha256, bodySourceSha256: sourceSha256, bodySourceBytes: sourceBytes }
    if (pieces.length) {
      const directory = checkedPath(this.output, `feedback/${sha256}-0000.txt`)
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 })
      const parts = pieces.map((piece, index) => {
        const relative = `feedback/${sha256}-${String(index).padStart(4, '0')}.txt`, file = checkedPath(this.output, relative)
        // 相同内容可跨对象复用；已有材料只读比对，绝不覆盖或跟随已有链接。
        try { fs.writeFileSync(file, piece, { encoding: 'utf8', flag: 'wx', mode: 0o600 }) }
        catch (error) {
          if (error.code !== 'EEXIST') throw error
          const existing = fs.lstatSync(file)
          if (!existing.isFile() || existing.isSymbolicLink() || fs.readFileSync(file, 'utf8') !== piece) throw new Error('已有反馈材料不匹配，拒绝覆盖')
        }
        return { path: relative, bytes: Buffer.byteLength(piece), sha256: hash(piece) }
      })
      result.bodyMaterial = { encoding: 'utf8', sha256, bytes, parts }
    }
    this.cache.set(sourceSha256, result)
    return structuredClone(result)
  }
  manifest() { return { schemaVersion: 1, sourceBytes: this.rawBytes, redactedBytes: this.redactedBytes, parts: this.parts, uniqueBodies: this.cache.size } }
}

/** 可信消费入口：在使用摘要前回读全部片段，缺片/篡改/任意路径均失败关闭。 */
export function validateFeedbackMaterials(report, output) {
  const budget = limits(), unique = new Map()
  if (report.feedback?.schemaVersion !== 1) throw new Error('缺少反馈完整性清单')
  if (!output) throw new Error('完整反馈材料需要可信输出目录')
  checkedPath(output)
  let sourceBytes = 0, redactedBytes = 0, count = 0
  for (const entry of feedbackEntries(report)) {
    if (!hex.test(entry.bodySha256 || '') || !hex.test(entry.bodySourceSha256 || '') || !Number.isSafeInteger(entry.bodySourceBytes) || entry.bodySourceBytes < 0 || entry.bodySourceBytes > budget.ItemBytes || entry.bodyTruncated !== false) throw new Error('反馈全文完整性元数据无效')
    const material = entry.bodyMaterial
    let value = Buffer.from(entry.body || '')
    if (material) {
      if (!entry.bodyIsSummary || material.encoding !== 'utf8' || material.sha256 !== entry.bodySha256 || !Number.isSafeInteger(material.bytes) || material.bytes <= budget.InlineBytes || material.bytes > budget.ItemBytes || !Array.isArray(material.parts) || !material.parts.length || material.parts.length > budget.Chunks) throw new Error('反馈材料清单无效')
      let size = 0
      const chunks = material.parts.map((part, index) => {
        if (part.path !== `feedback/${material.sha256}-${String(index).padStart(4, '0')}.txt` || !hex.test(part.sha256 || '') || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > budget.ChunkBytes) throw new Error('反馈材料引用或分片预算无效')
        const file = checkedPath(output, part.path)
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
        try {
          const stat = fs.fstatSync(fd)
          if (!stat.isFile() || stat.size !== part.bytes) throw new Error('反馈材料分片字节不符')
          const content = fs.readFileSync(fd)
          if (hash(content) !== part.sha256 || !Buffer.from(content.toString('utf8')).equals(content)) throw new Error('反馈材料分片 hash 或 UTF8 不符')
          size += content.length
          return content
        } finally { fs.closeSync(fd) }
      })
      if (size !== material.bytes) throw new Error('反馈材料缺片或总字节不符')
      value = Buffer.concat(chunks)
    } else if (entry.bodyIsSummary || value.length > budget.InlineBytes) throw new Error('反馈摘要缺少完整材料')
    if (hash(value) !== entry.bodySha256) throw new Error('反馈全文 hash 不符')
    const key = entry.bodySourceSha256
    const signature = JSON.stringify({ hash: entry.bodySha256, bytes: entry.bodySourceBytes, material })
    if (unique.has(key) && unique.get(key) !== signature) throw new Error('同源反馈材料清单不一致')
    unique.set(key, signature)
    sourceBytes += entry.bodySourceBytes
    redactedBytes += value.length
    count += material?.parts.length || 0
    if (sourceBytes > budget.TotalBytes || redactedBytes > budget.TotalBytes || count > budget.Chunks) throw new Error('反馈材料总字节或片数超过硬预算')
  }
  if (report.feedback.sourceBytes !== sourceBytes || report.feedback.redactedBytes !== redactedBytes || report.feedback.parts !== count || report.feedback.uniqueBodies !== unique.size) throw new Error('反馈清单缺失材料或统计不符')
  return { complete: true, sourceBytes, redactedBytes, parts: count, uniqueBodies: unique.size }
}
