import { botLogin, digest, git, policy, trackerTitle } from './core.mjs'

/** 每轮只选一个未处理候选；已有草稿/失败回执不阻塞其他普通组件。 */
export async function selectCandidate(api, root, report) {
  report.selected = null
  report.existingCandidates = []
  report.blockedCandidates = []
  report.blockedCandidateKeys = []
  const choices = report.candidates.filter(item => item.risk !== 'high' && policy.sources.find(source => source.id === item.id).allowedPaths.length)
  if (!report.complete || !choices.length) return
  const login = botLogin()
  const trackers = await api.list(`/repos/${policy.repository}/issues?state=all&sort=updated&direction=desc&creator=${encodeURIComponent(login)}&per_page=100`)
  for (const choice of choices) {
    const source = policy.sources.find(item => item.id === choice.id)
    const sourceRevision = git(root, ['log', '-1', '--format=%H', '--', ...source.allowedPaths])
    const key = digest({ id: choice.id, current: choice.current, target: choice.target, channel: choice.channel, sourceRevision, notes: digest(choice.releaseNotes) })
    report.candidateKey = key
    const branch = `codex/maintenance-${key.slice(0, 16)}`
    const existing = (await api.list(`/repos/${policy.repository}/pulls?state=all&head=${policy.repository.split('/')[0]}:${branch}&per_page=100`)).find(pr => pr.head?.ref === branch)
    if (existing) {
      report.existingCandidates.push({ number: existing.number, state: existing.state, url: existing.html_url, branch, id: choice.id })
      report.existingCandidate ||= report.existingCandidates[0]
      continue
    }
    const blocked = trackers.find(item => item.user?.login === login && item.title === trackerTitle && item.body?.includes(`<!-- clawpanel-maintenance-blocked:${key} -->`))
    if (blocked) {
      report.blockedCandidateKeys.push(key)
      report.blockedCandidateKey ||= key
      report.blockedCandidates.push({ id: choice.id, url: blocked.html_url, reason: '此候选已有失败/高风险回执，等待人工确认后重试' })
      report.blockedCandidate ||= report.blockedCandidates[0]
      continue
    }
    report.selected = choice
    break
  }
}
