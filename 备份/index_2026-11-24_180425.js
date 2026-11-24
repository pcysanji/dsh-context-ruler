/**
 * dsh-context-guard — 宿主半边。
 *
 * 只做三件本地的事，一个 token 都不花：
 * 1. 按「发送前 payload 的纯文本字节数」量当前会话体积（口径与 413 一致）；
 * 2. 通过本地 HTTP 路由把数字交给客户端徽标（零注入）；
 * 3. 交接时把交接文档写到工作区的 _交付/ 下，并把绝对路径回给客户端。
 *
 * 配置在插件目录的 config.json，每次请求按 mtime 重读，改完不用重启。
 */

import { mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTE = '/context-guard/api'
/* 配置放在 DSH_HOME 下，装成 npm 包后不会写进 node_modules。 */
const HOME_DIR = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || HERE, '.dsh')
const CONFIG_DIR = path.join(HOME_DIR, 'context-guard')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const LEGACY_CONFIG_PATH = path.join(HERE, 'config.json')

const DEFAULTS = {
  enabled: true,
  showBadge: true,
  showAlerts: true,
  refreshEveryTurns: 25,
  autoLimit: true,
  contextWindow: 750000,
  bytesPerToken: 7.5,
  warnRatio: 0.6,
  dangerRatio: 0.85,
  autoHandoff: false,
  imageBytes: 350000,
  handoffDir: '_交付',
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

let configCache = { stamp: '', value: { ...DEFAULTS } }

function migrateLegacyConfig() {
  try {
    statSync(CONFIG_PATH)
    return
  } catch {
    /* 新位置还没有配置 */
  }
  try {
    const legacy = readFileSync(LEGACY_CONFIG_PATH, 'utf8')
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, legacy, 'utf8')
  } catch {
    /* 没有旧文件就等用户保存时再建 */
  }
}

function loadConfig() {
  migrateLegacyConfig()
  let stamp = ''
  try {
    const st = statSync(CONFIG_PATH)
    stamp = String(st.mtimeMs) + ':' + String(st.size)
  } catch {
    stamp = 'missing'
  }
  if (stamp === configCache.stamp) return configCache.value
  let value = { ...DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (raw && typeof raw === 'object') value = { ...value, ...raw }
  } catch {
    /* 文件不存在或没有合法 JSON 时用默认值 */
  }
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
  value.contextWindow = num(value.contextWindow, DEFAULTS.contextWindow)
  value.bytesPerToken = num(value.bytesPerToken, DEFAULTS.bytesPerToken)
  value.refreshEveryTurns = num(value.refreshEveryTurns, DEFAULTS.refreshEveryTurns)
  value.warnRatio = num(value.warnRatio, DEFAULTS.warnRatio)
  value.dangerRatio = num(value.dangerRatio, DEFAULTS.dangerRatio)
  value.imageBytes = num(value.imageBytes, DEFAULTS.imageBytes)
  value.autoLimit = value.autoLimit !== false
  value.enabled = value.enabled !== false
  value.showBadge = value.showBadge !== false
  value.showAlerts = value.showAlerts !== false
  configCache = { stamp, value }
  return value
}

function writeConfig(patch) {
  let current = { ...DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (raw && typeof raw === 'object') current = { ...current, ...raw }
  } catch {
    /* 没有旧文件就从默认值起步 */
  }
  if (patch && typeof patch === 'object') current = { ...current, ...patch }
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8')
  configCache = { stamp: '', value: { ...DEFAULTS } }
  return loadConfig()
}

/* ------------------------------------------------------------------ *
 * 体积计算
 * ------------------------------------------------------------------ */

function byteLen(value) {
  if (typeof value !== 'string' || value.length === 0) return 0
  return Buffer.byteLength(value, 'utf8')
}

function argsBytes(args) {
  if (typeof args === 'string') return byteLen(args)
  if (args && typeof args === 'object') {
    try {
      return byteLen(JSON.stringify(args))
    } catch {
      return 0
    }
  }
  return 0
}

