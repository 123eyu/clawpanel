import { createHash } from 'node:crypto'
import path from 'node:path'
import { newer, version } from './core.mjs'

// 只做保守风险分级；高风险不能因版本号、模型自述或旧验收而自动放行。
export const sensitiveReleaseChange = /\bbreaking\b|CVE-\d|security|vulnerabilit|incompatible|schema migration|authenticat|authoriz|credential|\b(?:auth(?:n|z)?|injection|RCE|SSRF|sandbox|PTY|permissions?)\b|\b(?:remote\s+code|shell|command)\s+execution\b|(?:connection|request) origins?|\btickets?\b|process.{0,60}(?:spawn|validat|reject)|凭据|鉴权|权限|安全|破坏性|不兼容|配置迁移/i
const maxReleases = 32, maxDocuments = 16, maxBytes = 1024 * 1024
const hash = text => createHash('sha256').update(text).digest('hex')
const referenceKey = value => value.trim().replace(/\s+/g, ' ').toLowerCase()
// 保留位置与换行，注释内的标题、链接和引用定义均不作为可见材料。
const visible = text => text.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => comment.replace(/[^\r\n]/g, ' '))
function links(text, context = text) {
  text = visible(text)
  context = visible(context)
  const result = [], definitions = new Map()
  for (const m of context.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^<>\n]+)>|([^\s]+))/gm)) definitions.set(referenceKey(m[1]), m[2] || m[3])
  for (const m of text.matchAll(/\[([^\]\n]+)\]\((?:<([^<>\n]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) result.push({ label: m[1], url: m[2] || m[3] })
  for (const m of text.matchAll(/\[([^\]\n]+)\](?:\[([^\]\n]*)\])?(?!\()/g)) {
    if (/^:[ \t]/.test(text.slice(m.index + m[0].length))) continue
    const url = definitions.get(referenceKey(m[2] || m[1]))
    if (url) result.push({ label: m[1], url })
  }
  // 裸链及自动链接也属于材料入口；仍只转换路径，不请求输入中的URL。
  for (const m of text.matchAll(/https?:\/\/[^\s<>()[\]"'`]+/gi)) result.push({ label: text.slice(text.lastIndexOf('\n', m.index) + 1, m.index), url: m[0].replace(/[.,;!]+$/, '') })
  return result
}
const noteReference = /changelog|(?:full|complete).{0,20}(?:release|notes|changes)|完整(?:发布|变更)说明/i
const noteLinks = (text, context = text) => links(text, context).filter(l => noteReference.test(l.label + ' ' + l.url))
const unresolvedReference = (text, context = text) => /full release notes|full changelog|complete changelog|完整(?:发布|变更)说明/i.test(text) && !noteLinks(text, context).length
// 版本标题、注释、引用定义及链接文字都不能单独证明存在发布正文。
const prose = text => visible(text)
  .replace(/^ {0,3}#{1,6}[ \t]+[^\n]*(?:\n|$)/gm, '')
  .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*/gm, '')
  .replace(/\[[^\]\n]+\]\([^\n)]*\)|\[[^\]\n]+\](?:\[[^\]\n]*\])?/g, '')
  .replace(/https?:\/\/[^\s<>()[\]"'`]+/gi, '').replace(/<[^>]*>/g, '')
  .replace(/[\s>*_`~#|:;.,!\-]/g, '')
const headings = text => [...visible(text).matchAll(/^#{1,3}[ \t]+\[?v?(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?)(?=[\]\s(]|$)/gmi)]
const parseVersion = tag => { try { return version(tag) } catch { return null } }

/** 分页终点证明发现集合完整；链接只转成同一官方仓库、目标tag的 Contents API。 */
export async function reviewReleaseRange(api, source, currentTag, targetTag, history) {
  const releases = history.items
  const problems = [...history.reasons], documents = [], notes = [], cached = new Map(), active = new Set()
  let bytes = 0, requests = 0
  if (history.complete !== true && !problems.length) problems.push('Release 分页范围不完整')
  const current = parseVersion(currentTag.slice(source.tagPrefix.length)), target = parseVersion(targetTag.slice(source.tagPrefix.length))
  const between = value => current && target && newer(current, value) && !newer(target, value)
  const candidates = releases.filter(r => !r.draft && !r.prerelease && r.tag_name?.startsWith(source.tagPrefix))
  if (!current || !target || !newer(current, target)) problems.push('基线与目标tag不是同一递增版本序列，需人工核实发布范围')
  if (!current || !target || !candidates.some(r => r.tag_name === currentTag) || !candidates.some(r => r.tag_name === targetTag)) problems.push('近期窗口缺少精确基线或目标，跨版本发布说明范围不完整')
  const range = candidates.filter(r => { const v = parseVersion(r.tag_name.slice(source.tagPrefix.length)); return v && between(v) }).sort((a, b) => {
    if (a.tag_name === b.tag_name) return 0
    const av = a.tag_name.slice(source.tagPrefix.length), bv = b.tag_name.slice(source.tagPrefix.length)
    if (newer(av, bv)) return -1
    if (newer(bv, av)) return 1
    // SemVer构建元数据不参与先后比较，使用精确tag作确定性兜底。
    return a.tag_name < b.tag_name ? -1 : 1
  })
  if (!range.length) { problems.push('跨版本发布说明区间为空，未作为完整审查'); notes.push(String(releases.find(r => r.tag_name === targetTag)?.body || '')) }
  if (range.length > maxReleases) problems.push('跨版本发布说明超过审查版本预算')
  const versions = new Set(range.map(r => r.tag_name.slice(source.tagPrefix.length)))
  function officialPath(input, parent = '') {
    let filename
    if (/^https?:/i.test(input)) {
      const u = new URL(input)
      if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search) throw new Error('变更说明链接不是可核验的官方静态文件')
      const segments = decodeURIComponent(u.pathname).split('/').filter(Boolean), repo = source.repository.split('/')
      if (segments[0]?.toLowerCase() !== repo[0].toLowerCase() || segments[1]?.toLowerCase() !== repo[1].toLowerCase()) throw new Error('变更说明链接指向其他仓库')
      let rest = segments.slice(2)
      if (u.hostname === 'github.com' && ['blob', 'raw'].includes(rest[0])) rest = rest.slice(1)
      else if (u.hostname !== 'raw.githubusercontent.com') throw new Error('变更说明链接指向外域')
      if (rest[0] === 'refs' && ['heads', 'tags'].includes(rest[1])) rest = rest.slice(2)
      filename = rest.slice(1).join('/') // 丢弃链接中的浮动ref，统一使用本次精确目标tag。
    } else {
      if (/^[a-z][a-z0-9+.-]*:|^\/|[?#]/i.test(input)) throw new Error('变更说明相对链接无效')
      filename = parent ? path.posix.join(path.posix.dirname(parent), input) : input
    }
    if (!/^[a-z0-9._/-]+\.(?:md|markdown)$/i.test(filename) || filename.length > 240 || input.split(/[\\/]/).includes('..') || filename.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('变更说明文件路径越界或类型不支持')
    return filename
  }
  async function readDocument(filename) {
    // 在请求前扣预算；拒绝结果也缓存，避免404或坏hash反复消耗请求。
    if (!cached.has(filename)) cached.set(filename, (async () => {
      if (requests >= maxDocuments) throw new Error('完整变更说明超过文件请求数预算')
      requests++
      const data = await api.get(`/repos/${source.repository}/contents/${filename.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(targetTag)}`)
      if (data?.type !== 'file' || data.target || data.submodule_git_url || data.path !== filename || data.encoding !== 'base64' || !Number.isSafeInteger(data.size) || data.size <= 0 || data.size > maxBytes - bytes || !/^[a-f0-9]{40}$/.test(data.sha || '')) throw new Error('完整变更说明元数据、类型或字节预算不合格')
      const encoded = String(data.content || '').replace(/\s/g, '')
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('完整变更说明base64无效')
      const buffer = Buffer.from(encoded, 'base64')
      const gitSha = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer])).digest('hex')
      if (buffer.length !== data.size || gitSha !== data.sha) throw new Error('完整变更说明字节数或Git blob hash不符')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      if (text.includes('\0')) throw new Error('完整变更说明含无效文本')
      bytes += buffer.length
      documents.push({ path: filename, ref: targetTag, gitSha, sha256: hash(buffer), bytes: buffer.length, url: `https://github.com/${source.repository}/blob/${encodeURIComponent(targetTag)}/${filename}` })
      return text
    })())
    return cached.get(filename)
  }
  const reviewed = new Map()
  const requireCoverage = (covered, required) => {
    for (const v of required) if (!covered.has(v)) throw new Error(`完整变更说明未覆盖精确版本 ${v}`)
    return covered
  }
  async function inspectSection(text, v, filename, context) {
    // 不把版本标题自身的compare链接当分片；节内版本label链接必须按该节绑定。
    const body = text.replace(/^#{1,3}[ \t]+[^\n]*(?:\n|$)/, '')
    const all = links(body, context), hasBody = !!prose(text)
    const references = all.filter(link => noteReference.test(link.label + ' ' + link.url) || versions.has(link.label.replace(/^v/, '')) || !hasBody)
    if (unresolvedReference(body, context)) throw new Error(`${v}: 完整说明引用未解析`)
    if (!hasBody && !references.length) throw new Error(`${v}: 完整发布正文为空或仅含标题/注释`)
    for (const link of references) {
      try { await inspectDocument(officialPath(link.url, filename), new Set([v])) }
      catch (error) { throw new Error(`${v}: 分片未完整覆盖：${error.message}`) }
    }
    notes.push(text)
    return v
  }
  async function inspectDocument(filename, required = null) {
    if (active.has(filename)) throw new Error('完整变更说明循环引用')
    if (reviewed.has(filename)) {
      const previous = reviewed.get(filename)
      if (previous.error) throw previous.error
      return requireCoverage(previous.covered, required || previous.covered)
    }
    active.add(filename)
    try {
      const text = await readDocument(filename)
      const headers = headings(text), covered = new Set()
      const index = links(text).filter(link => versions.has(link.label.replace(/^v/, '')))
      if (/split-changelog/i.test(text) || (index.length && !headers.length)) {
        for (const v of required || versions) {
          const entries = [...new Map(index.filter(l => l.label.replace(/^v/, '') === v).map(l => [l.url, l])).values()]
          if (entries.length !== 1) throw new Error(`分片变更说明缺少或重复 ${v}`)
          const actual = await inspectDocument(officialPath(entries[0].url, filename), new Set([v]))
          for (const value of actual) covered.add(value)
        }
      } else {
        const fileVersion = path.posix.basename(filename).replace(/\.(?:md|markdown)$/i, '').replace(/^v/, '')
        const standalone = versions.has(fileVersion)
        if (!required && !standalone && (!headers.some(h => h[1] === current) || !headers.some(h => h[1] === target) || [...versions].some(v => !headers.some(h => h[1] === v)))) throw new Error('完整变更说明缺少精确升级区间边界')
        if (!headers.length && standalone) covered.add(await inspectSection(text, fileVersion, filename, text))
        for (let i = 0; i < headers.length; i++) if (versions.has(headers[i][1])) {
          const section = text.slice(headers[i].index, headers[i + 1]?.index ?? text.length)
          // 带标题的分片目录也需读取实际内容，不能以标题或链接充当版本覆盖。
          covered.add(await inspectSection(section, headers[i][1], filename, text))
        }
        requireCoverage(covered, required || (standalone ? [fileVersion] : versions))
      }
      reviewed.set(filename, { covered })
      return requireCoverage(covered, required || covered)
    } catch (error) {
      reviewed.set(filename, { error })
      throw error
    } finally { active.delete(filename) }
  }
  for (const release of range.slice(0, maxReleases)) {
    const body = String(release.body || '')
    const references = noteLinks(body)
    if (!prose(body) && !references.length) problems.push(`${release.tag_name}: 发布说明缺少可见正文或完整材料引用`)
    notes.push(`# ${release.tag_name}\n${body}`)
    if (unresolvedReference(body)) problems.push(`${release.tag_name}: 完整说明引用未解析`)
    for (const link of references) {
      // compare是另一个待审查入口，不把未读取的diff链接当完整说明。
      if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/compare\//.test(link.url)) { problems.push(`${release.tag_name}: 完整变更引用源码compare，尚未核验全文`); continue }
      try {
        const covered = await inspectDocument(officialPath(link.url))
        requireCoverage(covered, [release.tag_name.slice(source.tagPrefix.length)])
      }
      catch (error) { problems.push(`${release.tag_name}: ${error.message}`) }
    }
  }
  const raw = notes.join('\n\n')
  return { raw, sha256: hash(raw), complete: problems.length === 0, reasons: [...new Set(problems)], fromTag: currentTag, toTag: targetTag, tags: range.map(r => r.tag_name), documents, bytes, requests, historyComplete: history.complete, releasePages: history.pages, sensitive: sensitiveReleaseChange.test(raw) }
}
