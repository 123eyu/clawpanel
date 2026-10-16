import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source=readFileSync(new URL('../scripts/maintenance-runtime-smoke.mjs',import.meta.url),'utf8')
test('真实验收指纹包含实际发运桥与已有认证/网关依赖，预览同样使用 Windows 短 HOME',()=>{
 const map=source.slice(source.indexOf('report.environment.candidateSourceHashes'),source.indexOf('return { packageName'))
 for(const file of ['scripts/opencode-proxy.js','scripts/deepseek-harness-auth.js','scripts/deepseek-harness-proxy.js','src/lib/opencode-storage-bridge.js','src/engines/hermes/pages/chat.js','src/engines/opencode/pages/dashboard.js']) assert.ok(map.includes(file),file)
 const deps=source.slice(source.indexOf('report.environment.verifierDependencyHashes'),source.indexOf('report.environment.candidateSourceHashes'))
 assert.ok(deps.includes('src/lib/openclaw-gateway-compat.js'))
 assert.ok(!map.includes('scripts/hermes-pm-runtime.js'), '未发运的 Hermes PM 候选不进入指纹闭包')
 assert.match(source,/shortDshHome = process\.platform === 'win32' && \['deepseek-harness', 'deepseek-harness-preview'\]\.includes\(engine\)/)
})