function blockBytes(block, cfg) {
  if (!block || typeof block !== 'object') return 0
  const type = block.type
  if (type === 'text') return byteLen(block.text)
  if (type === 'tool-call') return byteLen(block.name) + argsBytes(block.arguments)
  if (type === 'reasoning') return 0
  if (type === 'image') {
    const bytes = block.attachment && block.attachment.bytes
    if (typeof bytes === 'number' && bytes > 0) return Math.round((bytes * 4) / 3)
    return cfg.imageBytes
  }
  if (type === 'file') return byteLen(block.name) + byteLen(block.text)
  if (type === 'tool-addition' || type === 'tool-removal') return 0
  if (typeof block.text === 'string') return byteLen(block.text)
  return 0
}

function messageBlocks(message) {
  if (!message) return []
  if (Array.isArray(message.blocks)) return message.blocks
  if (Array.isArray(message.content)) return message.content
  return []
}

const INJECTION_MARKER = '<system-reminder'

/* DSH 把系统注入混在 user 角色的消息里发出去；交接文档只该留下人真正打过的字。 */
const INJECTION_PREFIXES = [
  '<system-reminder',
  'Time sampled while',
  'Browser time zone for this request',
  '[MNEMON]',
  'MNEMON',
  '[bili]',
  '[Compressed conversation section]',
  '[ACP]',
  'This is an efficiency nudge',
  'Context breakdown:',
  'Available skills',
]

function isInjectedText(text) {
  const head = String(text || '').trim()
  if (!head) return false
  if (head.includes(INJECTION_MARKER)) return true
  for (const prefix of INJECTION_PREFIXES) {
    if (head.startsWith(prefix)) return true
  }
  return false
}

function isInjectedMessage(message) {
  if (!message) return true
  const role = message.role
  if (role === 'system' || role === 'developer') return true
  if (role !== 'user') return false
  return isInjectedText(messageText(message))
}

function messageText(message) {
  let text = ''
  for (const block of messageBlocks(message)) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function measureMessages(messages, cfg) {
  const parts = { tool: 0, assistant: 0, user: 0, injected: 0 }
  let assistantTurns = 0
  /* 徽标只挂在最后一条助手消息的动作行上，客户端拿它的 messageId 对号。 */
  let lastAssistantMessageId = null
  for (const message of messages) {
    const role = message && message.role
    let bucket
    if (role === 'tool' || role === 'tool-result') bucket = 'tool'
    else if (role === 'assistant') bucket = 'assistant'
    else if (role === 'system' || role === 'developer') bucket = 'injected'
    else {
      bucket = isInjectedText(messageText(message)) ? 'injected' : 'user'
    }
    if (role === 'assistant') {
      assistantTurns += 1
      if (message && message.id) lastAssistantMessageId = String(message.id)
    }
    let sum = 0
    for (const block of messageBlocks(message)) sum += blockBytes(block, cfg)
    parts[bucket] += sum
  }
  const bytes = parts.tool + parts.assistant + parts.user + parts.injected
  return { parts, bytes, turns: assistantTurns, messages: messages.length, lastAssistantMessageId }
}

/* ------------------------------------------------------------------ *
 * 会话体积（带节流）
 * ------------------------------------------------------------------ */

const cache = new Map()

/* 当前会话所用路由的上下文上限：优先问宿主 tokenMeter，拿不到再退回配置值。 */
function detectContextWindow(ctx, session) {
  try {
    const meter = ctx.get ? ctx.get('tokenMeter') : null
    if (!meter || typeof meter.contextPressure !== 'function') return 0
    const pressure = meter.contextPressure(session)
    const window = pressure && Number(pressure.contextWindow)
    if (Number.isFinite(window) && window > 0) return Math.round(window)
  } catch {
    /* 宿主没记录过 prompt 大小时会抛错，忽略 */
  }
  return 0
}

function resolveContextWindow(ctx, session, cfg) {
  if (!cfg.autoLimit) return { window: cfg.contextWindow, source: 'config' }
  const detected = detectContextWindow(ctx, session)
  if (detected > 0) return { window: detected, source: 'model' }
  return { window: cfg.contextWindow, source: 'config' }
}

function snapshotOf(sessionId, cfg, measurement, limit, window, windowSource) {
  const ratio = limit > 0 ? measurement.bytes / limit : 0
  return {
    sessionId,
    bytes: measurement.bytes,
    limit,
    ratio,
    percent: Math.round(ratio * 1000) / 10,
    estTokens: Math.round(measurement.bytes / cfg.bytesPerToken),
    contextWindow: window || cfg.contextWindow,
    contextWindowSource: windowSource || 'config',
    autoLimit: cfg.autoLimit !== false,
    bytesPerToken: cfg.bytesPerToken,
    parts: measurement.parts,
    turns: measurement.turns,
    messages: measurement.messages,
    lastAssistantMessageId: measurement.lastAssistantMessageId || null,
    lastTurnMessageId: measurement.lastTurnMessageId || null,
    warnRatio: cfg.warnRatio,
    dangerRatio: cfg.dangerRatio,
    at: Date.now(),
  }
}

function countTurnEnds(session, fromSeq) {
  try {
    const events = session.snapshotEvents(fromSeq)
    if (!Array.isArray(events)) return 0
    let n = 0
    for (const event of events) if (event && event.type === 'turn/end') n += 1
    return n
  } catch {
    return 0
  }
}

/* 最后一条「已收尾回合」的助手消息 id：轮内多步时，最后一条 assistant 消息可能属于正在跑的这一轮，动作行还没出现。 */
function lastTurnMessageId(session) {
  try {
    const events = session.snapshotEvents(0)
    if (!Array.isArray(events) || events.length === 0) return null
    let turn = null
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (!event) continue
      if (turn === null) {
        if (event.type === 'turn/end' && event.data && typeof event.data.turn === 'number') turn = event.data.turn
        continue
      }
      if (event.type === 'assistant/message' && event.data && event.data.turn === turn) {
        const id = event.data.message && event.data.message.id
        if (id) return String(id)
      }
    }
    return null
  } catch {
    return null
  }
}

