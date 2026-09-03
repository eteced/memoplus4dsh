/**
 * Memory graph visualization: entities + events → one self-contained
 * interactive HTML page (inline JS/CSS, zero external deps, works offline).
 *
 * See docs/m10-visualization.md. The page shows the FULL graph — state
 * history is never deleted, only tagged 历史/最新 (dedup is a retrieval
 * semantic, not a storage one).
 */

import type { Entity, MemoryEvent } from './store.js'
import { statePredicateFamily } from './bridges.js'

interface VizNode {
  id: string
  name: string
  type: string
  count: number
}

interface VizLink {
  source: string
  target: string
  event: string
  time: string
  predicate: string
  stateFam?: string
  latest?: boolean
  details: string
  sourceRef: string
}

/** Escape one JSON payload for safe inlining into a <script> tag. */
function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * Build the self-contained interactive HTML page for the current graph.
 */
export function renderGraphHTML(entities: readonly Entity[], events: readonly MemoryEvent[]): string {
  const nameOf = new Map(entities.map(e => [e.id, e.canonicalName]))
  const nodes: VizNode[] = entities.map(e => ({
    id: e.id,
    name: e.canonicalName,
    type: e.type,
    count: 0,
  }))
  const countOf = new Map<string, number>()

  // Latest-per-(entity, state-family) marking: history stays, tagged 历史.
  const latestByGroup = new Map<string, MemoryEvent>()
  for (const ev of events) {
    const fam = statePredicateFamily(ev.predicate)
    if (fam === undefined || ev.subjectEntityIds.length === 0) continue
    const key = `${ev.subjectEntityIds[0]}|${fam}`
    const cur = latestByGroup.get(key)
    if (cur === undefined || ev.mentionTime > cur.mentionTime) latestByGroup.set(key, ev)
  }

  const links: VizLink[] = []
  for (const ev of events) {
    const subjects = ev.subjectEntityIds
    const targets = ev.objectEntityIds
    for (const s of subjects) countOf.set(s, (countOf.get(s) ?? 0) + 1)
    for (const t of targets) countOf.set(t, (countOf.get(t) ?? 0) + 1)
    const fam = statePredicateFamily(ev.predicate)
    const isLatest = fam !== undefined
      && ev.subjectEntityIds.length > 0
      && latestByGroup.get(`${ev.subjectEntityIds[0]}|${fam}`) === ev
    const timeLabel = ev.timeExpr.length > 0 ? ev.timeExpr : (ev.eventTime ?? ev.mentionTime).slice(0, 10)
    for (const s of subjects) {
      if (targets.length === 0) {
        links.push({
          source: s, target: s, event: ev.normalizedText, time: timeLabel,
          predicate: ev.predicate, stateFam: fam, latest: fam !== undefined ? isLatest : undefined,
          details: ev.details, sourceRef: `${ev.sourceSession}#${ev.sourceTurn}`,
        })
      }
      for (const t of targets) {
        links.push({
          source: s, target: t, event: ev.normalizedText, time: timeLabel,
          predicate: ev.predicate, stateFam: fam, latest: fam !== undefined ? isLatest : undefined,
          details: ev.details, sourceRef: `${ev.sourceSession}#${ev.sourceTurn}`,
        })
      }
    }
  }
  for (const n of nodes) n.count = countOf.get(n.id) ?? 0

  const times = events.map(e => e.mentionTime).sort()
  const stats = {
    entities: entities.length,
    events: events.length,
    from: times[0]?.slice(0, 10) ?? '-',
    to: times[times.length - 1]?.slice(0, 10) ?? '-',
  }

  const dataJson = jsonForHtml({ nodes, links, stats })

  return TEMPLATE_HEAD + dataJson + TEMPLATE_BODY
}

