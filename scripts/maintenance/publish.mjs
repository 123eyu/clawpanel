import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertReport, botLogin, candidateId, digest, git, policy, readJson, redact, safeFile, trackerTitle } from './core.mjs'
import { guard } from './guard.mjs'
import { renderReport } from './report.mjs'
import { verifyPins } from './pins.mjs'

const repo = `/repos/${policy.repository}`
export async function notify(api, report, apply = false) {
  assertReport(report)
  if (!report.needsConfirmation) return { action: 'quiet', autoRelease: false }
  const login = botLogin()
  const marker = `<!-- clawpanel-maintenance:${report.fingerprint} -->`
  const trackers = (await api.list(`${repo}/issues?state=all&sort=updated&direction=desc&creator=${encodeURIComponent(login)}&per_page=100`)).filter(item => !item.pull_request && item.user?.login === login && item.title === trackerTitle && /<!-- clawpanel-maintenance:[a-f0-9]{64} -->/.test(item.body || ''))
  const existing = trackers[0]
  const mention = process.env.MAINTENANCE_NOTIFY_LOGIN || ''
  if (mention && !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(mention)) throw new Error('通知对象不是有效 GitHub 用户名')
  // 只提及仓库维护者配置的账号，不使用反馈正文中的 @ 内容。
  const oldKeys = [...(existing?.body || '').matchAll(/<!-- clawpanel-maintenance-blocked:([a-f0-9]{64}) -->/g)].map(match => match[1])
  const keys = [...new Set([...oldKeys, ...(report.blockedCandidateKeys || []), report.blockedCandidateKey].filter(key => /^[a-f0-9]{64}$/.test(key || '')))].sort()
  if (keys.length > 128) throw new Error('失败回执超过保留预算，需要人工归档；现有回执未覆盖')
  if (existing?.body?.includes(marker) && keys.every(key => oldKeys.includes(key))) return { action: 'unchanged', url: existing.html_url, autoRelease: false }
  const blocked = keys.map(key => `<!-- clawpanel-maintenance-blocked:${key} -->\n`).join('')
  const body = `${marker}\n${blocked}${mention ? `@${mention}\n\n` : ''}${renderReport(report)}\n需要确认的项目保持未执行，自动发版仍关闭。\n`
  if (!apply) return { action: 'dry-run', operation: existing ? 'update' : 'create', autoRelease: false }
  const item = existing ? await api.write(`${repo}/issues/${existing.number}`, 'PATCH', { title: trackerTitle, body, state: 'open' }) : await api.write(`${repo}/issues`, 'POST', { title: trackerTitle, body })
  return { action: existing ? 'updated' : 'created', url: item.html_url, autoRelease: false }
}

// 独立临时 index 计算实际预期 tree，不改工作区/index，不相信提交消息自述的 hash。
function expectedTree(root, baseSha, patchFile) {
  const index = path.join(os.tmpdir(), `clawpanel-maintenance-index-${randomUUID()}`)
  try {
    const env = { GIT_INDEX_FILE: index }
    git(root, ['read-tree', baseSha], env)
    git(root, ['apply', '--cached', patchFile], env)
    return git(root, ['write-tree'], env)
  } finally {
    for (const file of [index, index + '.lock']) fs.rmSync(file, { force: true })
  }
}

