import { assertReport, baseline, git, policy, version } from './core.mjs'

/** 从可信入口回读已应用候选，禁止用不同版本冒充巡检目标。 */
export function verifyPins(root, report) {
  assertReport(report)
  if (!report.complete || !report.selected || report.selected.risk === 'high') throw new Error('候选尚未具备版本核验条件')
  if (git(root, ['rev-parse', 'HEAD']) !== report.baseSha) throw new Error('版本核验基线 SHA 不一致')
  const source = policy.sources.find(item => item.id === report.selected.id)
  if (!source) throw new Error('候选组件未知')
  const target = version(report.selected.target)
  for (const spec of [source.baseline, ...source.mirrors]) {
    if (baseline(root, spec) !== target) throw new Error(`候选未同步到巡检精确目标: ${spec.path}`)
  }
  if (source.tagBaseline && baseline(root, source.tagBaseline) !== source.tagPrefix + target) throw new Error('候选源码 tag 未匹配软件版本目标')
  return { ok: true, id: source.id, target, autoRelease: false }
}