function measureSession(session, cfg, force, resolved) {
  const sessionId = session.id
  const window = (resolved && resolved.window) || cfg.contextWindow
  const windowSource = (resolved && resolved.source) || 'config'
  const limit = window * cfg.bytesPerToken
  const seq = typeof session.seq === 'number' ? session.seq : 0
  let generation = 0
  try {
    generation = Number(session.surface && session.surface.contentGeneration) || 0
  } catch {
    generation = 0
  }

  const cached = cache.get(sessionId)
  const windowChanged = !!(cached && cached.snapshot && cached.snapshot.contextWindow !== window)
  if (cached && !force && !windowChanged && cached.seq === seq && cached.generation === generation) {
    return { ...cached.snapshot, stale: false }
  }

  let due = true
  let turns = cached ? cached.turns : 0
  if (cached) {
    const fresh = cached.seq === seq ? 0 : countTurnEnds(session, cached.seq)
    turns = cached.turns + fresh
    const waited = turns - cached.turns
    const nearLine = cached.snapshot.ratio >= cfg.warnRatio
    due = force || windowChanged || waited >= cfg.refreshEveryTurns || nearLine || cached.generation !== generation
  }

  if (!due) {
    cache.set(sessionId, { ...cached, seq, turns })
    return { ...cached.snapshot, turns, stale: true }
  }

  const messages = session.deriveMessages()
  const measurement = measureMessages(messages, cfg)
  measurement.lastTurnMessageId = lastTurnMessageId(session)
  const snapshot = snapshotOf(sessionId, cfg, measurement, limit, window, windowSource)
  cache.set(sessionId, { seq, generation, turns: measurement.turns, snapshot })
  return { ...snapshot, stale: false }
}

/* ------------------------------------------------------------------ *
 * 交接文档
 * ------------------------------------------------------------------ */

function pad2(n) {
  return String(n).padStart(2, '0')
}

function stamp(date) {
  return (
    date.getFullYear() +
    '-' + pad2(date.getMonth() + 1) +
    '-' + pad2(date.getDate()) +
    '_' + pad2(date.getHours()) +
    pad2(date.getMinutes())
  )
}

function clockText(time) {
  const d = new Date(typeof time === 'number' ? time : Date.now())
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function clip(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max) + '…'
}

const URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`]+/g
const WIN_PATH = /[A-Za-z]:[\\/][^\s"'`,;|<>*?{}]{3,260}/g

