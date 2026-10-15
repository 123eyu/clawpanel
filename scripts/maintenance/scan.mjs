import fs from 'node:fs'
import path from 'node:path'
import { baseline, digest, git, newer, policy, prerelease, readJson, redact, version, writeJson } from './core.mjs'
import { renderReport, renderPrompt } from './report.mjs'
import { selectCandidate } from './selection.mjs'
import { FeedbackStore, redactFeedback, validateFeedbackMaterials } from './feedback.mjs'
import { reviewReleaseRange, sensitiveReleaseChange } from './release-review.mjs'

const own = item => item.user?.type === 'Bot' && /<!-- clawpanel-maintenance(?:-candidate)?:/.test(item.body || '')
const date = text => {
  if (!text || !Number.isFinite(Date.parse(text))) throw new Error('缺失或无效时间戳')
  return new Date(text).toISOString()
}
const text = (value, max = 10000) => redactFeedback(value).slice(0, max)
const riskOf = value => sensitiveReleaseChange.test(value) ? 'high' : 'medium'
const bodyInfo = (item, feedback) => ({ ...feedback.capture(item.body), risk: riskOf(item.body || '') })
const normalize = (item, feedback) => ({
  number: item.number, title: text(item.title, 500), ...feedback.capture(item.body), state: item.state,
  updatedAt: date(item.updated_at), createdAt: date(item.created_at || item.updated_at), url: text(item.html_url, 2000),
  labels: (item.labels || []).map(label => text(label.name, 100)),
  risk: riskOf(item.title + '\n' + (item.body || '')),
})
// 评论与评审同样属于风险证据，不因主条目标题平常而丢失安全补充。
const withDiscussion = (item, details, feedback) => {
  const entry = { ...normalize(item, feedback), ...details }
  if ([...(details.comments || []), ...(details.reviews || [])].some(value => value.risk === 'high')) entry.risk = 'high'
  return entry
}
const feedbackItems = intake => [...intake.issues, ...intake.pullRequests, ...intake.backlogIssues, ...(intake.releasePeriod?.issues || []), ...(intake.releasePeriod?.pullRequests || [])]

