/**
 * dsh-context-guard — 客户端半边。
 *
 * 在「已完成 Turn 的动作行」里挂一枚体积徽标（与 dsh-cost-meter 的用量格相邻）。
 * 数据由宿主本地路由给（零 token）；悬停出明细，越阈值出界面气泡，点「交接」写文档 + 预填草稿。
 *
 * 样式只用 DSH 主题令牌（--dsw-alias-* / --dsw-specific-*），亮暗两套主题自动成立。
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-guard',
  factory(require) {
    'use strict'

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const SLOT = 'conversation.chat.assistant-actions'
    const SLOT_ID = 'dsh-context-guard'
    const STYLE_ID = 'dsh-context-guard-style'
    const POLL_MS = 5000
    const STORAGE_PREFIX = 'dsh-context-guard:dismiss:'

    let pluginCtx = null

    const ZH =
      typeof document !== 'undefined' &&
      (/^zh/i.test(document.documentElement.lang || '') ||
        (/^zh/i.test(String((navigator.languages || [])[0] || '')) && !document.documentElement.lang))

    const COPY = ZH
      ? {
          button: '上下文体积',
          title: '上下文体积',
          estTokens: '估算 token',
          line: '判定线',
          messages: '消息 / 回合',
          parts: '构成',
          partTool: '工具结果',
          partAssistant: '助手文本',
          partUser: '用户消息',
          partInjected: '注入提醒',
          warn: '已过提醒线',
          danger: '已过危险线',
          handoff: '交接',
          alertTitle: '建议交接',
          alertBody: '这个会话的体积已经接近发送上限，继续灌内容可能直接发不出去。',
          now: '立即交接',
          later: '稍后',
          busy: '正在写交接文档…',
          done: '交接文档已写好，草稿已预填到新会话：',
          noWorkspace: '没找到当前工作区，交接文档写不了。',
          fail: '出错了：',
          refresh: '刷新数字',
          metaTokens: 'tok 估算',
          metaMessages: '条消息',
          metaTurns: '轮',
          cancel: '取消',
          settings: '设置',
          save: '保存',
          saved: '已保存，数字已刷新',
          fieldShow: '显示体积徽标',
          fieldAlert: '越过阈值时弹提示',
          fieldWarn: '提醒线（%）',
          fieldDanger: '危险线（%）',
          fieldRefresh: '刷新间隔（轮）',
          fieldAuto: '自动（按当前模型的上下文上限）',
        fieldWindow: '上下文窗口（token）',
          fieldBpt: '每个 token 字节数',
          noData: '还没有数字',
          copied: '已复制',
        }
      : {
          button: 'Context size',
          title: 'Context size',
          estTokens: 'Estimated tokens',
          line: 'Send limit',
          messages: 'Messages / turns',
          parts: 'Breakdown',
          partTool: 'Tool results',
          partAssistant: 'Assistant text',
          partUser: 'User messages',
          partInjected: 'Injected reminders',
          warn: 'Above warn line',
          danger: 'Above danger line',
          handoff: 'Hand off',
          alertTitle: 'Consider handing off',
          alertBody: 'This conversation is close to the send limit. More content may fail to send at all.',
          now: 'Hand off now',
          later: 'Later',
          busy: 'Writing the handoff document…',
          done: 'Handoff document written and the draft is prefilled in a new session: ',
          noWorkspace: 'No workspace found, cannot write the handoff document.',
          fail: 'Failed: ',
          refresh: 'Refresh',
          metaTokens: 'est. tokens',
          metaMessages: 'messages',
          metaTurns: 'turns',
          cancel: 'Cancel',
          settings: 'Settings',
          save: 'Save',
          saved: 'Saved; numbers refreshed',
          fieldShow: 'Show the size badge',
          fieldAlert: 'Show the threshold notice',
          fieldWarn: 'Warn line (%)',
          fieldDanger: 'Danger line (%)',
          fieldRefresh: 'Refresh every (turns)',
          fieldAuto: 'Auto (use the model limit)',
        fieldWindow: 'Context window (tokens)',
          fieldBpt: 'Bytes per token',
          noData: 'No numbers yet',
          copied: 'Copied',
        }

    /* ---------------- 数据 ---------------- */

    function apiUrl(route) {
      const base = typeof document !== 'undefined' ? document.baseURI : 'http://127.0.0.1/'
      return new URL('context-guard/api/' + route, base).href
    }

    async function getJson(route) {
      const response = await fetch(apiUrl(route), { cache: 'no-store' })
      const body = await response.json().catch(() => null)
      if (!body || body.ok !== true) {
        throw new Error((body && body.error) || 'HTTP ' + response.status)
      }
      return body
    }

    async function postJson(route, payload) {
      const response = await fetch(apiUrl(route), {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      const body = await response.json().catch(() => null)
      if (!body || body.ok !== true) {
        throw new Error((body && body.error) || 'HTTP ' + response.status)
      }
      return body
    }

    /* ---------------- 数字格式 ---------------- */

    function sizeUnit(bytes) {
      const mb = Math.abs(bytes) / 1e6
      return mb >= 1024 ? 'GB' : 'MB'
    }

    function sizeNumber(bytes) {
      const mb = Math.abs(bytes) / 1e6
      if (mb >= 1024) return (mb / 1024).toFixed(1)
      if (mb >= 100) return mb.toFixed(0)
      return mb.toFixed(1)
    }

    function sizeText(bytes) {
      return sizeNumber(bytes) + ' ' + sizeUnit(bytes)
    }

    function shareText(value, total) {
      if (!(total > 0)) return '0%'
      return Math.round((value / total) * 100) + '%'
    }

    /* ---------------- 提醒气泡的「稍后」 ---------------- */

    function dismissalKey(sessionId, level) {
      return STORAGE_PREFIX + String(sessionId) + ':' + String(level)
    }

    function isDismissed(sessionId, level) {
      try {
        return window.sessionStorage.getItem(dismissalKey(sessionId, level)) === '1'
      } catch {
        return false
      }
    }

    function dismiss(sessionId, level) {
      try {
        window.sessionStorage.setItem(dismissalKey(sessionId, level), '1')
      } catch {
        /* 隐私模式下 sessionStorage 会抛，忽略即可 */
      }
    }

    /* ---------------- 轻提示 ---------------- */

    function showToast(text) {
      if (typeof document === 'undefined') return
      let node = document.querySelector('.cg-toast')
      if (!node) {
        node = document.createElement('div')
        node.className = 'cg-toast'
        document.body.appendChild(node)
      }
      node.textContent = text
      node.classList.remove('cg-toast-out')
      clearTimeout(node.__cgTimer)
      node.__cgTimer = setTimeout(() => {
        node.classList.add('cg-toast-out')
        setTimeout(() => node.remove(), 400)
      }, 7000)
    }

    /* ---------------- 样式（只用主题令牌） ---------------- */

    const CSS = `
.cg-badge{display:inline-flex;align-items:center;gap:0;height:20px;padding:0 7px;margin-left:2px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);
  font-size:11px;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:.01em;cursor:pointer;
  transition:background .12s ease,color .12s ease,border-color .12s ease;white-space:nowrap}
.cg-badge:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cg-badge:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.cg-badge.is-warn{color:var(--dsw-alias-state-warn-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.cg-badge.is-danger{color:var(--dsw-alias-state-error-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}
.cg-badge.is-muted{opacity:.55}
.cg-badge .cg-num{font-weight:600}
.cg-badge .cg-sep{margin:0 3px;opacity:.55}
.cg-badge .cg-den{opacity:.75}
.cg-badge .cg-unit{margin-left:2px;font-size:10px;opacity:.75}

.cg-panel{position:fixed;z-index:2147483000;width:320px;box-sizing:border-box;padding:13px 14px 12px;border-radius:12px;
  background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1)));
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);
  box-shadow:0 16px 40px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.14);
  font-size:12px;line-height:1.5;-webkit-font-smoothing:antialiased}
.cg-panel.is-ghost{pointer-events:none}
.cg-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-2px -2px 2px 0}
.cg-panel-title{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.cg-head-actions{display:flex;align-items:center;gap:1px}
.cg-icon{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;
  width:24px;height:24px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;
  font-size:13px;line-height:1;transition:background .12s ease,color .12s ease}
.cg-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cg-hero{margin:2px 0 10px}
.cg-hero-row{display:flex;align-items:baseline;gap:7px}
.cg-big-num.is-warn{color:var(--dsw-alias-state-warn-primary)}
.cg-big-num.is-danger{color:var(--dsw-alias-state-error-primary)}
.cg-big-num{font-size:26px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15}
.cg-big-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.cg-meter{position:relative;height:4px;margin-top:8px;border-radius:999px;background:var(--dsw-alias-fill-l2);overflow:hidden}
.cg-meter-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);
  transition:width .3s ease,background .2s ease}
.cg-meter-fill.is-warn{background:var(--dsw-alias-state-warn-primary)}
.cg-meter-fill.is-danger{background:var(--dsw-alias-state-error-primary)}
.cg-meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin:0 0 12px;padding-bottom:11px;
  border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;
  font-variant-numeric:tabular-nums}
.cg-meta b{font-weight:600;color:var(--dsw-alias-label-secondary)}
.cg-section-title{margin:0 0 7px;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dsw-alias-label-tertiary)}
.cg-bar{display:grid;grid-template-columns:62px 1fr 76px;align-items:center;gap:9px;margin-bottom:6px}
.cg-bar-name{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cg-bar-track{height:6px;border-radius:999px;background:var(--dsw-alias-fill-l2);overflow:hidden}
.cg-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);
  transition:width .3s ease}
.cg-bar-fill.p-tool{background:var(--dsw-alias-brand-primary)}
.cg-bar-fill.p-assistant{background:var(--dsw-alias-state-success-primary)}
.cg-bar-fill.p-user{background:var(--dsw-alias-state-warn-primary)}
.cg-bar-fill.p-injected{background:var(--dsw-alias-label-tertiary)}
.cg-bar-value{text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px}
.cg-actions{display:flex;gap:7px;margin-top:13px}
.cg-btn{appearance:none;flex:1;height:30px;border-radius:8px;cursor:pointer;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);
  transition:background .12s ease,filter .12s ease}
.cg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cg-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary-inverted);font-weight:600}
.cg-btn.primary:hover{filter:brightness(1.06)}
.cg-btn[disabled]{opacity:.5;cursor:default}
.cg-form{display:grid;grid-template-columns:1fr 92px;gap:8px 10px;align-items:center;margin:6px 0 4px}
.cg-form label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.cg-check-wide{grid-column:1 / -1}
.cg-form input:disabled{opacity:.5;cursor:not-allowed}
.cg-form input[type=number]{width:100%;box-sizing:border-box;height:26px;padding:0 8px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-variant-numeric:tabular-nums}
.cg-form input[type=number]:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.cg-check{display:flex;align-items:center;gap:8px;grid-column:1 / -1;font-size:12px;color:var(--dsw-alias-label-primary)}

.cg-alert{position:fixed;z-index:2147483001;width:296px;box-sizing:border-box;padding:11px 12px;border-radius:10px;
  background:var(--dsw-specific-tip,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1)));
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);
  box-shadow:0 12px 32px rgba(0,0,0,.28);font-size:12px;line-height:1.55}
.cg-alert.is-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-border-l2))}
.cg-alert-head{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:4px}
.cg-alert-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none}
.cg-alert.is-danger .cg-alert-dot{background:var(--dsw-alias-state-error-primary)}
.cg-alert-body{color:var(--dsw-alias-label-secondary)}
.cg-alert-meta{margin-top:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.cg-alert-actions{display:flex;gap:6px;margin-top:9px}

.cg-toast{position:fixed;z-index:2147483002;left:50%;bottom:32px;transform:translateX(-50%);max-width:min(680px,84vw);
  padding:9px 13px;border-radius:9px;font-size:12px;line-height:1.5;
  background:var(--dsw-specific-tip,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1)));
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);
  box-shadow:0 10px 26px rgba(0,0,0,.26);word-break:break-all;transition:opacity .35s ease,transform .35s ease}
.cg-toast-out{opacity:0;transform:translateX(-50%) translateY(6px)}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ---------------- 构成条 ---------------- */

    function Breakdown(props) {
      const data = props.data
      const total = Math.max(1, data.bytes)
      const rows = [
        ['tool', COPY.partTool],
        ['assistant', COPY.partAssistant],
        ['user', COPY.partUser],
        ['injected', COPY.partInjected],
      ]
      return h(
        'div',
        null,
        rows.map(([key, label]) => {
          const value = (data.parts && data.parts[key]) || 0
          return h(
            'div',
            { className: 'cg-bar', key },
            h('div', { className: 'cg-bar-name' }, label),
            h(
              'div',
              { className: 'cg-bar-track' },
              h('div', { className: 'cg-bar-fill p-' + key, style: { width: shareText(value, total) } })
            ),
            h('div', { className: 'cg-bar-value' }, sizeText(value) + ' · ' + shareText(value, total))
          )
        })
      )
    }

    /* ---------------- 明细面板 ---------------- */

    function Panel(props) {
      const data = props.data
      const level = props.level || ''
      if (!data) {
        return h('div', { className: 'cg-panel' + (props.interactive ? '' : ' is-ghost'), style: props.style }, COPY.noData)
      }
      const width = Math.max(1.5, Math.min(100, data.percent))
      return h(
        'div',
        { className: 'cg-panel' + (props.interactive ? '' : ' is-ghost'), style: props.style },
        h(
          'div',
          { className: 'cg-panel-head' },
          h('div', { className: 'cg-panel-title' }, COPY.title),
          props.interactive
            ? h(
                'div',
                { className: 'cg-head-actions' },
                h('button', { className: 'cg-icon', onClick: props.onSettings, title: COPY.settings }, '\u2699'),
                h('button', { className: 'cg-icon', onClick: props.onClose, title: 'Esc' }, '\u00d7')
              )
            : null
        ),
        h(
          'div',
          { className: 'cg-hero' },
          h(
            'div',
            { className: 'cg-hero-row' },
            h('span', { className: 'cg-big-num' + (level ? ' is-' + level : '') }, data.percent.toFixed(1) + '%'),
            h('span', { className: 'cg-big-sub' }, sizeText(data.bytes) + ' / ' + sizeText(data.limit))
          ),
          h('div', { className: 'cg-meter' }, h('div', { className: 'cg-meter-fill' + (level ? ' is-' + level : ''), style: { width: width + '%' } }))
        ),
        h(
          'div',
          { className: 'cg-meta' },
          h('span', null, h('b', null, data.estTokens.toLocaleString()), ' ' + COPY.metaTokens),
          h('span', null, h('b', null, String(data.messages)), ' ' + COPY.metaMessages),
          h('span', null, h('b', null, String(data.turns)), ' ' + COPY.metaTurns)
        ),
        h('div', { className: 'cg-section-title' }, COPY.parts),
        h(Breakdown, { data }),
        props.interactive
          ? h(
              'div',
              { className: 'cg-actions' },
              h('button', { className: 'cg-btn primary', onClick: props.onHandoff, disabled: props.busy }, COPY.handoff),
              h('button', { className: 'cg-btn', onClick: props.onRefresh, disabled: props.busy }, COPY.refresh)
            )
          : null
      )
    }

    /* ---------------- 设置（改完写回 config.json） ---------------- */

    function Settings(props) {
      const data = props.data
      const [form, setForm] = React.useState(() => ({
        showBadge: data.showBadge !== false,
        showAlerts: data.showAlerts !== false,
        warn: Math.round((data.warnRatio || 0.6) * 100),
        danger: Math.round((data.dangerRatio || 0.85) * 100),
        refreshEveryTurns: data.refreshEveryTurns || 25,
        autoLimit: data.autoLimit !== false,
        contextWindow: data.contextWindow || 750000,
        bytesPerToken: data.bytesPerToken || 7.5,
      }))
      const [saving, setSaving] = React.useState(false)
      const number = (key) => (event) => {
        const value = Number(event.target.value)
        setForm((current) => ({ ...current, [key]: Number.isFinite(value) ? value : current[key] }))
      }
      const save = async () => {
        setSaving(true)
        try {
          await props.onSave({
            showBadge: !!form.showBadge,
            showAlerts: !!form.showAlerts,
            warnRatio: Math.min(0.99, Math.max(0.01, form.warn / 100)),
            dangerRatio: Math.min(1, Math.max(0.02, form.danger / 100)),
            refreshEveryTurns: Math.max(1, Math.round(form.refreshEveryTurns) || 25),
            autoLimit: !!form.autoLimit,
            contextWindow: Math.max(1000, Math.round(form.contextWindow) || 750000),
            bytesPerToken: Math.max(0.5, Number(form.bytesPerToken) || 7.5),
          })
          showToast(COPY.saved)
          props.onClose()
        } catch (cause) {
          showToast(COPY.fail + (cause && cause.message ? cause.message : String(cause)))
        } finally {
          setSaving(false)
        }
      }
      return h(
        'div',
        { className: 'cg-panel', style: props.style, onPointerDown: (event) => event.stopPropagation() },
        h(
          'div',
          { className: 'cg-panel-head' },
          h('div', { className: 'cg-panel-title' }, COPY.settings),
          h('button', { className: 'cg-icon', onClick: props.onClose }, '\u00d7')
        ),
        h(
          'div',
          { className: 'cg-form' },
          h('label', { className: 'cg-check' }, h('input', { type: 'checkbox', checked: !!form.showBadge, onChange: (event) => setForm((c) => ({ ...c, showBadge: event.target.checked })) }), COPY.fieldShow),
          h('label', { className: 'cg-check' }, h('input', { type: 'checkbox', checked: !!form.showAlerts, onChange: (event) => setForm((c) => ({ ...c, showAlerts: event.target.checked })) }), COPY.fieldAlert),
          h('label', null, COPY.fieldWarn),
          h('input', { type: 'number', min: 1, max: 99, value: form.warn, onChange: number('warn') }),
          h('label', null, COPY.fieldDanger),
          h('input', { type: 'number', min: 2, max: 100, value: form.danger, onChange: number('danger') }),
          h('label', null, COPY.fieldRefresh),
          h('input', { type: 'number', min: 1, max: 500, value: form.refreshEveryTurns, onChange: number('refreshEveryTurns') }),
          h(
            'label',
            { className: 'cg-check cg-check-wide' },
            h('input', {
              type: 'checkbox',
              checked: !!form.autoLimit,
              onChange: (event) => setForm((c) => ({ ...c, autoLimit: event.target.checked })),
            }),
            COPY.fieldAuto
          ),
          h('label', null, COPY.fieldWindow),
          h('input', {
            type: 'number',
            min: 1000,
            step: 1000,
            value: form.contextWindow,
            disabled: !!form.autoLimit,
            onChange: number('contextWindow'),
          }),
          h('label', null, COPY.fieldBpt),
          h('input', { type: 'number', min: 0.5, step: 0.5, value: form.bytesPerToken, onChange: number('bytesPerToken') })
        ),
        h(
          'div',
          { className: 'cg-actions' },
          h('button', { className: 'cg-btn primary', onClick: save, disabled: saving }, saving ? COPY.busy : COPY.save),
          h('button', { className: 'cg-btn', onClick: props.onClose }, COPY.cancel)
        )
      )
    }

    /* ---------------- 阈值气泡 ---------------- */

    function Alert(props) {
      const data = props.data
      const danger = props.level === 'danger'
      return h(
        'div',
        { className: 'cg-alert' + (danger ? ' is-danger' : ''), style: props.style },
        h(
          'div',
          { className: 'cg-alert-head' },
          h('span', { className: 'cg-alert-dot' }),
          COPY.alertTitle
        ),
        h('div', { className: 'cg-alert-body' }, COPY.alertBody),
        h('div', { className: 'cg-alert-meta' }, data.percent.toFixed(1) + '% · ' + sizeText(data.bytes) + ' / ' + sizeText(data.limit)),
        h(
          'div',
          { className: 'cg-alert-actions' },
          h('button', { className: 'cg-btn primary', onClick: props.onHandoff, disabled: props.busy }, COPY.now),
          h('button', { className: 'cg-btn', onClick: props.onLater }, COPY.later)
        )
      )
    }

    /* ---------------- 徽标本体 ---------------- */

    function Badge(props) {
      const sessionId = props.sessionId
      const messageId = props.messageId ? String(props.messageId) : null
      const turnSeq = typeof props.seq === 'number' ? props.seq : null
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [hover, setHover] = React.useState(false)
      const [pinned, setPinned] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [rect, setRect] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const [settingsOpen, setSettingsOpen] = React.useState(false)

      const buttonRef = React.useRef(null)
      const hideTimer = React.useRef(null)

      const load = React.useCallback(
        async (force) => {
          if (!sessionId) return
          try {
            const body = await getJson(
              'status?sessionId=' + encodeURIComponent(String(sessionId)) + (force ? '&force=1' : '')
            )
            setData(body)
            setError(null)
          } catch (cause) {
            setError(cause && cause.message ? cause.message : String(cause))
          }
        },
        [sessionId]
      )

      React.useEffect(() => {
        load(true)
        const timer = setInterval(() => {
          if (!document.hidden) load(false)
        }, POLL_MS)
        const onVisible = () => {
          if (!document.hidden) load(true)
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load, tick])

      React.useEffect(() => {
        if (!pinned) return
        const onKey = (event) => {
          if (event.key === 'Escape') setPinned(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [pinned])

      /* 点面板外面（会话区域）就收起；点在面板或徽标里不算。 */
      React.useEffect(() => {
        if (!pinned) return
        const onDown = (event) => {
          const target = event.target
          if (!target || typeof target.closest !== 'function') return
          if (target.closest('.cg-panel') || target.closest('.cg-badge') || target.closest('.cg-alert')) return
          setPinned(false)
          setSettingsOpen(false)
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [pinned])

      const capture = React.useCallback(() => {
        const node = buttonRef.current
        if (!node) return
        const box = node.getBoundingClientRect()
        setRect({ top: box.top, bottom: box.bottom, left: box.left, right: box.right })
      }, [])

      const doHandoff = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        try {
          const result = await postJson('handoff', { sessionId })
          const uiWorkspace = pluginCtx && pluginCtx.get ? pluginCtx.get('uiWorkspace') : null
          if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
            /* 只准备草稿，不做任何导航：紧跟着跳转会把这次草稿一起取消。 */
            uiWorkspace.startSession(undefined, { prompt: result.prompt, whenDraftExists: 'replace' })
            showToast(COPY.done + result.path)
          } else {
            showToast(COPY.fail + 'uiWorkspace')
          }
          setPinned(false)
          setHover(false)
          load(true)
        } catch (cause) {
          showToast(COPY.fail + (cause && cause.message ? cause.message : String(cause)))
        } finally {
          setBusy(false)
        }
      }, [busy, sessionId, load])

      const saveSettings = React.useCallback(
        async (patch) => {
          await postJson('config', { config: patch })
          await load(true)
          setTick((value) => value + 1)
        },
        [load]
      )

      /* 只挂在最后一个助手消息的动作行上，避免一轮多步时冒出好几枚。 */
      const lastId = data && (data.lastTurnMessageId || data.lastAssistantMessageId) ? String(data.lastTurnMessageId || data.lastAssistantMessageId) : null
      const visible = !messageId || !lastId || messageId === lastId

      if (!sessionId) return null
      if (data && (data.enabled === false || data.showBadge === false)) return null
      if (!visible) return null

      const ratio = data ? data.ratio : 0
      const level = !data
        ? ''
        : ratio >= (data.dangerRatio || 0.85)
          ? 'danger'
          : ratio >= (data.warnRatio || 0.6)
            ? 'warn'
            : ''
      const showAlert = !!data && !!level && data.showAlerts !== false && !isDismissed(sessionId, level) && !pinned && !hover

      const style = {}
      const panelWidth = 320
      const alertWidth = 296
      if (rect) {
        style.panel = {
          left: Math.max(8, Math.min(rect.left - 40, window.innerWidth - panelWidth - 12)),
          top: rect.bottom + 6,
        }
        style.alert = {
          left: Math.max(8, Math.min(rect.left - 60, window.innerWidth - alertWidth - 12)),
          top: rect.bottom + 6,
        }
        if (rect.bottom + 340 > window.innerHeight) {
          style.panel.top = Math.max(8, rect.top - 330)
          style.alert.top = Math.max(8, rect.top - 160)
        }
      }

      const onClick = () => {
        capture()
        setSettingsOpen(false)
        setPinned((value) => !value)
      }

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            ref: buttonRef,
            type: 'button',
            className: 'cg-badge' + (level ? ' is-' + level : '') + (data ? '' : ' is-muted'),
            title: COPY.button + (data ? ' · ' + data.percent.toFixed(1) + '%' : ''),
            onClick,
            onPointerEnter: () => {
              capture()
              clearTimeout(hideTimer.current)
              setHover(true)
            },
            onPointerLeave: () => {
              hideTimer.current = setTimeout(() => setHover(false), 180)
            },
          },
          data
            ? [
                h('span', { className: 'cg-num', key: 'n' }, sizeNumber(data.bytes)),
                h('span', { className: 'cg-sep', key: 's' }, '/'),
                h('span', { className: 'cg-den', key: 'd' }, sizeNumber(data.limit)),
                h('span', { className: 'cg-unit', key: 'u' }, sizeUnit(data.bytes)),
              ]
            : h('span', { className: 'cg-num' }, error ? '—' : '…')
        ),
        data && hover && !pinned && rect
          ? ReactDOM.createPortal(
              h(
                'div',
                {
                  onPointerEnter: () => clearTimeout(hideTimer.current),
                  onPointerLeave: () => (hideTimer.current = setTimeout(() => setHover(false), 180)),
                },
                h(Panel, { data, level, style: style.panel, interactive: false })
              ),
              document.body
            )
          : null,
        data && pinned && rect
          ? ReactDOM.createPortal(
              h(Panel, {
                data,
                style: style.panel,
                level,
                interactive: true,
                busy,
                onClose: () => {
                  setPinned(false)
                  setSettingsOpen(false)
                },
                onSettings: () => setSettingsOpen(true),
                onHandoff: doHandoff,
                onRefresh: () => {
                  setTick((value) => value + 1)
                  load(true)
                },
              }),
              document.body
            )
          : null,
        data && pinned && settingsOpen && rect
          ? ReactDOM.createPortal(
              h(Settings, {
                data,
                style: style.panel,
                onSave: saveSettings,
                onClose: () => setSettingsOpen(false),
              }),
              document.body
            )
          : null,
        data && showAlert && rect
          ? ReactDOM.createPortal(
              h(Alert, {
                data,
                level,
                style: style.alert,
                busy,
                onHandoff: doHandoff,
                onLater: () => {
                  dismiss(sessionId, level)
                  setTick((value) => value + 1)
                },
              }),
              document.body
            )
          : null
      )
    }

    /* ---------------- 注册 ---------------- */

    function apply(ctx) {
      pluginCtx = ctx
      ensureStyle()
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register({ name: SLOT, id: SLOT_ID, order: 30, label: () => COPY.button }, Badge)
      )
    }

    return { inject: ['slots'], apply }
  },
})
