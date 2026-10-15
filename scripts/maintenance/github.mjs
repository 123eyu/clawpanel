import { baseUrl, policy } from './core.mjs'

// 认证只发给固定 GitHub API；重定向、分页越界、限流和响应截断均按失败处理。
export class Sources {
  constructor(options = {}) {
    this.github = baseUrl(options['github-url'], 'https://api.github.com/', options.fixture)
    this.registry = baseUrl(options['registry-url'], 'https://registry.npmjs.org/', options.fixture)
    this.token = options.fixture ? '' : process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
    this.cache = new Map()
  }
  async request(url, { method = 'GET', body, github = true } = {}) {
    const expected = github ? this.github : this.registry
    if (!url.startsWith(expected + '/')) throw new Error('拒绝数据源越界')
    const headers = { Accept: 'application/json', 'User-Agent': 'ClawPanel-maintenance' }
    if (github && this.token) headers.Authorization = `Bearer ${this.token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(url, { method, headers, redirect: 'error', body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(policy.limits.requestMs) })
    if (!response.ok) {
      const error = new Error(`${github ? 'GitHub' : 'npm'} HTTP ${response.status}: ${new URL(url).pathname}`)
      error.status = response.status
      throw error
    }
    const reader = response.body.getReader(), chunks = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > policy.limits.responseBytes) throw new Error('数据源响应超过大小上限')
        chunks.push(Buffer.from(part.value))
      }
    } finally { await reader.cancel() }
    return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), link: response.headers.get('link') || '' }
  }
  async get(endpoint) { return (await this.request(this.github + endpoint)).data }
  async write(endpoint, method, body) { return (await this.request(this.github + endpoint, { method, body })).data }
  async list(endpoint, { until = null } = {}) {
    const items = []
    let next = this.github + endpoint
    for (let page = 0; next && page < policy.limits.pages; page++) {
      const { data, link } = await this.request(next)
      if (!Array.isArray(data)) throw new Error('GitHub 分页结果不是数组')
      items.push(...data)
      if (until && data.some(item => !Number.isFinite(Date.parse(item.updated_at)))) throw new Error('分页排序时间缺失')
      // 对 sort=updated&direction=desc 的 PR 列表，越过时间窗后不再遍历无关历史。
      if (until && data.length && Date.parse(data.at(-1).updated_at) < Date.parse(until)) return items
      next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] || ''
      if (next) {
        const url = new URL(next), first = new URL(this.github + endpoint)
        // GitHub 的 Link 常将仓库名规范化为 /repositories/<数字ID>/...。
        const suffix = first.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '')
        const canonical = url.pathname.replace(/^\/repositories\/\d+/, '') === suffix && /^\/repositories\/\d+\//.test(url.pathname)
        if (url.origin !== first.origin || (url.pathname !== first.pathname && !canonical) || url.username || url.password || url.hash) throw new Error('GitHub 分页地址越界')
      }
    }
    if (next) throw new Error('GitHub 分页超过预算，结果未完整读取')
    return items
  }
  async releases(repo) {
    const key = `releases:${repo}`
    // 版本发现只取近期窗口；精确通道目标另按 tag 核对，不遍历几千个历史发布。
    if (!this.cache.has(key)) this.cache.set(key, this.get(`/repos/${repo}/releases?per_page=100`).then(items => {
      if (!Array.isArray(items)) throw new Error('Release 返回结构错误')
      if (items.some(item => typeof item.draft !== 'boolean' || typeof item.prerelease !== 'boolean' || typeof item.tag_name !== 'string' || (!item.draft && !Number.isFinite(Date.parse(item.published_at))))) throw new Error('Release 通道或发布时间字段缺失')
      return items
    }))
    return this.cache.get(key)
  }
  async npm(name, selector = null) {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error('无效包名称')
    const key = `npm:${name}:${selector || 'dist-tags'}`
    const suffix = selector ? `/${encodeURIComponent(name)}/${encodeURIComponent(selector)}` : `/-/package/${encodeURIComponent(name)}/dist-tags`
    if (!this.cache.has(key)) this.cache.set(key, this.request(this.registry + suffix, { github: false }).then(value => value.data))
    return this.cache.get(key)
  }
}