async function inspectSource(api, root, source) {
  const current = version(baseline(root, source.baseline))
  for (const mirror of source.mirrors) {
    if (baseline(root, mirror) !== current) throw new Error(`${source.id}: JS/Rust/发行镜像版本基线不一致`)
  }
  const releases = source.repository ? (await api.releases(source.repository)).filter(item => !item.draft) : []
  let target, meta = {}, release, unresolvedCalendarTag = false
  if (source.package) {
    const tags = await api.npm(source.package)
    target = version(tags[source.channel])
    meta = await api.npm(source.package, target)
    if (!meta || meta.version !== target) throw new Error(`${source.id}: npm 精确版本元数据缺失`)
    release = releases.find(item => item.tag_name === source.tagPrefix + target)
  } else {
    release = releases.filter(item => !item.prerelease && item.tag_name?.startsWith(source.tagPrefix)).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0]
    const currentTag = source.tagBaseline ? baseline(root, source.tagBaseline) : source.tagPrefix + current
    const tagVersion = version(release?.tag_name?.slice(source.tagPrefix.length))
    unresolvedCalendarTag = release?.tag_name !== currentTag && Number(tagVersion.split('.')[0]) >= 2000 && Number(current.split('.')[0]) < 2000
    target = release?.tag_name === currentTag || unresolvedCalendarTag ? current : tagVersion
  }
  const record = { id: source.id, engine: source.engine, current, target, channel: source.channel, source: source.package ? `https://registry.npmjs.org/${encodeURIComponent(source.package)}/${target}` : release?.html_url, release: release?.html_url || null, releaseNotes: text(release?.body), releaseNotesTruncated: String(release?.body || '').length > 10000, currentNode: null, targetNode: meta.engines?.node || null, integrity: meta.dist?.integrity || null }
  const reasons = []
  if (unresolvedCalendarTag) return { ...record, targetTag: release.tag_name, status: 'review', risk: 'high', reasons: ['源码日历 tag 已变化，软件版本尚需核实，不将日历 tag 当软件 SemVer 比较'] }
  if (target !== current && !newer(current, target)) return { ...record, status: 'ahead', risk: 'high', reasons: ['上游通道指向较旧版本，保留当前版本，不自动降级'] }
  if (target === current) return { ...record, status: 'current', risk: 'none', reasons }
  if (source.preview) reasons.push('预览通道需要人工确认，不晋升默认推荐')
  const sameRc = source.existingPrerelease && /^\d+\.\d+\.\d+-rc\.\d+$/.test(target) && current.split('-')[0] === target.split('-')[0]
  const upstreamVersion = source.id === 'openclaw-zh' ? target.replace(/-zh\.\d+$/, '') : target
  if ((prerelease(upstreamVersion) || release?.prerelease) && !sameRc) reasons.push('候选为未经默认推荐的预发布版本')
  if (source.package) {
    const currentMeta = await api.npm(source.package, current)
    record.currentNode = currentMeta?.engines?.node || null
    if (!currentMeta) reasons.push('当前版本的 npm 元数据缺失')
    if (record.currentNode !== record.targetNode) reasons.push('运行时 Node.js 要求发生变化')
    if (!record.integrity) reasons.push('候选 npm 包缺少完整性元数据')
  }
  if (source.repository && !release) reasons.push('npm 与官方 Release 尚未对应')
  const currentTag = source.tagBaseline ? baseline(root, source.tagBaseline) : source.tagPrefix + current
  if (source.repository && release) {
    const history = await api.releaseHistory(source.repository)
    const review = await reviewReleaseRange(api, source, currentTag, release.tag_name, history)
    const { raw, sensitive, reasons: gaps, ...evidence } = review
    record.releaseReview = evidence
    record.releaseNotes = text(raw)
    record.releaseNotesSha256 = review.sha256
    record.releaseNotesTruncated = raw.length > 10000
    if (sensitive) reasons.push('跨版本官方完整说明包含认证、权限、执行、网络或破坏性变更')
    if (!review.complete) reasons.push(...gaps)
  } else if (sensitiveReleaseChange.test(release?.body || '')) reasons.push('官方发布说明包含破坏性或安全变更')
  if (record.releaseNotesTruncated) reasons.push('发布说明超过自动审查上下文预算，需完整人工复查')
  if (current.split('.')[0] !== target.split('.')[0]) reasons.push('跨主版本变化')
  if (source.plugin) reasons.push('消息渠道插件需要宿主兼容及真实账号链路确认')
  return { ...record, status: 'update', risk: reasons.length ? 'high' : 'medium', reasons, compareUrl: source.repository ? `https://github.com/${source.repository}/compare/${encodeURIComponent(currentTag)}...${encodeURIComponent(release?.tag_name || source.tagPrefix + target)}` : null }
}

async function intake(api, since, previousFrom, feedback) {
  const repo = `/repos/${policy.repository}`
  const start = previousFrom ? date(previousFrom) : since
  const delta = (await api.list(`${repo}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(start)}&per_page=100`)).filter(item => !item.pull_request && !own(item) && Date.parse(item.updated_at) >= Date.parse(start))
  const open = (await api.list(`${repo}/issues?state=open&sort=updated&direction=desc&per_page=100`)).filter(item => !item.pull_request && !own(item))
  const pulls = (await api.list(`${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`, { until: start })).filter(item => !own(item) && Date.parse(item.updated_at) >= Date.parse(start))
  if (delta.length + pulls.length > policy.limits.details) throw new Error('反馈详情超过本轮预算，需拆分整理，不自动适配')
  const issues = []
  for (const item of delta) {
    const comments = await api.list(`${repo}/issues/${item.number}/comments?per_page=100`)
    issues.push(withDiscussion(item, { comments: comments.map(comment => ({ ...bodyInfo(comment, feedback), updatedAt: date(comment.updated_at || comment.created_at), url: text(comment.html_url, 2000) })) }, feedback))
  }
  const pullRequests = []
  for (const item of pulls) {
    const detail = await api.get(`${repo}/pulls/${item.number}`)
    const reviews = await api.list(`${repo}/pulls/${item.number}/reviews?per_page=100`)
    const comments = await api.list(`${repo}/issues/${item.number}/comments?per_page=100`)
    const reviewComments = await api.list(`${repo}/pulls/${item.number}/comments?per_page=100`)
    pullRequests.push(withDiscussion(item, { draft: detail.draft, headSha: detail.head?.sha, mergedAt: detail.merged_at, mergeableState: detail.mergeable_state,
      reviews: reviews.map(review => ({ ...bodyInfo(review, feedback), state: review.state, submittedAt: review.submitted_at, url: text(review.html_url, 2000) })),
      comments: [...comments, ...reviewComments].map(comment => ({ ...bodyInfo(comment, feedback), updatedAt: date(comment.updated_at || comment.created_at), url: text(comment.html_url, 2000) })),
    }, feedback))
  }
  const recent = item => Date.parse(item.updatedAt) >= Date.parse(since)
  const backlogIssues = open.filter(item => !issues.some(updated => updated.number === item.number && recent(updated))).map(item => normalize(item, feedback))
  return { since, issues: issues.filter(recent), pullRequests: pullRequests.filter(recent), backlogIssues,
    releasePeriod: { from: start, to: since, issues: issues.filter(item => !recent(item)), pullRequests: pullRequests.filter(item => !recent(item)) } }
}