function pathKey(value) {
  return value.replace(/\//g, '\\').toLowerCase()
}

/* 工具参数是 JSON 文本，盘上真名里的单个 \ 到这儿可能被转义一到两次；还原成能直接打开的形式。 */
function unescapePath(value) {
  const unc = /^\\\\/.test(value)
  let out = value.replace(/\\{2,}/g, '\\')
  if (unc && !/^\\\\/.test(out)) out = '\\' + out
  return out
}

function collectPaths(messages, max) {
  const seen = new Map()
  for (const message of messages) {
    for (const block of messageBlocks(message)) {
      if (!block || block.type !== 'tool-call') continue
      let raw = ''
      if (typeof block.arguments === 'string') raw = block.arguments
      else if (block.arguments && typeof block.arguments === 'object') {
        try {
          raw = JSON.stringify(block.arguments)
        } catch {
          raw = ''
        }
      }
      if (!raw) continue
      /* 先把 URL 整段抹掉，否则 http:// 里的 p:// 会被当成盘符路径抓出来。 */
      const body = raw.replace(URL_PATTERN, ' ')
      const found = body.match(WIN_PATH)
      if (!found) continue
      for (const item of found) {
        const clean = unescapePath(item).replace(/[\\/]+$/, '')
        if (clean.length < 6) continue
        /* 带 ... 的是正文里的占位写法，不是真实路径 */
        if (clean.includes('...')) continue
        const key = pathKey(clean)
        seen.delete(key)
        seen.set(key, clean)
      }
    }
  }
  const all = Array.from(seen.values())
  return all.slice(Math.max(0, all.length - max))
}

function buildHandoffDoc(ctx, session, snapshot, cfg) {
  const messages = session.deriveMessages()
  const header = session.header || {}
  const title = header.title || session.id
  const cwd = resolveCwd(ctx, session)
  const now = new Date()

  const userMessages = messages.filter((m) => m && m.role === 'user' && !isInjectedMessage(m))
  const goalSource = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null

  const recent = []
  for (let i = messages.length - 1; i >= 0 && recent.length < 24; i -= 1) {
    const message = messages[i]
    if (!message) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (isInjectedMessage(message)) continue
    const text = clip(messageText(message), 220)
    if (!text) continue
    recent.push({ role: message.role, text, time: message.time })
  }
  recent.reverse()

  const paths = collectPaths(messages, 24)
  const lines = []
  lines.push('# 交接：' + title)
  lines.push('')
  lines.push('- 生成时间：' + now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()))
  lines.push('- 来源会话：`' + session.id + '`（' + snapshot.turns + ' 轮 / ' + snapshot.messages + ' 条消息）')
  lines.push('- 工作目录：`' + cwd + '`')
  lines.push('- 上下文体积：' + (snapshot.bytes / 1e6).toFixed(1) + ' / ' + (snapshot.limit / 1e6).toFixed(1) + ' MB（' + snapshot.percent + '%）')
  const parts = snapshot.parts || {}
  lines.push(
    '- 体积构成：工具结果 ' + ((parts.tool || 0) / 1e6).toFixed(1) +
    ' MB / 助手文本 ' + ((parts.assistant || 0) / 1e6).toFixed(1) +
    ' MB / 用户消息 ' + ((parts.user || 0) / 1e6).toFixed(1) +
    ' MB / 注入提醒 ' + ((parts.injected || 0) / 1e6).toFixed(1) + ' MB',
  )
  lines.push('')
  lines.push('## 目标')
  lines.push('')
  if (goalSource) {
    const text = clip(messageText(goalSource), 1200)
    lines.push('> ' + (text || '（最后一条用户消息没有正文）'))
  } else {
    lines.push('（没有找到用户消息，接手的第一个动作是问清要做什么）')
  }
  lines.push('')
  lines.push('## 最近对话（原始摘录，未做归纳）')
  lines.push('')
  if (recent.length === 0) lines.push('（空）')
  for (const item of recent) {
    lines.push('- ' + (item.role === 'user' ? '**用户**' : '助手') + ' `' + clockText(item.time) + '`：' + item.text)
  }
  lines.push('')
  lines.push('## 关键路径（从工具调用参数里提取，最近 ' + paths.length + ' 条）')
  lines.push('')
  if (paths.length === 0) lines.push('（本次会话没有在工具调用里出现绝对路径）')
  for (const item of paths) lines.push('- `' + item + '`')
  lines.push('')
  lines.push('## 已完成')
  lines.push('')
  lines.push('- （按上面的对话记录核对后填写）')
  lines.push('')
  lines.push('## 未完成')
  lines.push('')
  lines.push('- （按上面的对话记录核对后填写）')
  lines.push('')
  lines.push('## 下一步')
  lines.push('')
  lines.push('- （写清接着做什么；这一节是接手会话的行动依据）')
  lines.push('')
  return lines.join('\n')
}