const TEMPLATE_HEAD = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>memoplus4dsh 记忆图</title>
<style>
:root { --bg:#0a0e1a; --card:rgba(255,255,255,.04); --border:rgba(255,255,255,.09); --text:#e6eaf2; --dim:#9aa3b8; --a1:#818cf8; --a2:#22d3ee; --hist:#fbbf24; }
* { margin:0; padding:0; box-sizing:border-box; }
body { background:var(--bg); color:var(--text); font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; height:100vh; display:flex; flex-direction:column; overflow:hidden; }
header { padding:14px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
header h1 { font-size:17px; font-weight:700; }
header h1 b { color:var(--a1); }
.stats { display:flex; gap:16px; font-size:12.5px; color:var(--dim); }
.stats b { color:var(--text); font-variant-numeric:tabular-nums; }
.search { margin-left:auto; }
.search input {
  background:rgba(255,255,255,.06); border:1px solid var(--border); border-radius:8px;
  color:var(--text); padding:7px 12px; font-size:13px; width:220px; outline:none;
}
.search input:focus { border-color:var(--a2); }
main { flex:1; display:flex; min-height:0; }
.graph-wrap { flex:1; position:relative; }
canvas { width:100%; height:100%; display:block; cursor:grab; }
canvas.dragging { cursor:grabbing; }
.legend { position:absolute; left:14px; bottom:12px; font-size:11.5px; color:var(--dim); background:rgba(10,14,26,.8); border:1px solid var(--border); border-radius:8px; padding:8px 12px; }
.legend i { display:inline-block; width:9px; height:9px; border-radius:50%; margin:0 5px 0 10px; }
aside { width:380px; border-left:1px solid var(--border); display:flex; flex-direction:column; min-height:0; }
aside h2 { font-size:14px; padding:14px 16px 10px; border-bottom:1px solid var(--border); }
aside h2 small { color:var(--dim); font-weight:400; margin-left:6px; }
.event-list { flex:1; overflow-y:auto; padding:10px 14px; }
.ev { border:1px solid var(--border); border-radius:9px; padding:10px 12px; margin-bottom:9px; background:var(--card); font-size:12.5px; }
.ev .t { color:var(--a2); font-size:11px; margin-bottom:3px; }
.ev .pred { color:var(--a1); font-size:11px; margin-left:6px; }
.ev .hist { color:var(--hist); font-size:10.5px; margin-left:6px; border:1px solid rgba(251,191,36,.4); border-radius:4px; padding:0 4px; }
.ev .new { color:var(--a2); font-size:10.5px; margin-left:6px; border:1px solid rgba(34,211,238,.4); border-radius:4px; padding:0 4px; }
.ev .dt { color:var(--dim); margin-top:4px; font-size:11.5px; }
.ev .src { color:var(--dim); opacity:.6; font-size:10.5px; margin-top:3px; font-family:Menlo,monospace; }
.ev:hover { border-color:rgba(129,140,248,.4); }
.hint { color:var(--dim); font-size:12.5px; padding:24px 18px; }
@media (max-width: 860px) { main { flex-direction:column; } aside { width:100%; border-left:none; border-top:1px solid var(--border); } }
</style>
</head>
<body>
<header>
  <h1>memoplus<b>4dsh</b> 记忆图</h1>
  <div class="stats" id="stats"></div>
  <div class="search"><input id="q" type="search" placeholder="搜索实体 / 事件…"></div>
</header>
<main>
  <div class="graph-wrap">
    <canvas id="cv"></canvas>
    <div class="legend">
      实体：<i style="background:#818cf8"></i>人 <i style="background:#22d3ee"></i>物 <i style="background:#f472b6"></i>概念
      <br>虚线边+黄标=历史（旧值保留，未被删除） · 拖节点/滚轮缩放/点击看事件
      <br><span id="cap-note" style="display:none"></span>
      <span style="margin-left:6px">图区上限：<select id="cap-sel" style="background:#0e1424;color:#e6eaf2;border:1px solid var(--border);border-radius:5px;font-size:11px">
        <option value="600">600</option><option value="1200" selected>1200</option><option value="2500">2500</option><option value="999999">全部</option>
      </select></span>
    </div>
  </div>
  <aside>
    <h2 id="aside-title">全部事件<small>点击图中节点筛选</small></h2>
    <div class="event-list" id="list"></div>
  </aside>
</main>
<script>
const DATA = `

const TEMPLATE_BODY = `;
(function () {
  // 大图保护：canvas 只画最活跃的前 N 个实体（力布局是 O(n²)），
  // 右侧事件列表始终是全量。N 可通过图例里的控件调整。
  const MAX_CANVAS_NODES = 1200;
  let canvasCap = MAX_CANVAS_NODES;
  const allNodes = DATA.nodes.map(n => ({ ...n }));
  const allLinks = DATA.links.map(l => ({ ...l }));
  let nodes = [], links = [];
  function applyCap() {
    const sorted = [...allNodes].sort((a, b) => b.count - a.count);
    const keep = new Set(sorted.slice(0, canvasCap).map(n => n.id));
    nodes = allNodes.filter(n => keep.has(n.id));
    links = allLinks.filter(l => keep.has(l.source) && keep.has(l.target));
    const note = document.getElementById('cap-note');
    if (allNodes.length > canvasCap) {
      note.textContent = \`图区仅显示最活跃 \${canvasCap} / \${allNodes.length} 实体（力布局上限）；右侧列表与搜索始终覆盖全量。\`;
      note.style.display = '';
    } else {
      note.style.display = 'none';
    }
  }
  let byId = new Map(nodes.map(n => [n.id, n]));
  const TYPE_COLOR = { PERSON: '#818cf8', OBJECT: '#22d3ee', CONCEPT: '#f472b6' };
  document.getElementById('stats').innerHTML =
    \`实体 <b>\${DATA.stats.entities}</b> · 事件 <b>\${DATA.stats.events}</b> · \${DATA.stats.from} ~ \${DATA.stats.to}\`;

  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  let W = 0, H = 0;
  function resize() {
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  addEventListener('resize', resize);

  // ---- 力布局 ----
  function seedPositions() {
    for (const n of nodes) {
      n.x = W / 2 + (Math.random() - 0.5) * 300;
      n.y = H / 2 + (Math.random() - 0.5) * 300;
      n.vx = 0; n.vy = 0;
      n.r = 10 + Math.sqrt(n.count) * 5;
    }
  }
  function physics(iter) {
    for (let k = 0; k < iter; k++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 1;
          const rep = 2600 / d2;
          const d = Math.sqrt(d2);
          dx /= d; dy /= d;
          a.vx += dx * rep; a.vy += dy * rep;
          b.vx -= dx * rep; b.vy -= dy * rep;
        }
      }
      for (const l of links) {
        if (l.source === l.target) continue;
        const a = byId.get(l.source), b = byId.get(l.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 130) * 0.012;
        a.vx += dx / d * f; a.vy += dy / d * f;
        b.vx -= dx / d * f; b.vy -= dy / d * f;
      }
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.0022; n.vy += (H / 2 - n.y) * 0.0022;
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
      }
    }
  }
  // needsDraw 须在 relayout() 首次调用前声明（relayout 会引用它，否则 TDZ 报错）
  let needsDraw = true;
  function relayout() {
    seedPositions();
    byId = new Map(nodes.map(n => [n.id, n]));
    physics(nodes.length > 800 ? 120 : 260);  // 大图少迭代，防卡死
    needsDraw = true;
  }
  applyCap();
  relayout();

  // ---- 视图变换（缩放/平移）与交互 ----
  let scale = 1, ox = 0, oy = 0;
  let dragNode = null, panning = false, lastX = 0, lastY = 0;
  let hoverId = null, selectedId = null, filterText = '';

  const toWorld = (mx, my) => [(mx - ox) / scale, (my - oy) / scale];
  const nodeAt = (mx, my) => {
    const [wx, wy] = toWorld(mx, my);
    let best = null, bd = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d < n.r + 6 && d < bd) { best = n; bd = d; }
    }
    return best;
  };

  cv.addEventListener('mousedown', e => {
    const n = nodeAt(e.offsetX, e.offsetY);
    if (n) { dragNode = n; cv.classList.add('dragging'); }
    else { panning = true; }
    lastX = e.offsetX; lastY = e.offsetY;
  });
  addEventListener('mousemove', e => {
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (dragNode) {
      const [wx, wy] = toWorld(mx, my);
      dragNode.x = wx; dragNode.y = wy;
      dragNode.vx = 0; dragNode.vy = 0;
      needsDraw = true;
    } else if (panning) {
      ox += mx - lastX; oy += my - lastY;
      needsDraw = true;
    } else {
      const n = nodeAt(mx, my);
      const id = n ? n.id : null;
      if (id !== hoverId) { hoverId = id; needsDraw = true; }
    }
    lastX = mx; lastY = my;
  });
  addEventListener('mouseup', e => {
    if (dragNode) {
      selectedId = dragNode.id;
      renderList(selectedId);
    } else if (panning && Math.hypot(e.offsetX - lastX, e.offsetY - lastY) < 4) {
      // 点击空白：取消筛选
    }
    dragNode = null; panning = false;
    cv.classList.remove('dragging');
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 0.9;
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    ox = mx - (mx - ox) * f; oy = my - (my - oy) * f;
    scale = Math.min(4, Math.max(0.2, scale * f));
    needsDraw = true;
  }, { passive: false });
  cv.addEventListener('dblclick', () => { selectedId = null; renderList(null); needsDraw = true; });

  document.getElementById('cap-sel').addEventListener('change', e => {
    canvasCap = parseInt(e.target.value, 10);
    applyCap();
    relayout();
    renderList(selectedId);
  });
  document.getElementById('q').addEventListener('input', e => {
    filterText = e.target.value.trim().toLowerCase();
    needsDraw = true;
    renderList(selectedId);
  });

  // ---- 绘制 ----
  function matches(n) {
    if (!filterText) return true;
    return n.name.toLowerCase().includes(filterText);
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(ox, oy); ctx.scale(scale, scale);

    const dim = id => (hoverId && id !== hoverId &&
      !links.some(l => (l.source === hoverId && l.target === id) || (l.target === hoverId && l.source === id)));
    for (const l of links) {
      const a = byId.get(l.source), b = byId.get(l.target);
      if (!a || !b) continue;
      const isSelf = l.source === l.target;
      const hot = hoverId && (l.source === hoverId || l.target === hoverId);
      let stroke = l.stateFam && l.latest === false ? 'rgba(251,191,36,.5)' : 'rgba(129,140,248,.45)';
      let alpha = hot ? 1 : 0.5;
      if (hoverId && !hot) alpha = 0.1;
      ctx.strokeStyle = stroke;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = hot ? 2.2 : 1.3;
      ctx.setLineDash(l.stateFam && l.latest === false ? [4, 4] : []);
      ctx.beginPath();
      if (isSelf) {
        ctx.arc(a.x + a.r + 8, a.y, 9, 0, Math.PI * 2);
      } else {
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    for (const n of nodes) {
      const c = TYPE_COLOR[n.type] || '#818cf8';
      const dimmed = (hoverId && dim(n.id)) || (filterText && !matches(n));
      const isSel = selectedId === n.id;
      ctx.globalAlpha = dimmed ? 0.18 : 1;
      const grad = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 2.4);
      grad.addColorStop(0, c + '55'); grad.addColorStop(1, c + '00');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c + '30';
      ctx.strokeStyle = isSel ? '#fff' : (hoverId === n.id ? '#fff' : c);
      ctx.lineWidth = isSel ? 2.6 : 1.6;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e6eaf2';
      ctx.font = (n.r > 14 ? '12px' : '10.5px') + ' -apple-system,"PingFang SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(n.name.length > 10 ? n.name.slice(0, 9) + '…' : n.name, n.x, n.y + n.r + 13);
    }
    ctx.restore();
  }

  function loop() {
    if (needsDraw) { draw(); needsDraw = false; }
    requestAnimationFrame(loop);
  }
  loop();

  // ---- 右侧事件列表 ----
  const listEl = document.getElementById('list');
  const titleEl = document.getElementById('aside-title');
  function evHtml(l) {
    const histTag = l.stateFam && l.latest === false ? '<span class="hist">历史</span>' : '';
    const newTag = l.stateFam && l.latest === true ? '<span class="new">最新</span>' : '';
    const who = (byId.get(l.source)?.name ?? '') + (l.source !== l.target ? ' → ' + (byId.get(l.target)?.name ?? '') : '');
    return \`<div class="ev">
      <div class="t">[\${l.time}]\${histTag}\${newTag}<span class="pred">\${l.predicate}</span></div>
      <div>\${l.event}</div>
      \${l.details ? \`<div class="dt">\${l.details}</div>\` : ''}
      <div class="src">\${who} · \${l.sourceRef}</div>
    </div>\`;
  }
  function renderList(entityId) {
    let rows = links;
    if (entityId) rows = rows.filter(l => l.source === entityId || l.target === entityId);
    if (filterText) rows = rows.filter(l =>
      l.event.toLowerCase().includes(filterText) ||
      (byId.get(l.source)?.name ?? '').toLowerCase().includes(filterText) ||
      (byId.get(l.target)?.name ?? '').toLowerCase().includes(filterText));
    rows = [...rows].sort((a, b) => b.time.localeCompare(a.time));
    titleEl.innerHTML = entityId
      ? \`\${byId.get(entityId)?.name ?? ''} 的事件<small>双击空白处返回全部</small>\`
      : '全部事件<small>点击图中节点筛选</small>';
    listEl.innerHTML = rows.length
      ? rows.map(evHtml).join('')
      : '<div class="hint">没有匹配的事件。</div>';
  }
  renderList(null);
})();
</script>
</body>
</html>
`