export async function scan(api, root, output) {
  fs.mkdirSync(output, { recursive: true })
  const report = { schemaVersion: 1, repository: policy.repository, generatedAt: new Date().toISOString(), baseSha: '', panelVersion: '', complete: false, autoRelease: false, errors: [], sources: [], candidates: [], selected: null, intake: { issues: [], pullRequests: [], backlogIssues: [] } }
  let feedback
  try {
    feedback = new FeedbackStore(output)
    report.baseSha = git(root, ['rev-parse', 'HEAD'])
    report.panelVersion = readJson(path.join(root, 'package.json')).version
    const releases = (await api.releases(policy.repository)).filter(item => !item.draft && !item.prerelease).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    if (!releases[0]) throw new Error('尚无正式 Release 基线，需要人工设置首次巡检边界')
    report.releaseWindow = { fromTag: releases[0].tag_name, from: date(releases[0].published_at), to: report.generatedAt, previousTag: releases[1]?.tag_name || null, previousFrom: releases[1]?.published_at || null }
    report.intake = await intake(api, report.releaseWindow.from, report.releaseWindow.previousFrom, feedback)
    report.feedback = feedback.manifest()
    validateFeedbackMaterials(report, output)
    for (const source of policy.sources) {
      try { report.sources.push(await inspectSource(api, root, source)) }
      catch (error) { report.errors.push(`${source.id}: ${redact(error.message)}`) }
    }
    report.candidates = report.sources.filter(item => item.status === 'update')
    report.complete = report.errors.length === 0
    if (report.complete) report.selected = report.candidates.find(item => item.risk !== 'high' && policy.sources.find(source => source.id === item.id).allowedPaths.length) || null
  } catch (error) { report.errors.push(redact(error.message)) }
  report.feedback = feedback?.manifest() || null
  const fingerprint = () => digest({ sources: report.sources.map(({ id, current, target, targetTag, release, risk, releaseNotes, releaseNotesSha256, releaseReview, integrity }) => ({ id, current, target, targetTag, release, risk, notes: releaseNotesSha256 || digest(releaseNotes), releaseReview, integrity })), issues: [...report.intake.issues, ...report.intake.backlogIssues], prs: report.intake.pullRequests, releasePeriod: report.intake.releasePeriod, errors: report.errors })
  report.fingerprint = fingerprint()
  try { await selectCandidate(api, root, report) }
  catch (error) { report.errors.push(redact(error.message)); report.complete = false; report.selected = null; report.fingerprint = fingerprint() }
  report.needsConfirmation = !report.complete || !!report.blockedCandidate || report.sources.some(item => item.risk === 'high') || feedbackItems(report.intake).some(item => item.risk === 'high')
  writeJson(path.join(output, 'report.json'), report)
  fs.writeFileSync(path.join(output, 'report.md'), renderReport(report))
  fs.writeFileSync(path.join(output, 'prompt.md'), renderPrompt(report, output))
  return report
}