function resolveCwd(ctx, session) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : null
    if (service && typeof service.get === 'function') {
      const dir = service.get(session)
      if (typeof dir === 'string' && dir) return dir
    }
  } catch {
    /* 没有这个服务就用会话头里的目录 */
  }
  const header = session.header || {}
  if (typeof header.cwd === 'string' && header.cwd) return header.cwd
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : null
    if (service && typeof service.defaultDirectory === 'string' && service.defaultDirectory) {
      return service.defaultDirectory
    }
  } catch {
    /* 忽略 */
  }
  return process.cwd()
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function pickSession(ctx, sessionId) {
  const sessions = ctx.sessions
  if (!sessions) throw new Error('宿主没有 sessions 服务')
  if (!sessionId) {
    const all = typeof sessions.list === 'function' ? sessions.list() : []
    const id = all.length === 1 ? all[0].id : null
    if (!id) throw new Error('缺少 sessionId')
    return sessions.get(id)
  }
  const session = sessions.get(sessionId)
  if (!session) throw new Error('找不到会话 ' + sessionId)
  return session
}

async function handleApi(ctx, req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const route = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')
  const cfg = loadConfig()

  if (route === 'config') {
    if (req.method === 'POST') {
      const body = await readBody(req, 64 * 1024)
      return sendJson(res, 200, { ok: true, config: writeConfig(body && body.config) })
    }
    return sendJson(res, 200, { ok: true, config: cfg })
  }

  if (route === 'status') {
    const force = url.searchParams.get('force') === '1'
    let session
    try {
      session = pickSession(ctx, url.searchParams.get('sessionId'))
    } catch (error) {
      return sendJson(res, 404, { ok: false, error: error.message })
    }
    let snapshot
    try {
      snapshot = measureSession(session, cfg, force, resolveContextWindow(ctx, session, cfg))
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message })
    }
    return sendJson(res, 200, {
      ok: true,
      enabled: cfg.enabled,
      showBadge: cfg.showBadge,
      showAlerts: cfg.showAlerts,
      handoffDir: cfg.handoffDir,
      cwd: resolveCwd(ctx, session),
      ...snapshot,
    })
  }

  if (route === 'handoff') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
    let body = {}
    try {
      body = await readBody(req, 64 * 1024)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error.message })
    }
    let session
    try {
      session = pickSession(ctx, body.sessionId)
    } catch (error) {
      return sendJson(res, 404, { ok: false, error: error.message })
    }
    const snapshot = measureSession(session, cfg, true, resolveContextWindow(ctx, session, cfg))
    const cwd = resolveCwd(ctx, session)
    const dir = path.join(cwd, cfg.handoffDir || DEFAULTS.handoffDir)
    const file = path.join(dir, '交接_' + stamp(new Date()) + '.md')
    try {
      mkdirSync(dir, { recursive: true })
      const text = buildHandoffDoc(ctx, session, snapshot, cfg)
      await fsp.writeFile(file, text, 'utf8')
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: '写交接文档失败：' + error.message })
    }
    const prompt =
      '接着上一个会话继续。先读交接文档：' +
      file +
      '\n读完后用一句话复述「要做什么、从哪继续」，等我确认再动手。'
    return sendJson(res, 200, { ok: true, path: file, prompt, bytes: snapshot.bytes, percent: snapshot.percent })
  }

  return sendJson(res, 404, { ok: false, error: '未知接口 ' + route })
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

export const inject = ['webServer', 'sessions']

/**
 * 挂上本地 HTTP 路由。路由本身不产生任何模型调用。
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          try {
            await handleApi(ctx, req, res)
          } catch (error) {
            try {
              sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
            } catch {
              /* 响应已经发完 */
            }
          }
        },
      }),
    'dsh-context-guard: api',
  )
}
