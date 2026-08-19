/*
 * source-cache.js — 只读模板节点的内容寻址共享缓存
 *
 * 模板源节点（v-for sourceNodes / v-if sourceBranches / slot 投影模板等）
 * 自提取起只用于 cloneNode(true) 读取，从不修改，因此内容相同的源
 * 全局共享一份即可。避免「每个实例化点各驻留一份模板克隆」的乘数驻留
 * （长列表场景：item 数 × 分支数 × 模板大小）。
 *
 * key 为节点序列化内容（outerHTML/textContent）；LRU 上限防止
 * 动态 inline 模板（parseRaw 随机内容）导致无界增长。
 */

const cache = new Map()
const SOURCE_CACHE_LIMIT = 512

function serializeNode(node) {
  if (node.nodeType === 3) return 't:' + node.textContent
  return node.nodeName === 'TEMPLATE' ? 'h:' + node.innerHTML : 'e:' + node.outerHTML
}

/**
 * 按内容 key 获取共享的模板源节点数组。
 * extract 仅在缓存未命中时调用（应返回深克隆好的节点数组）。
 * 返回的数组及其节点在调用方之间共享，严禁修改。
 */
export function getSharedTemplateNodes(key, extract) {
  let hit = cache.get(key)
  if (hit) {
    // LRU 触达
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const nodes = extract()
  if (cache.size >= SOURCE_CACHE_LIMIT) {
    cache.delete(cache.keys().next().value)
  }
  cache.set(key, nodes)
  return nodes
}

export function sharedKeyForNode(node) {
  return serializeNode(node)
}

// 测试用：观察共享缓存规模
export function getSharedSourceCacheSize() {
  return cache.size
}