export async function propose(api, root, report, patchFile, resultFile, apply = false) {
  const checked = guard(root, report, patchFile, resultFile)
  if (checked.skipped) return { action: 'no-change', autoRelease: false }
  const identity = candidateId(report)
  const branch = `codex/maintenance-${identity.slice(0, 16)}`
  const prs = await api.list(`${repo}/pulls?state=all&head=${policy.repository.split('/')[0]}:${branch}&per_page=100`)
  // 手工关闭或已合并的候选同样保留，不重开、不强推。
  if (prs.length) return { action: 'existing', state: prs[0].state, url: prs[0].html_url, autoRelease: false }
  const main = await api.get(`${repo}/commits/main`)
  if (main.sha !== report.baseSha) throw new Error('main 已变化，本轮候选需重新巡检')
  if (!apply) return { action: 'dry-run', branch, ...checked }
  if (git(root, ['branch', '--show-current'])) throw new Error('写入候选只接受干净的 detached checkout')
  const patchHash = digest(fs.readFileSync(patchFile, 'utf8'))
  const verifiedTree = expectedTree(root, report.baseSha, patchFile)
  let commit, existingRef
  try { existingRef = await api.get(`${repo}/git/ref/heads/${branch}`) }
  catch (error) { if (error.status !== 404) throw error }
  if (existingRef) {
    const sha = existingRef.object?.sha
    if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('已存在候选 ref 的响应无效')
    commit = await api.get(`${repo}/git/commits/${sha}`)
    if (!commit.message?.includes(`Candidate: ${identity}\nPatch: ${patchHash}`) || commit.parents?.length !== 1 || commit.parents[0].sha !== report.baseSha || commit.tree?.sha !== verifiedTree) throw new Error('同名分支内容/tree/基线不属于本次可恢复候选，不覆盖')
    commit.sha = sha
  }
  if (!commit) {
  // 应用后仅读取文本构造 Git tree；此进程不执行候选脚本，不向候选代码提供写入令牌。
  git(root, ['apply', patchFile])
  verifyPins(root, report)
  const tree = []
  for (const name of checked.files) {
    const file = safeFile(root, name)
    const mode = git(root, ['ls-tree', report.baseSha, '--', name]).split(' ')[0] || '100644'
    if (!['100644', '100755'].includes(mode)) throw new Error('原文件模式不在受管范围')
    if (!fs.existsSync(file)) { tree.push({ path: name, mode, type: 'blob', sha: null }); continue }
    const bytes = fs.readFileSync(file)
    if (bytes.includes(0)) throw new Error('候选包含二进制内容')
    tree.push({ path: name, mode, type: 'blob', content: bytes.toString('utf8') })
  }
  const baseTree = main.commit?.tree?.sha
  if (!/^[a-f0-9]{40}$/.test(baseTree || '')) throw new Error('main tree SHA 无效')
  const createdTree = await api.write(`${repo}/git/trees`, 'POST', { base_tree: baseTree, tree })
  if (createdTree.sha !== verifiedTree) throw new Error('GitHub tree 与已验证补丁的实际 tree 不一致')
  commit = await api.write(`${repo}/git/commits`, 'POST', { message: `chore(maintenance): candidate ${report.selected.id}\n\nCandidate: ${identity}\nPatch: ${patchHash}`, tree: createdTree.sha, parents: [report.baseSha] })
  if ((await api.get(`${repo}/commits/main`)).sha !== report.baseSha) throw new Error('创建候选时 main 发生变化，停止创建分支')
  await api.write(`${repo}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha })
  }
  if (existingRef) {
    git(root, ['apply', patchFile])
    verifyPins(root, report)
  }
  if ((await api.get(`${repo}/commits/main`)).sha !== report.baseSha) throw new Error('创建 PR 前 main 发生变化，保留候选分支等待复查')
  const result = readJson(resultFile)
  const pr = await api.write(`${repo}/pulls`, 'POST', { title: `chore(maintenance): ${report.selected.id} ${report.selected.target}`, head: branch, base: 'main', draft: true, body: `<!-- clawpanel-maintenance-candidate:${identity} -->\n## 候选适配（观察阶段）\n\n${redact(result.summary)}\n\n${redact(result.reason || '')}\n\n基线：${report.baseSha}\n\n固定测试在每日维护 Actions 中运行；请结合对应 artifact 查看，模型总结不是测试证明。草稿 PR 不自动合并、不自动发版。\n\n${renderReport(report)}` })
  return { action: 'created', url: pr.html_url, branch, sha: commit.sha, autoRelease: false }
}
