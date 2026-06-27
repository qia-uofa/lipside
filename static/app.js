/* ═══════════════════════════════════════════════════════════════════
   LIPSIDE app.js  –  V3
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── helpers ──────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);


/* ── In-app dialog helpers (replace native prompt/alert/confirm) ── */
/* appPromptExt — like appPrompt but appends an extension <select> below the input.
   Resolves to { name, ext } or null if cancelled. */
function appPromptExt(message, defaultVal = '', exts = ['md', 'py', 'sh']) {
  return new Promise(resolve => {
    $('app-prompt-title').textContent = message;
    const inp = $('app-prompt-input');
    inp.value = defaultVal;

    // Inject extension selector
    const sel = document.createElement('select');
    sel.id = 'app-prompt-ext';
    sel.style.cssText = 'margin-top:8px;width:100%;box-sizing:border-box;background:var(--bg0);color:var(--fg);border:1px solid var(--border);border-radius:3px;padding:4px 8px;font-size:13px;outline:none;';
    exts.forEach(e => { const o = document.createElement('option'); o.value = o.textContent = e; sel.appendChild(o); });
    inp.parentNode.insertBefore(sel, inp.nextSibling);

    $('app-prompt-modal').classList.remove('hidden');
    inp.focus(); inp.select();

    const cleanup = () => { sel.remove(); $('app-prompt-modal').classList.add('hidden'); ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); inp.removeEventListener('keydown', onKey); };
    const finish = val => { cleanup(); resolve(val); };
    const onOk     = () => finish(inp.value.trim() ? { name: inp.value.trim(), ext: sel.value } : null);
    const onCancel = () => finish(null);
    const onKey    = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    const ok = $('app-prompt-ok'), cancel = $('app-prompt-cancel');
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    inp.addEventListener('keydown', onKey);
  });
}

function appPrompt(message, defaultVal = '') {
  return new Promise(resolve => {
    $('app-prompt-title').textContent = message;
    const inp = $('app-prompt-input');
    inp.value = defaultVal;
    $('app-prompt-modal').classList.remove('hidden');
    inp.focus(); inp.select();
    const finish = val => {
      $('app-prompt-modal').classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      inp.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk     = () => finish(inp.value.trim() || null);
    const onCancel = () => finish(null);
    const onKey    = e => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    const ok = $('app-prompt-ok'), cancel = $('app-prompt-cancel');
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    inp.addEventListener('keydown', onKey);
  });
}

function appAlert(message) {
  return new Promise(resolve => {
    $('app-alert-msg').textContent = message;
    $('app-alert-modal').classList.remove('hidden');
    const ok = $('app-alert-ok');
    const finish = () => {
      $('app-alert-modal').classList.add('hidden');
      ok.removeEventListener('click', finish);
      resolve();
    };
    ok.addEventListener('click', finish);
  });
}

function appConfirm(message) {
  return new Promise(resolve => {
    $('app-confirm-msg').textContent = message;
    $('app-confirm-modal').classList.remove('hidden');
    const ok = $('app-confirm-ok'), cancel = $('app-confirm-cancel');
    const finish = val => {
      $('app-confirm-modal').classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(val);
    };
    const onOk     = () => finish(true);
    const onCancel = () => finish(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};

/* ── state ────────────────────────────────────────────────────────── */
const state = {
  workspace: '',
  pipelines: [],       // array of pipeline name strings
  pipelineObjects: [], // full objects [{name, stages}] from the API
  currentPipeline: null,
  viewMode: 'graph',
  sidebarVisible: true,
  previewVisible: false,
  // opened tabs: [{key, label, pipeline, stage, view, path, modified}]
  tabs: [],
  activeTab: null,
};

/* ── tree state (preserved across view-mode changes) ─────────────── */
const treeCollapsed  = {};  // `${view}::${stageName}` → bool

const subdirExpanded = {};  // `${view}::${stage}::${relPath}` → bool

/* ── Focused sidebar item (for F2 / Delete shortcuts) ────────────── */
// { type: 'file'|'dir'|'stage', stageName, path, view, isDir }
let _focusedCtx = null;

/* ── Tab drag state ──────────────────────────────────────────────── */
let _dragSrcIdx = null;

/* ── CodeMirror editor ────────────────────────────────────────────── */
let cm = null;
let cmPath = null;
let cmDirty = false;
let _cmLoading = false;  // true while setValue() is running; suppresses spurious dirty flag



/* ═══════════════════════════════════════════════════════════════════
   BUILD OUTPUT PANEL
   ═══════════════════════════════════════════════════════════════════ */
let _outputVisible = true;
let _buildWs = null;       // currently active build WebSocket
let _buildQueue = [];      // [{stageName, script}] pending
let _buildRunning = false; // is a build currently executing

function _stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function _setStatus(msg, cls) {
  const s = $('build-status');
  s.textContent = msg;
  s.className = cls || '';
}

function _ensureOutputVisible() {
  if (!_outputVisible) {
    _outputVisible = true;
    $('app').classList.remove('output-hidden');
    $('btn-toggle-output').textContent = '▼';
    $('btn-toggle-output').title = 'Hide output';
  }
  // Always remove any stale direct-hidden class (legacy)
  $('build-output-container').classList.remove('hidden');
}

async function runBuild(stageName, script) {
  if (!script) script = 'main';
  if (!state.currentPipeline) return;
  const unsaved = state.tabs.filter(t => t.modified);
  if (unsaved.length > 0) {
    const names = unsaved.map(t => t.label).join(', ');
    const ok = await appConfirm(`Save unsaved files before building?\n\n${names}`);
    if (!ok) return;
    await saveAllTabs();
  }
  _buildQueue.push({ pipeline: state.currentPipeline, stageName, script });
  _renderBuildQueue();
  _processNextBuild();
}

function _renderBuildQueue() {
  const panel = $('build-queue-panel');
  const list  = $('build-queue-list');
  if (_buildQueue.length === 0 && !_buildRunning) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  list.innerHTML = '';
  _buildQueue.forEach((item, idx) => {
    const div = el('div', 'bq-item' + (idx === 0 && _buildRunning ? ' bq-running' : ''));
    const label = item.script
      ? `${item.stageName}/${item.script}`
      : `${item.stageName}/*`;
    div.textContent = label;
    list.appendChild(div);
  });
}

/* Scan open build-view tabs for the building stage to find TARGET= values.
   Returns a Set of target stage names found in currently-open build files. */
function _getTargetStagesFromTabs(pipeline, stageName) {
  const targets = new Set();
  for (const tab of state.tabs) {
    if (tab.pipeline !== pipeline || tab.stage !== stageName || tab.view !== 'build') continue;
    const content = tab.content || '';
    const m = content.match(/```env\s+([\s\S]*?)```/);
    if (m) {
      const tm = m[1].match(/^TARGET\s*=\s*(.+)$/m);
      if (tm) targets.add(tm[1].trim());
    }
  }
  return targets;
}

function _lockStageTabs(pipeline, stageName) {
  const targetStages = _getTargetStagesFromTabs(pipeline, stageName);
  state.tabs.forEach(tab => {
    if (tab.pipeline !== pipeline || tab.readonly || tab.view !== 'repo') return;
    if (tab.stage === stageName || targetStages.has(tab.stage)) {
      tab._buildLocked = true;
    }
  });
  renderTabBar();
  // If the active tab just got locked, flip the live editor to read-only
  if (state.activeTab !== null) {
    const t = state.tabs[state.activeTab];
    if (t && t._buildLocked && cm) cm.setOption('readOnly', true);
  }
}

async function _unlockAndRefreshStageTabs(pipeline, stageName) {
  // Unlock all tabs locked by this build (source stage + any target stages)
  const locked = state.tabs.filter(t => t._buildLocked && t.pipeline === pipeline);
  await Promise.all(locked.map(async tab => {
    try {
      const res = await fetch(
        `/api/file/${encodeURIComponent(tab.pipeline)}/${encodeURIComponent(tab.stage)}/${tab.view}?path=${encodeURIComponent(tab.path)}`
      );
      if (res.ok) {
        const data = await res.json();
        tab.content = data.content || '';
        tab.modified = false;
      }
    } catch {}
    tab._buildLocked = false;
  }));
  renderTabBar();
  // If the active tab was just unlocked, refresh CM in-place.
  // Preserve cursor/scroll so the editor feels stable after unlock.
  if (state.activeTab !== null && cm) {
    const t = state.tabs[state.activeTab];
    if (t && locked.includes(t)) {
      const cursor = cm.getCursor();
      const scroll = cm.getScrollInfo();
      _cmLoading = true;
      if (cm.getValue() !== t.content) {
        cm.setValue(t.content);
      }
      _cmLoading = false;
      cm.setOption('readOnly', false);
      cm.refresh();
      cm.setCursor(cursor);
      cm.scrollTo(scroll.left, scroll.top);
    }
  }
}

function _processNextBuild() {
  if (_buildRunning || _buildQueue.length === 0) return;
  _buildRunning = true;

  const { pipeline, stageName, script } = _buildQueue[0];
  _renderBuildQueue();
  expandStage(stageName);
  _ensureOutputVisible();
  _lockStageTabs(pipeline, stageName);

  const out = $('build-output');
  out.textContent = '';
  const stagePath = `./${pipeline}/${stageName}`;
  const cmd = `lips build ${script} ${stagePath}`.replace(/\s+/g, ' ').trim();
  out.textContent += `$ ${cmd}\n`;
  _setStatus(`Running: ${cmd}`, 'running');

  const params = new URLSearchParams({ pipeline, stage: stageName });
  if (script) params.set('script', script);

  const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsScheme}//${location.host}/ws/build?${params}`);
  _buildWs = ws;

  ws.onmessage = e => {
    const text = typeof e.data === 'string' ? e.data : '';
    try {
      const evt = JSON.parse(text);
      if (evt.event === 'done') {
        const ok = evt.exit_code === 0;
        out.textContent += `\n[exit ${evt.exit_code}]\n`;
        _setStatus(`${cmd} — exit ${evt.exit_code}`, ok ? 'success' : 'error');
        if (ok) {
          renderTree().then(() => expandStage(stageName));
        } else {
          ws._exitedWithError = true;  // signal onclose to drain the queue
        }
        return;
      }
      if (evt.event === 'error') {
        out.textContent += `\n[error: ${evt.message}]\n`;
        _setStatus(`Error: ${evt.message}`, 'error');
        ws._exitedWithError = true;
        return;
      }
    } catch {}
    out.textContent += _stripAnsi(text);
    out.scrollTop = out.scrollHeight;
  };

  ws.onerror = () => {
    out.textContent += '\n[connection error]\n';
    _setStatus('Connection error', 'error');
    ws._exitedWithError = true;
  };
  ws.onclose = () => {
    if (_buildWs === ws) _buildWs = null;
    _buildRunning = false;
    _buildQueue.shift();  // remove completed item
    if (ws._exitedWithError && _buildQueue.length > 0) {
      const skipped = _buildQueue.length;
      _buildQueue.length = 0;
      out.textContent += `\n[queue cleared — ${skipped} build(s) skipped due to error]\n`;
    }
    _renderBuildQueue();
    _unlockAndRefreshStageTabs(pipeline, stageName).then(() => _processNextBuild());
  };
}

/* ═══════════════════════════════════════════════════════════════════
   RESIZE HANDLES
   ═══════════════════════════════════════════════════════════════════ */
function initResize(handleEl, getSize, setSize, vertical) {
  handleEl.addEventListener('mousedown', e => {
    handleEl.classList.add('dragging');
    const startCoord = vertical ? e.clientX : e.clientY;
    const startSize  = getSize();
    const onMove = ev => {
      const delta = (vertical ? ev.clientX : ev.clientY) - startCoord;
      setSize(startSize, delta);
    };
    const onUp = () => {
      handleEl.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
    e.preventDefault();
  });
}

function initResizeHandles() {
  // Restore persisted widths from localStorage
  const _sw = localStorage.getItem('lipside-sidebar-w');
  if (_sw) document.documentElement.style.setProperty('--sidebar-w', _sw + 'px');
  const _gw = localStorage.getItem('lipside-graph-sidebar-w');
  if (_gw) document.documentElement.style.setProperty('--graph-sidebar-w', _gw + 'px');

  initResize(
    $('sidebar-resize'),
    () => {
      if (state.viewMode === 'graph') {
        return parseInt(getComputedStyle(document.documentElement)
          .getPropertyValue('--graph-sidebar-w') || '360');
      }
      return parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--sidebar-w') || '240');
    },
    (start, delta) => {
      const w = Math.max(80, Math.min(900, start + delta));
      if (state.viewMode === 'graph') {
        document.documentElement.style.setProperty('--graph-sidebar-w', w + 'px');
        localStorage.setItem('lipside-graph-sidebar-w', w);
      } else {
        document.documentElement.style.setProperty('--sidebar-w', w + 'px');
        localStorage.setItem('lipside-sidebar-w', w);
      }
    },
    true
  );
  initResize(
    $('preview-resize'),
    () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-w') || '340'),
    (start, delta) => {
      document.documentElement.style.setProperty('--preview-w', Math.max(100, Math.min(800, start - delta)) + 'px');
    },
    true
  );

  // Output panel vertical resize
  const _oh = localStorage.getItem('lipside-output-h');
  if (_oh) document.documentElement.style.setProperty('--build-out-h', _oh + 'px');
  initResize(
    $('output-resize'),
    () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--build-out-h') || '180'),
    (start, delta) => {
      const h = Math.max(60, Math.min(600, start - delta));
      document.documentElement.style.setProperty('--build-out-h', h + 'px');
      localStorage.setItem('lipside-output-h', h);
    },
    false  // vertical=false → tracks clientY
  );
}

/* ═══════════════════════════════════════════════════════════════════
   VIEW MODE
   ═══════════════════════════════════════════════════════════════════ */
async function setViewMode(mode) {
  state.viewMode = mode;
  document.body.className = `view-${mode}`;

  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });

  if (mode === 'graph') {
    $('file-tree').classList.add('hidden');
    $('graph-sidebar').classList.add('hidden');
    $('graph-pane').classList.remove('hidden');
    if (_graphDirty) { await renderGraphView(); _graphDirty = false; }
    return;
  }

  // Leaving graph mode: hide graph pane, restore file tree, reset camera for next open
  $('graph-pane').classList.add('hidden');
  $('file-tree').classList.remove('hidden');
  $('graph-sidebar').classList.add('hidden');
  _grApplyXform = null; // so next entry re-fits to screen
  if (state.activeTab !== null && state.tabs.length > 0) {
    if (cm) cm.getWrapperElement().style.display = '';
    $('empty-editor').style.display = 'none';
  } else {
    showEmptyEditor();
  }

  const tree = $('file-tree');
  const prevScroll = tree.scrollTop;
  const sections = tree.querySelectorAll('.stage-section');
  for (const section of sections) {
    const stageName = section.dataset.stage;
    const filesDiv  = section.querySelector('.stage-files');
    const arrow     = section.querySelector('.stage-arrow');
    const collapsed = !!treeCollapsed[`${mode}::${stageName}`];
    filesDiv.classList.toggle('hidden', collapsed);
    arrow.classList.toggle('collapsed', collapsed);
    if (!collapsed) await loadStageFiles(stageName, filesDiv);
    else filesDiv.innerHTML = '';
  }
  tree.scrollTop = prevScroll;
}

/* Ensure a named stage is visible and its files are loaded. */
async function expandStage(stageName) {
  const section = document.querySelector(`.stage-section[data-stage="${CSS.escape(stageName)}"]`);
  if (!section) return;
  const filesDiv = section.querySelector('.stage-files');
  const arrow    = section.querySelector('.stage-arrow');
  if (filesDiv.classList.contains('hidden')) {
    filesDiv.classList.remove('hidden');
    arrow.classList.remove('collapsed');
    treeCollapsed[`${state.viewMode}::${stageName}`] = false;
    if (filesDiv.children.length === 0) {
      await loadStageFiles(stageName, filesDiv);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   PIPELINE SELECTION
   ═══════════════════════════════════════════════════════════════════ */
async function selectPipeline(name) {
  if (!name) return;
  state.currentPipeline = name;

  Object.keys(treeCollapsed).forEach(k => delete treeCollapsed[k]);

  await renderTree();
  _graphDirty = true;
  _grApplyXform = null; // force recenter on next graph render (pipeline changed)
  if (state.viewMode === 'graph') { await renderGraphView(); _graphDirty = false; }

  const sel = $('pipeline-select');
  if (sel.value !== name) sel.value = name;

  $('th-pipe-name').textContent = name;

  // Persist the active pipeline to the workspace .env
  fetch('/api/workspace/set-pipeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipeline: name }),
  }).catch(() => {});
}

/* ═══════════════════════════════════════════════════════════════════
   FILE TREE RENDERING
   ═══════════════════════════════════════════════════════════════════ */

/* Sort stages in pipeline flow order using graphData.
   graphData[stage][file] = target → pipeline flow: target → stage */
function _topoSortStages(stages) {
  return [...stages];
}

async function renderTree() {
  if (!state.currentPipeline) {
    $('file-tree').innerHTML = '<div style="padding:12px;color:var(--fg-dim);font-size:12px">Select a pipeline</div>';
    return;
  }

  const res  = await fetch('/api/workspace');
  const data = await res.json();
  const pipeline = data.pipelines.find(p => p.name === state.currentPipeline);
  if (!pipeline) return;

  const tree = $('file-tree');
  tree.innerHTML = '';

  const sortedStages = _topoSortStages(pipeline.stages);
  for (const stageName of sortedStages) {
    const stageDiv = el('div', 'stage-section');
    stageDiv.dataset.stage = stageName;

    const hdr = el('div', 'stage-header');
    hdr.dataset.stage = stageName;

    const arrow    = el('span', 'stage-arrow', '▼');
    const nameSpan = el('span', 'stage-name', stageName);
    const runBtn   = el('button', 'stage-run-btn', '▶');
    runBtn.title = `lips build main ./${state.currentPipeline}/${stageName}`;
    runBtn.dataset.stage = stageName;

    // + button: add file to this stage (hidden in 'out' view)
    const addBtn = el('button', 'stage-add-btn', '+');
    addBtn.title = `New file in ${stageName}`;
    addBtn.dataset.stage = stageName;

    // purge button on stage header (hidden in build view via CSS)
    const purgeBtn = el('button', 'stage-purge-btn', '⌫');
    purgeBtn.dataset.stage = stageName;
    purgeBtn.dataset.view  = state.viewMode;
    if (state.viewMode === 'out') {
      purgeBtn.title = `Clear out/ for ${stageName}`;
    } else {
      purgeBtn.title = `Purge ${stageName}`;
    }

    const nameGroup = el('div', 'stage-name-group');
    nameGroup.appendChild(nameSpan);

    hdr.appendChild(arrow);
    hdr.appendChild(nameGroup);
    hdr.appendChild(addBtn);
    hdr.appendChild(purgeBtn);
    hdr.appendChild(runBtn);

    const filesDiv = el('div', 'stage-files');
    filesDiv.dataset.stage = stageName;

    const collapsed = !!treeCollapsed[`${state.viewMode}::${stageName}`];
    if (collapsed) {
      filesDiv.classList.add('hidden');
      arrow.classList.add('collapsed');
    }

    stageDiv.appendChild(hdr);
    stageDiv.appendChild(filesDiv);
    tree.appendChild(stageDiv);

    if (!collapsed) {
      await loadStageFiles(stageName, filesDiv);
    }
  }

  tree.removeEventListener('click', handleTreeClick);
  tree.addEventListener('click', handleTreeClick);
  tree.removeEventListener('contextmenu', handleTreeContextMenu);
  tree.addEventListener('contextmenu', handleTreeContextMenu);
}

function handleTreeClick(e) {
  // + (add file) button on stage header
  const stageAddBtn = e.target.closest('.stage-add-btn');
  if (stageAddBtn) {
    e.stopPropagation();
    promptNewFile(stageAddBtn.dataset.stage);
    return;
  }

  const stagePurgeBtn = e.target.closest('.stage-purge-btn');
  if (stagePurgeBtn) {
    e.stopPropagation();
    if (stagePurgeBtn.dataset.view === 'out') {
      openPurgeOutModal(stagePurgeBtn.dataset.stage);
    } else {
      openPurgeStageModal(stagePurgeBtn.dataset.stage);
    }
    return;
  }

  const stageRunBtn = e.target.closest('.stage-run-btn');
  if (stageRunBtn) {
    e.stopPropagation();
    runBuild(stageRunBtn.dataset.stage);
    return;
  }

  const fileRunBtn = e.target.closest('.file-run-btn');
  if (fileRunBtn) {
    e.stopPropagation();
    runBuild(fileRunBtn.dataset.stage, fileRunBtn.dataset.stem);
    return;
  }

  const hdr = e.target.closest('.stage-header');
  if (hdr && !e.target.closest('.stage-run-btn')) {
    const stageName    = hdr.dataset.stage;
    const stageSection = hdr.closest('.stage-section');
    const filesDiv     = stageSection.querySelector('.stage-files');
    const arrow        = hdr.querySelector('.stage-arrow');
    const nowCollapsed = !filesDiv.classList.contains('hidden');
    treeCollapsed[`${state.viewMode}::${stageName}`] = nowCollapsed;
    filesDiv.classList.toggle('hidden', nowCollapsed);
    arrow.classList.toggle('collapsed', nowCollapsed);

    if (!nowCollapsed && filesDiv.children.length === 0) {
      loadStageFiles(stageName, filesDiv);
    }
    return;
  }

  // subfolder toggle
  const dirHdr = e.target.closest('.dir-header');
  if (dirHdr) {
    e.stopPropagation();
    const stageName = dirHdr.dataset.stage;
    const dirPath   = dirHdr.dataset.path;
    const depth     = parseInt(dirHdr.dataset.depth || '0');
    const children  = dirHdr.closest('.dir-item').querySelector(':scope > .dir-children');
    if (children.classList.contains('hidden')) {
      _expandDir(dirHdr, stageName, dirPath, depth);
    } else {
      _collapseDir(dirHdr, stageName, dirPath);
    }
    return;
  }

  const fileItem = e.target.closest('.file-item');
  if (fileItem) {
    _focusedCtx = { type: 'file', stageName: fileItem.dataset.stage, path: fileItem.dataset.path, view: state.viewMode, isDir: false };
    openFile(fileItem.dataset.stage, fileItem.dataset.path);
    return;
  }
}

function _ctxItem(label, action, danger = false) {
  const d = document.createElement('div');
  d.className = 'ctx-i' + (danger ? ' ctx-danger' : '');
  d.dataset.ctx = action;
  d.textContent = label;
  return d;
}
function _ctxSep() {
  const d = document.createElement('div');
  d.className = 'ctx-sep';
  return d;
}

function handleTreeContextMenu(e) {
  const fileItem = e.target.closest('.file-item');
  const dirHdr   = e.target.closest('.dir-header');
  const stageHdr = e.target.closest('.stage-header');
  if (!fileItem && !dirHdr && !stageHdr) return;
  e.preventDefault();

  const ctx = $('ctx-menu');
  ctx.innerHTML = '';

  if (fileItem) {
    ctx.dataset.stage = fileItem.dataset.stage;
    ctx.dataset.path  = fileItem.dataset.path;
    ctx.dataset.isdir = 'false';
    _focusedCtx = { type: 'file', stageName: fileItem.dataset.stage, path: fileItem.dataset.path, view: state.viewMode, isDir: false };
    ctx.appendChild(_ctxItem('\uD83D\uDCC4 Open in Terminal', 'open-terminal'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('Rename...', 'rename'));
    ctx.appendChild(_ctxItem('Move to...', 'move'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('Delete File', 'delete', true));

  } else if (dirHdr) {
    ctx.dataset.stage = dirHdr.dataset.stage;
    ctx.dataset.path  = dirHdr.dataset.path;
    ctx.dataset.isdir = 'true';
    _focusedCtx = { type: 'dir', stageName: dirHdr.dataset.stage, path: dirHdr.dataset.path, view: state.viewMode, isDir: true };
    ctx.appendChild(_ctxItem('New File', 'new-file'));
    ctx.appendChild(_ctxItem('New Folder', 'new-folder'));
    ctx.appendChild(_ctxItem('\uD83D\uDCCB Paste from Clipboard', 'paste-clipboard'));
    ctx.appendChild(_ctxItem('\u2191 Upload File(s)...', 'upload-files'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('\uD83D\uDCC4 Open in Terminal', 'open-terminal'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('Rename...', 'rename'));
    ctx.appendChild(_ctxItem('Move to...', 'move'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('Delete Folder', 'delete', true));

  } else {
    ctx.dataset.stage = stageHdr.dataset.stage;
    ctx.dataset.path  = '';
    ctx.dataset.isdir = 'false';
    _focusedCtx = { type: 'stage', stageName: stageHdr.dataset.stage, path: '', view: state.viewMode, isDir: false };
    ctx.appendChild(_ctxItem('New File', 'new-file'));
    ctx.appendChild(_ctxItem('New Folder', 'new-folder'));
    ctx.appendChild(_ctxItem('\uD83D\uDCCB Paste from Clipboard', 'paste-clipboard'));
    ctx.appendChild(_ctxItem('\u2191 Upload File(s)...', 'upload-files'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('\uD83D\uDCC4 Open in Terminal', 'open-terminal'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('\u25B6 Build', 'run-build'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('Rename Stage...', 'rename-stage'));
    ctx.appendChild(_ctxItem('Purge Stage...', 'purge-stage', true));
    ctx.appendChild(_ctxItem('Delete Stage...', 'delete-stage', true));
  }

  ctx.dataset.view = state.viewMode;
  ctx.classList.remove('hidden');
  // keep menu on screen
  ctx.style.left = e.clientX + 'px';
  ctx.style.top  = e.clientY + 'px';
  requestAnimationFrame(() => {
    const rect = ctx.getBoundingClientRect();
    if (rect.right  > window.innerWidth)  ctx.style.left = (e.clientX - rect.width)  + 'px';
    if (rect.bottom > window.innerHeight) ctx.style.top  = (e.clientY - rect.height) + 'px';
  });
}

/* ─── load files for one stage ──────────────────────────────────── */
async function loadStageFiles(stageName, container) {
  container.innerHTML = '';
  try {
    const files = await _fetchEntries(stageName, '');
    renderFilesInto(container, stageName, files, '', 0);
    await _reopenExpandedDirs(container, stageName);
  } catch(e) {
    console.error('loadStageFiles error', e);
  }
}

async function _fetchEntries(stageName, subpath) {
  const url = `/api/files/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}/${state.viewMode}`
    + (subpath ? `?subpath=${encodeURIComponent(subpath)}` : '');
  const res = await fetch(url);
  if (!res.ok) return [];
  return (await res.json()).files || [];
}

/* After a re-render, re-open any dirs the user had previously expanded */
async function _reopenExpandedDirs(container, stageName) {
  // querySelectorAll is depth-first order — so parents open before children
  for (const hdr of container.querySelectorAll('.dir-header')) {
    const key = `${stageName}::${hdr.dataset.path}`;
    if (subdirExpanded[`${state.viewMode}::${key}`]) {
      await _expandDir(hdr, stageName, hdr.dataset.path, parseInt(hdr.dataset.depth || '0'));
    }
  }
}

/* ─── File-type icon helpers ─────────────────────────────────────── */
function _fileIconClass(ext) {
  const m = {
    py:'fi-py', pyw:'fi-py',
    js:'fi-js', mjs:'fi-js', cjs:'fi-js',
    ts:'fi-ts', tsx:'fi-ts',
    json:'fi-json', jsonc:'fi-json',
    md:'fi-md', markdown:'fi-md',
    html:'fi-html', htm:'fi-html',
    css:'fi-css', scss:'fi-css', sass:'fi-css', less:'fi-css',
    sh:'fi-sh', bash:'fi-sh', zsh:'fi-sh',
    yaml:'fi-yaml', yml:'fi-yaml', toml:'fi-toml',
    xml:'fi-xml',
    csv:'fi-csv', tsv:'fi-csv',
    svg:'fi-svg',
    txt:'fi-txt',
  };
  return m[ext] || 'fi-default';
}
function _fileIconLabel(ext) {
  const m = {
    py:'py', pyw:'py',
    js:'js', mjs:'js', cjs:'js',
    ts:'ts', tsx:'ts',
    json:'{}', jsonc:'{}',
    md:'md', markdown:'md',
    html:'ht', htm:'ht',
    css:'cs', scss:'cs', sass:'cs', less:'cs',
    sh:'sh', bash:'sh', zsh:'sh',
    yaml:'yl', yml:'yl', toml:'tm',
    xml:'xm',
    csv:'cv', tsv:'cv',
    svg:'sv',
    txt:'tx',
  };
  return m[ext] || '··';
}

/* ─── Core tree renderer ─────────────────────────────────────────── */
// BASE + depth * LEVEL = paddingLeft for dir-headers.
// Files get LEVEL more (to sit past the arrow column).
const _TREE_BASE  = 6;
const _TREE_LEVEL = 16;

function renderFilesInto(container, stageName, files, parentPath, depth) {
  container.innerHTML = '';
  // In build view, sort compile files to top (dirs always first)
  if (state.viewMode === 'build') {
    files = [...files].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      const ac = /compile/i.test(a.name) ? 0 : 1;
      const bc = /compile/i.test(b.name) ? 0 : 1;
      return ac !== bc ? ac - bc : a.name.localeCompare(b.name);
    });
  }
  const dirPL  = _TREE_BASE + depth * _TREE_LEVEL;
  const filePL = dirPL + _TREE_LEVEL;          // aligned past arrow area

  for (const f of files) {
    if (f.is_dir) {
      /* ── folder row ─────────────────────── */
      const dirItem = el('div', 'dir-item');
      dirItem.dataset.path  = f.path;
      dirItem.dataset.stage = stageName;

      const hdr = el('div', 'dir-header');
      hdr.style.paddingLeft = dirPL + 'px';
      hdr.dataset.path  = f.path;
      hdr.dataset.stage = stageName;
      hdr.dataset.depth = String(depth);

      const arrow  = el('span', 'dir-arrow', '▶');
      const icon   = el('span', 'dir-folder-icon', '📁');
      const nameSp = el('span', 'dir-name', f.name);
      hdr.append(arrow, icon, nameSp);

      const children = el('div', 'dir-children');
      children.classList.add('hidden');
      children.dataset.stage = stageName;
      children.dataset.path  = f.path;
      children.dataset.depth = String(depth + 1);

      dirItem.append(hdr, children);
      container.appendChild(dirItem);

    } else {
      /* ── file row ───────────────────────── */
      const item = el('div', 'file-item');
      item.style.paddingLeft = filePL + 'px';
      item.dataset.path  = f.path;
      item.dataset.stage = stageName;

      const ext      = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : '';
      const iconEl   = el('span', 'file-icon ' + _fileIconClass(ext));
      iconEl.textContent = _fileIconLabel(ext);
      const nameSpan = el('span', 'file-name', f.name);
      const nameGroup = el('div', 'file-name-group');
      nameGroup.appendChild(nameSpan);

      item.append(iconEl, nameGroup);

      // run button
      const stem   = f.name.replace(/\.[^.]+$/, '');
      const runBtn = el('button', 'file-run-btn', '▶');
      runBtn.dataset.stem  = stem;
      runBtn.dataset.stage = stageName;
      runBtn.title = `lips build ${stem} ./${state.currentPipeline}/${stageName}`;
      item.appendChild(runBtn);

      container.appendChild(item);
    }
  }
}

/* ─── Expand / collapse a subfolder ─────────────────────────────── */
async function _expandDir(hdrEl, stageName, dirPath, depth) {
  const dirItem  = hdrEl.closest('.dir-item');
  const children = dirItem.querySelector(':scope > .dir-children');
  const arrow    = hdrEl.querySelector('.dir-arrow');
  const icon     = hdrEl.querySelector('.dir-folder-icon');

  children.classList.remove('hidden');
  if (arrow) arrow.classList.add('open');
  if (icon)  icon.textContent = '📂';
  subdirExpanded[`${state.viewMode}::${stageName}::${dirPath}`] = true;

  if (children.children.length === 0) {
    children.innerHTML = '<div class="dir-loading">Loading…</div>';
    try {
      const files = await _fetchEntries(stageName, dirPath);
      renderFilesInto(children, stageName, files, dirPath, depth + 1);
      await _reopenExpandedDirs(children, stageName);
    } catch(e) {
      children.innerHTML = '';
    }
  }
}

function _collapseDir(hdrEl, stageName, dirPath) {
  const dirItem  = hdrEl.closest('.dir-item');
  const children = dirItem.querySelector(':scope > .dir-children');
  const arrow    = hdrEl.querySelector('.dir-arrow');
  const icon     = hdrEl.querySelector('.dir-folder-icon');

  children.classList.add('hidden');
  if (arrow) arrow.classList.remove('open');
  if (icon)  icon.textContent = '📁';
  subdirExpanded[`${state.viewMode}::${stageName}::${dirPath}`] = false;
}


/* ═══════════════════════════════════════════════════════════════════
   TABS & EDITOR
   ═══════════════════════════════════════════════════════════════════ */
function tabKey(pipeline, stage, view, path) {
  return `${pipeline}|${stage}|${view}|${path}`;
}

async function openFile(stageName, filePath, viewOverride = null) {
  const _v = viewOverride || state.viewMode;
  const view = (_v === 'graph') ? 'repo' : _v;
  const pipeline = state.currentPipeline;
  const key      = tabKey(pipeline, stageName, view, filePath);

  const existing = state.tabs.findIndex(t => t.key === key);
  if (existing !== -1) { activateTab(existing); return; }

  try {
    const res = await fetch(
      `/api/file/${encodeURIComponent(pipeline)}/${encodeURIComponent(stageName)}/${view}?path=${encodeURIComponent(filePath)}`
    );
    if (!res.ok) { await appAlert(`Cannot open file: ${res.statusText}`); return; }
    const data = await res.json();

    const fname = filePath.split('/').pop();
    state.tabs.push({
      key, pipeline, stage: stageName, view,
      path: filePath,
      label: `${fname}@${stageName}`,
      _fname: fname,
      content: data.content || '',
      file_type: data.file_type || 'text',
      readonly: data.readonly || false,
      data_url: data.data_url || null,
      modified: false,
    });
    renderTabBar();
    activateTab(state.tabs.length - 1);
    await expandStage(stageName);  // make sure the stage is visible in the sidebar
  } catch(e) {
    console.error('openFile error', e);
  }
}

function renderTabBar() {
  const bar = $('tab-bar');
  bar.innerHTML = '';
  state.tabs.forEach((tab, i) => {
    const t = el('div', 'tab' + (i === state.activeTab ? ' active' : ''));
    t.dataset.idx = i;
    t.dataset.view = tab.view;
    t.draggable = true;
    if (tab._buildLocked) t.appendChild(el('span', 'tab-locked', '🔒'));
    else if (tab.modified) t.appendChild(el('span', 'tab-modified', '●'));
    t.appendChild(el('span', 'tab-name', tab.label));
    t.appendChild(el('button', 'tab-close', '×'));
    bar.appendChild(t);
  });
}

function activateTab(idx) {
  // Flush unsaved editor content back into the outgoing tab before switching
  if (state.activeTab !== null && state.activeTab !== idx && cm) {
    const outgoing = state.tabs[state.activeTab];
    if (outgoing && !outgoing.readonly && !outgoing._buildLocked) {
      outgoing.content    = cm.getValue();
      outgoing.cmHistory  = cm.getHistory();
    }
  }
  if (idx < 0 || idx >= state.tabs.length) {
    state.activeTab = null;
    showEmptyEditor();
    $('btn-toggle-preview').classList.add('hidden');
    return;
  }
  state.activeTab = idx;
  renderTabBar();
  loadIntoEditor(state.tabs[idx]);

  // Show preview toggle only for md/html (not readonly types)
  const _tabFname = state.tabs[idx]._fname || state.tabs[idx].label.split('@')[0];
  const ext = _tabFname.split('.').pop().toLowerCase();
  const isPreviewToggleable = (ext === 'md' || ext === 'markdown' || ext === 'html' || ext === 'uml') && !state.tabs[idx].readonly;
  $('btn-toggle-preview').classList.toggle('hidden', !isPreviewToggleable);

  document.querySelectorAll('.file-item').forEach(el => {
    const t = state.tabs[idx];
    el.classList.toggle('active', el.dataset.stage === t.stage && el.dataset.path === t.path);
  });
}

function showEmptyEditor() {
  if (cm) cm.getWrapperElement().style.display = 'none';
  $('editor-wrap').style.display = '';
  $('empty-editor').style.display = 'flex';
  $('preview-resize').classList.add('hidden');
  const pane = $('preview-pane');
  pane.classList.add('hidden');
  pane.classList.remove('preview-fullscreen');
  state.previewVisible = false;
}

function _isJsonDialog(content, view) {
  if (view !== 'out') return false;
  try {
    const parsed = JSON.parse(content);
    const msgs = Array.isArray(parsed) ? parsed : (parsed?.messages ?? null);
    if (!Array.isArray(msgs) || msgs.length === 0) return false;
    return msgs.every(m => typeof m === 'object' && m !== null && 'role' in m && 'content' in m);
  } catch { return false; }
}

function _showReadonlyPreview(html) {
  $('editor-wrap').style.display = 'none';
  $('preview-resize').classList.add('hidden');
  const pane = $('preview-pane');
  pane.classList.remove('hidden');
  pane.classList.add('preview-fullscreen');
  pane.innerHTML = html;
  if (cm) cm.getWrapperElement().style.display = 'none';
}

async function renderMarkdownPreview(src) {
  const pane = $('preview-pane');
  pane.innerHTML = marked.parse(src || '');
  const blocks = pane.querySelectorAll('code.language-mermaid');
  for (const [i, block] of [...blocks].entries()) {
    const code = block.textContent;
    const id = `mermaid-${Date.now()}-${i}`;
    try {
      const { svg } = await mermaid.render(id, code);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = svg;
      block.closest('pre').replaceWith(wrapper);
    } catch (e) {
      const errDiv = document.createElement('div');
      errDiv.className = 'mermaid-error';
      errDiv.textContent = 'Mermaid error: ' + e.message;
      block.closest('pre').replaceWith(errDiv);
    }
  }
}

function _umlToUrl(src) {
  const bytes = new TextEncoder().encode(src.trim());
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `https://www.plantuml.com/plantuml/svg/~h${hex}`;
}

function renderUmlPreview(src) {
  const pane = $('preview-pane');
  if (!src || !src.trim()) { pane.innerHTML = '<div class="gr-empty">Empty diagram.</div>'; return; }
  const url = _umlToUrl(src);
  pane.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'preview-uml-wrap';
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'UML diagram';
  img.onerror = () => { wrap.innerHTML = '<div class="mermaid-error">Failed to render UML — check syntax or network.</div>'; };
  wrap.appendChild(img);
  pane.appendChild(wrap);
}

function renderHtmlPreview(src) {
  const pane = $('preview-pane');
  pane.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;';
  iframe.sandbox = 'allow-scripts';
  pane.appendChild(iframe);
  iframe.srcdoc = src || '';
}

function _renderJsonDialog(content) {
  try {
    const parsed = JSON.parse(content);
    const msgs = Array.isArray(parsed) ? parsed : parsed.messages;
    const bubbles = msgs.map(m => {
      const role = (m.role || '').toLowerCase();
      const isUser = role === 'user';
      const isSystem = role === 'system';
      const text = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content, null, 2);
      const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const cls = isSystem ? 'dialog-bubble dialog-system'
                : isUser   ? 'dialog-bubble dialog-user'
                :             'dialog-bubble dialog-assistant';
      const label = isSystem ? 'system' : isUser ? 'user' : (m.role || 'assistant');
      return `<div class="${cls}"><span class="dialog-role">${label}</span><div class="dialog-text"><pre>${escaped}</pre></div></div>`;
    }).join('');
    return `<div class="dialog-thread">${bubbles}</div>`;
  } catch (e) {
    return `<pre>Failed to render dialog: ${e.message}</pre>`;
  }
}

function loadIntoEditor(tab) {
  $('empty-editor').style.display = 'none';

  const fname = tab._fname || tab.label.split('@')[0];
  const ext = fname.split('.').pop().toLowerCase();

  // ── Readonly / special types: hide editor, fill preview pane ──
  if (tab.file_type === 'image') {
    _showReadonlyPreview(`<div class="preview-image-wrap"><img src="${tab.data_url}" alt="${fname}"></div>`);
    return;
  }
  if (tab.file_type === 'pdf') {
    const escaped = tab.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    _showReadonlyPreview(`<pre class="preview-pdf-text">${escaped}</pre>`);
    return;
  }
  if (_isJsonDialog(tab.content, tab.view)) {
    _showReadonlyPreview(_renderJsonDialog(tab.content));
    return;
  }

  // ── Editable types: restore editor ────────────────────────────
  $('editor-wrap').style.display = '';
  $('preview-pane').classList.remove('preview-fullscreen');

  if (!cm) {
    cm = CodeMirror($('editor-container'), {
      theme: 'dracula',
      lineNumbers: true,
      matchBrackets: true,
      styleActiveLine: true,
      indentWithTabs: false,
      tabSize: 2,
      lineWrapping: false,
    });
    cm.on('change', () => {
      if (_cmLoading) return;
      if (state.activeTab === null) return;
      const t = state.tabs[state.activeTab];
      if (!t.modified) { t.modified = true; renderTabBar(); }
    });
  }

  cm.getWrapperElement().style.display = '';
  cm.setOption('readOnly', tab._buildLocked ? true : false);

  const modeMap = {
    py: 'python', pyw: 'python',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'javascript', tsx: 'javascript',
    md: 'markdown', markdown: 'markdown',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    json: 'javascript', jsonc: 'javascript',
    yaml: 'yaml', yml: 'yaml',
    html: 'htmlmixed', htm: 'htmlmixed',
    css: 'css', scss: 'css', sass: 'css', less: 'css',
    xml: 'xml', svg: 'xml',
    txt: null,
  };
  cm.setOption('mode', modeMap[ext] || 'null');
  _cmLoading = true;
  cm.setValue(tab.content);
  cm.clearHistory();
  if (tab.cmHistory) cm.setHistory(tab.cmHistory);
  _cmLoading = false;
  cmPath  = tab.key;
  cmDirty = false;

  // ── md/html: restore preview if it was open ───────────────────
  if (state.previewVisible) {
    $('preview-pane').classList.remove('hidden');
    $('preview-resize').classList.remove('hidden');
    if (ext === 'md' || ext === 'markdown') renderMarkdownPreview(tab.content);
    else if (ext === 'html') renderHtmlPreview(tab.content);
    else if (ext === 'uml') renderUmlPreview(tab.content);
  } else {
    $('preview-pane').classList.add('hidden');
    $('preview-resize').classList.add('hidden');
  }

  requestAnimationFrame(() => cm.refresh());
}

async function saveActiveTab() {
  if (state.activeTab === null) return;
  const tab = state.tabs[state.activeTab];
  if (tab.readonly) return;
  const content = cm ? cm.getValue() : tab.content;
  try {
    const res = await fetch(
      `/api/file/${encodeURIComponent(tab.pipeline)}/${encodeURIComponent(tab.stage)}/${tab.view}?path=${encodeURIComponent(tab.path)}`,
      { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content}) }
    );
    if (!res.ok) { await appAlert('Save failed: ' + (await res.text())); return; }
    tab.content  = content;
    tab.modified = false;
    renderTabBar();
  } catch(e) {
    await appAlert('Save error: ' + e.message);
  }
}

async function closeTab(idx) {
  const tab = state.tabs[idx];
  if (tab.modified && !await appConfirm(`Close "${tab.label}" without saving?`)) return;
  state.tabs.splice(idx, 1);
  if (state.tabs.length === 0) {
    state.activeTab = null;
    showEmptyEditor();
    renderTabBar();
    return;
  }
  state.activeTab = null;
  renderTabBar();
  activateTab(Math.min(idx, state.tabs.length - 1));
}


$('tab-bar').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const idx = parseInt(tab.dataset.idx);
  if (e.target.classList.contains('tab-close')) { closeTab(idx); return; }
  activateTab(idx);
});

/* ── Tab drag-to-reorder ──────────────────────────────────────────── */
$('tab-bar').addEventListener('dragstart', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  _dragSrcIdx = parseInt(tab.dataset.idx);
  e.dataTransfer.effectAllowed = 'move';
  // Defer adding class so the original doesn't vanish instantly
  requestAnimationFrame(() => tab.classList.add('tab-dragging'));
});

$('tab-bar').addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('#tab-bar .tab').forEach(t => t.classList.remove('tab-drag-over'));
  const tab = e.target.closest('.tab');
  if (tab && parseInt(tab.dataset.idx) !== _dragSrcIdx) tab.classList.add('tab-drag-over');
});

$('tab-bar').addEventListener('dragleave', e => {
  if (!e.relatedTarget || !e.relatedTarget.closest('#tab-bar')) {
    document.querySelectorAll('#tab-bar .tab').forEach(t => t.classList.remove('tab-drag-over'));
  }
});

$('tab-bar').addEventListener('drop', e => {
  e.preventDefault();
  document.querySelectorAll('#tab-bar .tab').forEach(t => {
    t.classList.remove('tab-drag-over');
    t.classList.remove('tab-dragging');
  });
  const tab = e.target.closest('.tab');
  if (!tab || _dragSrcIdx === null) { _dragSrcIdx = null; return; }
  const dstIdx = parseInt(tab.dataset.idx);
  if (dstIdx === _dragSrcIdx) { _dragSrcIdx = null; return; }
  // Reorder the tabs array
  const [moved] = state.tabs.splice(_dragSrcIdx, 1);
  state.tabs.splice(dstIdx, 0, moved);
  // Fix the active index
  if (state.activeTab === _dragSrcIdx) {
    state.activeTab = dstIdx;
  } else if (_dragSrcIdx < state.activeTab && dstIdx >= state.activeTab) {
    state.activeTab--;
  } else if (_dragSrcIdx > state.activeTab && dstIdx <= state.activeTab) {
    state.activeTab++;
  }
  _dragSrcIdx = null;
  renderTabBar();
});

$('tab-bar').addEventListener('dragend', () => {
  document.querySelectorAll('#tab-bar .tab').forEach(t => {
    t.classList.remove('tab-dragging');
    t.classList.remove('tab-drag-over');
  });
  _dragSrcIdx = null;
});

/* ═══════════════════════════════════════════════════════════════════
   WORKSPACE LOADING
   ═══════════════════════════════════════════════════════════════════ */
async function loadWorkspace(workspacePath) {
  try {
    const res  = await fetch('/api/workspace');
    const data = await res.json();
    state.workspace       = data.workspace || workspacePath;
    state.pipelineObjects = data.pipelines || [];
    state.pipelines       = state.pipelineObjects.map(p => p.name || p);
    $('workspace-path').textContent = state.workspace;
    populatePipelineSelect();
    populateMenuPipelineList();

    // Restore last-used pipeline from workspace .env (PIPELINE=name), then
    // fall back to whatever was already selected, then the first pipeline.
    const savedPipeline = data.active_pipeline || '';
    const restore = (savedPipeline && state.pipelines.includes(savedPipeline))
      ? savedPipeline
      : (state.currentPipeline && state.pipelines.includes(state.currentPipeline))
        ? state.currentPipeline
        : state.pipelines[0];

    if (restore) {
      await selectPipeline(restore);
    }
  } catch(e) {
    console.error('loadWorkspace error', e);
  }
}

function populatePipelineSelect() {
  const sel = $('pipeline-select');
  sel.innerHTML = '';
  if (state.pipelines.length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(no pipelines)';
    sel.appendChild(opt);
    return;
  }
  for (const name of state.pipelines) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
  if (state.currentPipeline) sel.value = state.currentPipeline;
}

function populateMenuPipelineList() {
  const listEl = $('menu-pipeline-list');
  listEl.innerHTML = '';
  for (const name of state.pipelines) {
    const item = el('div', 'mdi', name);
    item.dataset.action   = 'switch-pipeline';
    item.dataset.pipeline = name;
    listEl.appendChild(item);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   MENUBAR
   ═══════════════════════════════════════════════════════════════════ */
function initMenubar() {
  const mis = document.querySelectorAll('.mi');
  mis.forEach(mi => {
    mi.querySelector('span').addEventListener('click', () => {
      const wasOpen = mi.classList.contains('open');
      mis.forEach(m => m.classList.remove('open'));
      if (!wasOpen) mi.classList.add('open');
    });
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.mi')) mis.forEach(m => m.classList.remove('open'));
  });

  document.querySelectorAll('.mdi[data-action]').forEach(item => {
    item.addEventListener('click', () => {
      mis.forEach(m => m.classList.remove('open'));
      handleMenuAction(item.dataset.action, item.dataset);
    });
  });

  $('menu-pipeline-list').addEventListener('click', e => {
    const item = e.target.closest('.mdi');
    if (!item) return;
    mis.forEach(m => m.classList.remove('open'));
    if (item.dataset.action === 'switch-pipeline') selectPipeline(item.dataset.pipeline);
  });
}

function handleMenuAction(action, dataset) {
  switch(action) {
    case 'new-file':          promptNewFile(); break;
    case 'new-folder':        promptNewFolder(); break;
    case 'save':              saveActiveTab(); break;
    case 'save-all':          saveAllTabs(); break;
    case 'close-tab':         if (state.activeTab !== null) closeTab(state.activeTab); break;
    case 'close-all':         closeAllTabs(); break;
    case 'toggle-sidebar':    toggleSidebar(); break;
    case 'toggle-preview':    togglePreview(); break;
    case 'view-repo':         setViewMode('repo'); break;
    case 'view-build':        setViewMode('build'); break;
    case 'view-out':          setViewMode('out'); break;
    case 'view-graph':        setViewMode('graph'); break;
    case 'change-workspace':  showWorkspaceInput(); break;
    case 'new-pipeline':      openCreateModal(); break;
    case 'add-stages':        openStagesModal(); break;
    case 'edit-config':       openConfigModal(); break;
    case 'purge-pipeline':    openPurgePipelineModal(); break;
    case 'delete-pipeline':   openDeletePipelineModal(); break;
    case 'run-build-default':
      if (state.currentPipeline) {
        const stages = document.querySelectorAll('.stage-header');
        if (stages.length) runBuild(stages[0].dataset.stage);
      }
      break;
    case 'run-all-stages':     runAllStages(); break;
    case 'new-file-here':      promptNewFile(); break;
    case 'new-folder-here':    promptNewFolder(); break;
    case 'paste-clipboard':    pasteFromClipboard(); break;
    case 'upload-files':       uploadFiles(); break;
    case 'find':               cmFind(); break;
    case 'replace':            cmReplace(); break;
    case 'go-to-line':         cmGoToLine(); break;
    case 'select-all':         if (cm) { cm.execCommand('selectAll'); cm.focus(); } break;
    case 'format-json':        formatJson(); break;
    case 'zoom-in':            changeFontSize(1); break;
    case 'zoom-out':           changeFontSize(-1); break;
    case 'rename-pipeline':    promptRenamePipeline(); break;
    case 'shortcuts-help':     showShortcutsHelp(); break;
  }
}

/* ---- clipboard paste ---- */
async function pasteFromClipboard(stageName, basePath) {
  stageName = stageName || getActiveStage();
  if (!stageName) { await appAlert('Select a stage first'); return; }
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch(e) { await appAlert('Clipboard read failed: ' + e.message); return; }
  if (!text) { await appAlert('Clipboard is empty'); return; }
  const name = await appPrompt('Save clipboard as file name:', 'paste.md');
  if (!name) return;
  const relPath = basePath ? `${basePath}/${name}` : name;
  try {
    const res = await fetch(
      `/api/file/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}/${state.viewMode}`,
      { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path: relPath, content: text}) }
    );
    if (!res.ok) { await appAlert('Error: ' + await res.text()); return; }
    await refreshStageFiles(stageName);
    openFile(stageName, relPath);
  } catch(e) { await appAlert(e.message); }
}

/* ---- upload files ---- */
async function uploadFiles(stageName, basePath, viewHint) {
  stageName = stageName || getActiveStage();
  if (!stageName) { await appAlert('Select a stage first'); return; }
  const view = (viewHint && viewHint !== 'graph') ? viewHint : state.viewMode;

  await new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files);
      if (!files.length) { resolve(); return; }
      const form = new FormData();
      files.forEach(f => form.append('files', f));
      const params = new URLSearchParams();
      if (basePath) params.set('subpath', basePath);
      try {
        const res = await fetch(
          `/api/upload/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}/${view}` +
          (basePath ? `?${params}` : ''),
          { method: 'POST', body: form }
        );
        if (!res.ok) { await appAlert('Upload failed: ' + (await res.text())); resolve(); return; }
        const data = await res.json();
        await refreshStageFiles(stageName);
        if (data.saved && data.saved.length === 1) openFile(stageName, data.saved[0]);
      } catch(e) { await appAlert('Upload error: ' + e.message); }
      resolve();
    };
    input.oncancel = () => resolve();
    input.click();
  });
}

/* ---- run all stages in topological order ---- */
function runAllStages() {
  if (!state.currentPipeline) { appAlert('Select a pipeline first'); return; }
  const pipe = state.pipelineObjects.find(p => (p.name || p) === state.currentPipeline);
  if (!pipe || !pipe.stages || pipe.stages.length === 0) {
    appAlert('No stages found in current pipeline');
    return;
  }
  const sorted = _topoSortStages([...pipe.stages]);
  sorted.forEach(stageName => runBuild(stageName));
}

/* ---- editor helpers ---- */
function cmFind() { if (cm) { cm.focus(); CodeMirror.commands.find(cm); } }
function cmReplace() { if (cm) { cm.focus(); CodeMirror.commands.replace(cm); } }
async function cmGoToLine() {
  if (!cm) return;
  const line = await appPrompt('Go to line:');
  if (!line) return;
  const n = parseInt(line) - 1;
  if (!isNaN(n)) { cm.setCursor(n); cm.focus(); cm.scrollIntoView({line: n, ch: 0}, 100); }
}
async function formatJson() {
  if (!cm) return;
  try {
    const pretty = JSON.stringify(JSON.parse(cm.getValue()), null, 2);
    cm.setValue(pretty);
  } catch(e) { await appAlert('Not valid JSON'); }
}
let _fontSize = 13;
function changeFontSize(delta) {
  _fontSize = Math.max(8, Math.min(24, _fontSize + delta));
  if (cm) cm.getWrapperElement().style.fontSize = _fontSize + 'px';
}
async function promptRenamePipeline() {
  if (!state.currentPipeline) { await appAlert('Select a pipeline first'); return; }
  await appAlert('Renaming pipelines requires a file-system rename. Please rename the folder manually in your workspace.');
}
async function showShortcutsHelp() {
  await appAlert(
    'Keyboard Shortcuts\n' +
    '──────────────────\n' +
    'Ctrl+S       Save file\n' +
    'Ctrl+Shift+S Save all\n' +
    'Ctrl+W       Close tab\n' +
    'Ctrl+B       Toggle sidebar\n' +
    'Ctrl+F       Find in file\n' +
    'Ctrl+H       Replace in file\n' +
    'Ctrl+G       Go to line'
  );
}

/* ═══════════════════════════════════════════════════════════════════
   TITLEBAR CONTROLS
   ═══════════════════════════════════════════════════════════════════ */
$('pipeline-select').addEventListener('change', e => selectPipeline(e.target.value));

document.querySelectorAll('.view-tab').forEach(btn => {
  btn.addEventListener('click', () => setViewMode(btn.dataset.view));
});

$('btn-sidebar-toggle').addEventListener('click', toggleSidebar);

// "Add Stages" button → opens the Add Stages modal
$('btn-new-pipeline').addEventListener('click', openStagesModal);
// "New Pipeline" button → opens the Create Pipeline modal
$('btn-new-pipeline-create').addEventListener('click', openCreateModal);
// Clear pending (non-running) builds from queue
$('btn-clear-queue').addEventListener('click', () => {
  if (_buildRunning) _buildQueue.splice(1);   // keep the running item
  else _buildQueue.length = 0;
  _renderBuildQueue();
});

$('btn-config').addEventListener('click', openConfigModal);
$('btn-edit-env-ws').addEventListener('click', openEnvModal);

$('workspace-path').addEventListener('click', pickWorkspace);

async function pickWorkspace() {
  try {
    const res = await fetch('/api/workspace/pick');
    if (res.ok) {
      const data = await res.json();
      if (data.cancelled) return;
      await _applyWorkspace(data.workspace || data.path, data.pipelines);
      return;
    }
  } catch(_) { /* fall through to manual input */ }
  showWorkspaceInput();
}

function showWorkspaceInput() {
  $('workspace-path').classList.add('hidden');
  $('ws-input-wrap').classList.remove('hidden');
  $('ws-input').value = state.workspace;
  $('ws-input').focus();
  $('ws-input').select();
}

$('btn-ws-cancel').addEventListener('click', () => {
  $('ws-input-wrap').classList.add('hidden');
  $('workspace-path').classList.remove('hidden');
});

$('btn-ws-open').addEventListener('click', changeWorkspace);
$('ws-input').addEventListener('keydown', e => { if (e.key === 'Enter') changeWorkspace(); });

async function changeWorkspace() {
  const path = $('ws-input').value.trim();
  if (!path) return;
  try {
    const res = await fetch('/api/workspace/path', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({path})
    });
    if (!res.ok) { await appAlert('Could not open workspace: ' + (await res.text())); return; }
    const data = await res.json();
    $('ws-input-wrap').classList.add('hidden');
    $('workspace-path').classList.remove('hidden');
    await _applyWorkspace(data.workspace || path, data.pipelines);
  } catch(e) {
    await appAlert('Error: ' + e.message);
  }
}

async function _applyWorkspace(path, pipelines) {
  state.currentPipeline = null;
  state.tabs = [];
  state.activeTab = null;
  renderTabBar();
  showEmptyEditor();
  await loadWorkspace(path);
}

function toggleSidebar() {
  state.sidebarVisible = !state.sidebarVisible;
  $('sidebar').classList.toggle('collapsed', !state.sidebarVisible);
  $('sidebar-resize').classList.toggle('hidden', !state.sidebarVisible);
}

function togglePreview() {
  if (state.activeTab === null) return;
  const tab = state.tabs[state.activeTab];
  if (tab.readonly) return;
  const fname = tab._fname || tab.label.split('@')[0];
  const ext = fname.split('.').pop().toLowerCase();
  const isMd   = ext === 'md' || ext === 'markdown';
  const isHtml = ext === 'html';
  const isUml  = ext === 'uml';
  if (!isMd && !isHtml && !isUml) return;

  state.previewVisible = !state.previewVisible;
  $('preview-pane').classList.toggle('hidden', !state.previewVisible);
  $('preview-resize').classList.toggle('hidden', !state.previewVisible);

  if (state.previewVisible) {
    if (isMd) {
      renderMarkdownPreview(cm ? cm.getValue() : tab.content);
      if (cm) {
        cm.off('change', cm._previewHandler);
        let _mdTimer = null;
        cm._previewHandler = () => {
          clearTimeout(_mdTimer);
          _mdTimer = setTimeout(() => renderMarkdownPreview(cm.getValue()), 300);
        };
        cm.on('change', cm._previewHandler);
      }
    } else if (isHtml) {
      renderHtmlPreview(cm ? cm.getValue() : tab.content);
      if (cm) {
        cm.off('change', cm._previewHandler);
        let _htmlTimer = null;
        cm._previewHandler = () => {
          clearTimeout(_htmlTimer);
          _htmlTimer = setTimeout(() => renderHtmlPreview(cm.getValue()), 300);
        };
        cm.on('change', cm._previewHandler);
      }
    } else if (isUml) {
      renderUmlPreview(cm ? cm.getValue() : tab.content);
      if (cm) {
        cm.off('change', cm._previewHandler);
        // debounce UML re-render since it fires a network request
        let _umlTimer = null;
        cm._previewHandler = () => {
          clearTimeout(_umlTimer);
          _umlTimer = setTimeout(() => renderUmlPreview(cm.getValue()), 600);
        };
        cm.on('change', cm._previewHandler);
      }
    }
  } else {
    if (cm) { cm.off('change', cm._previewHandler); cm._previewHandler = null; }
  }
}

async function _saveTab(tab) {
  try {
    const res = await fetch(
      `/api/file/${encodeURIComponent(tab.pipeline)}/${encodeURIComponent(tab.stage)}/${tab.view}?path=${encodeURIComponent(tab.path)}`,
      { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({content: tab.content}) }
    );
    if (res.ok) { tab.modified = false; }
    else console.warn('[saveTab] failed for', tab.label, await res.text());
  } catch(e) { console.warn('[saveTab] error for', tab.label, e); }
}

async function saveAllTabs() {
  // Sync live CM content into the active tab first
  if (state.activeTab !== null && cm) {
    const t = state.tabs[state.activeTab];
    if (t && !t.readonly && !t._buildLocked) t.content = cm.getValue();
  }
  // Save all dirty tabs in parallel — no tab switching, no visible flash
  await Promise.all(state.tabs.filter(t => t.modified && !t.readonly).map(_saveTab));
  renderTabBar();
}

async function closeAllTabs() {
  if (state.tabs.some(t => t.modified) && !await appConfirm('Close all tabs? Unsaved changes will be lost.')) return;
  state.tabs = [];
  state.activeTab = null;
  renderTabBar();
  showEmptyEditor();
}

/* ═══════════════════════════════════════════════════════════════════
   CONTEXT MENU — FILE CRUD
   ═══════════════════════════════════════════════════════════════════ */
document.addEventListener('click', e => {
  if (!e.target.closest('#ctx-menu')) $('ctx-menu').classList.add('hidden');
});

$('ctx-menu').addEventListener('click', async e => {
  const item = e.target.closest('.ctx-i');
  if (!item) return;
  $('ctx-menu').classList.add('hidden');
  const stageName = $('ctx-menu').dataset.stage;
  const path      = $('ctx-menu').dataset.path;
  const isDir     = $('ctx-menu').dataset.isdir === 'true';
  const view      = $('ctx-menu').dataset.view || state.viewMode;

  const basePath = !path ? '' :
    isDir ? path :
    path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';

  switch(item.dataset.ctx) {
    case 'new-file':        promptNewFile(stageName, basePath, view); break;
    case 'new-folder':      promptNewFolder(stageName, basePath, view); break;
    case 'open-terminal':   openInTerminal(stageName, path || '', view); break;
    case 'open-file':       openFile(stageName, path, view); break;
    case 'rename':          promptRename(stageName, path, view); break;
    case 'move':            promptMove(stageName, path, view); break;
    case 'delete':          confirmDelete(stageName, path, view); break;
    case 'purge-stage':          openPurgeStageModal(stageName); break;
    case 'rename-stage':         promptRenameStage(stageName); break;
    case 'delete-stage':         openDeleteStageModal(stageName); break;
    case 'paste-clipboard':      pasteFromClipboard(stageName, basePath); break;
    case 'upload-files':         uploadFiles(stageName, basePath, view); break;
    case 'gr-new-stage':         openStagesModal(); break;
    case 'gr-purge-upstream':    openPurgeUpstreamModal(stageName); break;
    case 'gr-purge-downstream':  openPurgeDownstreamModal(stageName); break;
    case 'run-build':       runBuild(stageName); break;
    case 'run-build-file':  runBuild(stageName, path.replace(/\.[^.]+$/, '')); break;
  }
});

async function openInTerminal(stageName, filePath, view) {
  const params = new URLSearchParams({
    pipeline: state.currentPipeline,
    stage:    stageName,
    view:     view,
  });
  if (filePath) params.set('path', filePath);
  try {
    const res = await fetch(`/api/resolve-path?${params}`);
    if (!res.ok) { await appAlert('Could not resolve path: ' + await res.text()); return; }
    const { abs_path } = await res.json();
    await fetch('/api/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: abs_path })
    });
  } catch(e) { await appAlert('Open terminal failed: ' + e.message); }
}

async function promptNewFile(stageName, basePath, viewHint) {
  stageName = stageName || getActiveStage();
  if (!stageName) { await appAlert('Select a stage first'); return; }
  const view = (viewHint && viewHint !== 'graph') ? viewHint : state.viewMode;
  let name, content = '';
  if (view === 'build') {
    const raw = await appPromptExt('New build file name:');
    if (!raw) return;
    name = raw.name + '.' + raw.ext;
    if (raw.ext === 'py') {
      content = 'env_block = """\n```env\nTARGET=\n```\n"""\nimport os\nimport time\nimport sys\nfrom lips.utils.parse_build_files import env_from_build_file\n_, env = env_from_build_file(env_block)\n';
    }
  } else {
    name = await appPrompt('New file name:');
    if (!name) return;
  }
  const relPath = basePath ? `${basePath}/${name}` : name;
  try {
    const res = await fetch(
      `/api/file/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}/${view}`,
      { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path: relPath, content}) }
    );
    if (!res.ok) { await appAlert('Error: ' + (await res.text())); return; }
    await refreshStageFiles(stageName);
    openFile(stageName, relPath);
  } catch(e) { await appAlert(e.message); }
}

async function promptNewFolder(stageName, basePath, viewHint) {
  stageName = stageName || getActiveStage();
  if (!stageName) { await appAlert('Select a stage first'); return; }
  const view = (viewHint && viewHint !== 'graph') ? viewHint : state.viewMode;
  const name = await appPrompt('New folder name:');
  if (!name) return;
  const relPath = basePath ? `${basePath}/${name}/` : `${name}/`;
  try {
    const res = await fetch(
      `/api/file/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}/${view}`,
      { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path: relPath, is_dir: true}) }
    );
    if (!res.ok) { await appAlert('Error: ' + (await res.text())); return; }
    await refreshStageFiles(stageName);
  } catch(e) { await appAlert(e.message); }
}

async function promptRename(stageName, path, viewHint) {
  if (!path) return;
  const view = (viewHint && viewHint !== 'graph') ? viewHint : state.viewMode;
  const oldName = path.split('/').pop();
  const newName = await appPrompt('Rename to:', oldName);
  if (!newName || newName === oldName) return;
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash >= 0 ? path.substring(0, lastSlash + 1) : '';
  try {
    const res = await fetch(
      `/api/rename/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}/${view}`,
      { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({old_path: path, new_path: dir + newName}) }
    );
    if (!res.ok) { await appAlert('Rename failed: ' + (await res.text())); return; }
    state.tabs = state.tabs.filter(t => !(t.stage === stageName && t.path === path));
    renderTabBar();
    if (state.activeTab !== null && state.activeTab >= state.tabs.length) activateTab(state.tabs.length - 1);
    await refreshStageFiles(stageName);
  } catch(e) { await appAlert(e.message); }
}

async function promptMove(stageName, path, viewHint) {
  if (!path) return;
  const view = (viewHint && viewHint !== 'graph') ? viewHint : state.viewMode;
  const dest = await appPrompt('Move to (new relative path):', path);
  if (!dest || dest === path) return;
  try {
    const res = await fetch(
      `/api/rename/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}/${view}`,
      { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({old_path: path, new_path: dest}) }
    );
    if (!res.ok) { await appAlert('Move failed: ' + (await res.text())); return; }
    state.tabs = state.tabs.filter(t => !(t.stage === stageName && t.path === path));
    renderTabBar();
    await refreshStageFiles(stageName);
  } catch(e) { await appAlert(e.message); }
}

async function confirmDelete(stageName, path, viewHint) {
  if (!path) return;
  const view = (viewHint && viewHint !== 'graph') ? viewHint : state.viewMode;
  if (!await appConfirm(`Move "${path}" to the Recycle Bin?`)) return;
  try {
    const res = await fetch(
      `/api/file/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}/${view}?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) { await appAlert('Delete failed: ' + (await res.text())); return; }
    state.tabs = state.tabs.filter(t => !(t.stage === stageName && t.path === path));
    renderTabBar();
    if (state.activeTab !== null && state.activeTab >= state.tabs.length) activateTab(state.tabs.length - 1);
    await refreshStageFiles(stageName);
  } catch(e) { await appAlert(e.message); }
}

async function promptRenameStage(oldName) {
  const newName = await appPrompt('Rename stage to:', oldName);
  if (!newName || newName === oldName) return;
  try {
    const res = await fetch(
      `/api/rename-stage/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(oldName)}`,
      { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ new_name: newName }) }
    );
    if (!res.ok) { await appAlert('Rename failed: ' + (await res.text())); return; }
    const data = await res.json();
    // Update any open tabs that belong to the old stage
    state.tabs.forEach(t => {
      if (t.stage === oldName) {
        t.stage = newName;
        t.label = t.label.replace(new RegExp('@' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '@' + newName);
        t.key   = tabKey(t.pipeline, newName, t.view, t.path);
      }
    });
    if (_focusedCtx && _focusedCtx.stageName === oldName) _focusedCtx.stageName = newName;
    renderTabBar();
    if (data.updated_files && data.updated_files.length > 0) {
      console.log('[rename-stage] updated TARGET= in:', data.updated_files);
    }
    await loadWorkspace(state.workspace);
    if (state.currentPipeline) await selectPipeline(state.currentPipeline);
  } catch(e) { await appAlert(e.message); }
}

function _handleFocusedRename() {
  if (!_focusedCtx) return;
  if (_focusedCtx.type === 'stage') {
    promptRenameStage(_focusedCtx.stageName);
  } else {
    promptRename(_focusedCtx.stageName, _focusedCtx.path, _focusedCtx.view);
  }
}

async function _handleFocusedDelete() {
  if (!_focusedCtx) return;
  if (_focusedCtx.type === 'stage') {
    openDeleteStageModal(_focusedCtx.stageName);
  } else {
    await confirmDelete(_focusedCtx.stageName, _focusedCtx.path, _focusedCtx.view);
  }
}

function getActiveStage() {
  if (state.activeTab !== null && state.tabs[state.activeTab]) {
    return state.tabs[state.activeTab].stage;
  }
  const active = document.querySelector('.stage-header.active');
  return active ? active.dataset.stage : null;
}

async function refreshStageFiles(stageName) {
  _graphDirty = true;
  await renderTree();
  expandStage(stageName);
  if (state.viewMode === 'graph') {
    await refreshGraphView();
  } else if (_grPopupLoaders[stageName]) {
    await _grPopupLoaders[stageName]('repo');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   STAGE ROW HELPERS  (used by Add Stages modal)
   ═══════════════════════════════════════════════════════════════════ */
function addStageRow(containerId) {
  const container = $(containerId);
  const row = document.createElement('div');
  row.className = 'stage-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'stage-name';
  nameInput.className = 'stage-row-name';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.textContent = '×';
  delBtn.className = 'stage-row-del';
  delBtn.addEventListener('click', () => row.remove());

  row.append(nameInput, delBtn);
  container.appendChild(row);
  nameInput.focus();
}

function collectStages(containerId) {
  const container = $(containerId);
  const result = [];
  for (const row of container.querySelectorAll('.stage-row')) {
    const name = row.querySelector('.stage-row-name')?.value.trim() ?? '';
    if (name) result.push({ name, build_file: '' });
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════
   MODAL — ADD STAGES
   ═══════════════════════════════════════════════════════════════════ */
function openStagesModal() {
  if (!state.currentPipeline) { appAlert('Select a pipeline first'); return; }
  $('thread-modal').classList.remove('hidden');
  $('th-pipe-name').textContent = state.currentPipeline;
  $('th-stages').innerHTML = '';
  addStageRow('th-stages');
  $('th-err').classList.add('hidden');
}
$('btn-close-thread').addEventListener('click',  () => $('thread-modal').classList.add('hidden'));
$('btn-cancel-thread').addEventListener('click', () => $('thread-modal').classList.add('hidden'));
$('btn-th-add').addEventListener('click', () => addStageRow('th-stages'));

$('btn-submit-thread').addEventListener('click', async () => {
  const stages = collectStages('th-stages');
  if (!stages.length) { showModalErr('th-err', 'Add at least one stage'); return; }
  const overwrite = $('th-overwrite').checked;
  try {
    const res = await fetch('/api/create/pipeline', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: state.currentPipeline, stages, append_only: true, overwrite })
    });
    if (!res.ok) { showModalErr('th-err', await res.text()); return; }
    const data = await res.json();
    $('thread-modal').classList.add('hidden');
    await loadWorkspace(state.workspace);
    await selectPipeline(state.currentPipeline);
    if (!overwrite && data.skipped && data.skipped.length > 0) {
      await appAlert(
        `${data.skipped.length} build file(s) already existed and were not overwritten:\n` +
        data.skipped.map(f => `  • ${f}`).join('\n')
      );
    }
  } catch(e) { showModalErr('th-err', e.message); }
});

/* ═══════════════════════════════════════════════════════════════════
   MODAL — CREATE PIPELINE
   ═══════════════════════════════════════════════════════════════════ */
let _crProviders = [];

function openCreateModal() {
  $('create-modal').classList.remove('hidden');
  $('cr-name').value = '';
  $('cr-err').classList.add('hidden');
  loadCreateProviders();
}

/* Fetch workspace .env keys and populate an api-var <select>.
   Adds a blank first option and an "other…" free-text fallback. */
async function _populateApiVarSelect(selId, selectedVal) {
  const sel = $(selId);
  let keys = [];
  try {
    const res = await fetch('/api/env/workspace/keys');
    const data = await res.json();
    keys = data.keys || [];
  } catch {}
  sel.innerHTML = '';
  // blank / none option
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '— none —';
  sel.appendChild(blank);
  for (const k of keys) {
    const opt = document.createElement('option');
    opt.value = k; opt.textContent = k;
    sel.appendChild(opt);
  }
  // if saved value not in list, add it as an option
  if (selectedVal && !keys.includes(selectedVal)) {
    const opt = document.createElement('option');
    opt.value = selectedVal; opt.textContent = selectedVal;
    sel.appendChild(opt);
  }
  if (selectedVal !== undefined) sel.value = selectedVal || '';
}

async function loadCreateProviders() {
  try {
    const res = await fetch('/api/create/providers');
    const data = await res.json();
    _crProviders = data.providers || [];
    const pSel = $('cr-provider');
    pSel.innerHTML = '';
    for (const p of _crProviders) {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      pSel.appendChild(opt);
    }
    await _populateApiVarSelect('cr-api-var', '');
    updateCreateModels();
  } catch {}
}

function updateCreateModels() {
  const pId = $('cr-provider').value;
  const provider = _crProviders.find(p => p.id === pId);
  const mSel = $('cr-model');
  mSel.innerHTML = '';
  for (const m of (provider?.models || [])) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    mSel.appendChild(opt);
  }
  // suggest the provider's default api_var if select is blank
  const varSel = $('cr-api-var');
  if (!varSel.value && provider?.api_var) {
    varSel.value = provider.api_var;
  }
}

$('cr-provider').addEventListener('change', updateCreateModels);
$('btn-close-create').addEventListener('click',  () => $('create-modal').classList.add('hidden'));
$('btn-cancel-create').addEventListener('click', () => $('create-modal').classList.add('hidden'));

$('btn-submit-create').addEventListener('click', async () => {
  const name = $('cr-name').value.trim();
  if (!name) { showModalErr('cr-err', 'Pipeline name required'); return; }
  const payload = {
    name,
    provider:    $('cr-provider').value,
    model:       $('cr-model-manual').value.trim() || $('cr-model').value,
    max_tokens:  parseInt($('cr-max-tokens').value) || 20000,
    temperature: parseFloat($('cr-temperature').value) || 0,
    api_var:     $('cr-api-var').value,
  };
  try {
    const res = await fetch('/api/create/pipeline', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if (!res.ok) { showModalErr('cr-err', await res.text()); return; }
    $('create-modal').classList.add('hidden');
    await loadWorkspace(state.workspace);
    await selectPipeline(name);
  } catch(e) { showModalErr('cr-err', e.message); }
});

/* ═══════════════════════════════════════════════════════════════════
   MODAL — CONFIG
   ═══════════════════════════════════════════════════════════════════ */
let _cfgProviders = [];

async function openConfigModal() {
  if (!state.currentPipeline) { await appAlert('Select a pipeline first'); return; }
  $('config-modal').classList.remove('hidden');
  $('cfg-pipe-name').textContent = state.currentPipeline;
  try {
    const res = await fetch(`/api/config/${encodeURIComponent(state.currentPipeline)}`);
    if (!res.ok) { await appAlert('Error loading config: ' + await res.text()); return; }
    const cfg = await res.json();
    const pRes = await fetch('/api/create/providers');
    const pData = await pRes.json();
    _cfgProviders = pData.providers || [];

    const pSel = $('cfg-provider');
    pSel.innerHTML = '';
    for (const p of _cfgProviders) {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      pSel.appendChild(opt);
    }
    if (cfg.provider) pSel.value = cfg.provider;
    updateCfgModels(cfg.model);

    $('cfg-max-tokens').value  = cfg.max_tokens  || 20000;
    $('cfg-temperature').value = cfg.temperature ?? 0;
    await _populateApiVarSelect('cfg-api-var', cfg.api_var || '');
  } catch(e) { await appAlert('Error loading config: ' + e.message); }
}

function updateCfgModels(selectedModel) {
  const pId = $('cfg-provider').value;
  const provider = _cfgProviders.find(p => p.id === pId);
  const mSel = $('cfg-model-sel');
  mSel.innerHTML = '';
  for (const m of (provider?.models || [])) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    mSel.appendChild(opt);
  }
  if (selectedModel) mSel.value = selectedModel;
  // suggest provider default only if currently blank
  const varSel = $('cfg-api-var');
  if (!varSel.value && provider?.api_var) varSel.value = provider.api_var;
}

$('cfg-provider').addEventListener('change', () => updateCfgModels());
$('btn-close-config').addEventListener('click', () => $('config-modal').classList.add('hidden'));
$('btn-cancel-config').addEventListener('click', () => $('config-modal').classList.add('hidden'));

$('btn-submit-config').addEventListener('click', async () => {
  const payload = {
    provider:    $('cfg-provider').value,
    model:       $('cfg-model-manual').value.trim() || $('cfg-model-sel').value,
    max_tokens:  parseInt($('cfg-max-tokens').value) || 20000,
    temperature: parseFloat($('cfg-temperature').value) ?? 0,
    api_var:     $('cfg-api-var').value,
  };
  try {
    const res = await fetch(`/api/config/${encodeURIComponent(state.currentPipeline)}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if (!res.ok) { await appAlert('Save failed: ' + await res.text()); return; }
    $('config-modal').classList.add('hidden');
  } catch(e) { await appAlert('Error: ' + e.message); }
});

$('btn-open-config-json').addEventListener('click', async () => {
  $('config-modal').classList.add('hidden');
  const key = `__config__${state.currentPipeline}`;
  const existing = state.tabs.findIndex(t => t.key === key);
  if (existing >= 0) { activateTab(existing); return; }
  try {
    const res = await fetch(`/api/config/${encodeURIComponent(state.currentPipeline)}`);
    const raw = await res.text();
    const content = JSON.stringify(JSON.parse(raw), null, 2);
    state.tabs.push({ key, pipeline: state.currentPipeline, stage: '__root__', view: 'repo',
      path: 'config.json', label: 'config.json', _fname: 'config.json',
      content, modified: false, _configJson: true });
    renderTabBar(); activateTab(state.tabs.length - 1);
  } catch(e) { await appAlert('Error opening config.json: ' + e.message); }
});

$('btn-edit-messages').addEventListener('click', () => {
  $('config-modal').classList.add('hidden');
  openMessagesModal();
});


/* ═══════════════════════════════════════════════════════════════════
   MODAL — WORKSPACE ENV
   ═══════════════════════════════════════════════════════════════════ */
let _envRows = [];   // [{key, value}]

function _parseEnvContent(content) {
  return (content || '').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return i < 0 ? {key: l, value: ''} : {key: l.slice(0,i).trim(), value: l.slice(i+1).trim()}; });
}

function _envRowsToContent(rows) {
  return rows.filter(r => r.key.trim()).map(r => `${r.key}=${r.value}`).join('\n');
}

function renderEnvList() {
  const list = $('env-list');
  list.innerHTML = '';
  _envRows.forEach((row, i) => {
    const div = el('div', 'env-row');
    const kInp = document.createElement('input');
    kInp.type = 'text'; kInp.placeholder = 'KEY'; kInp.value = row.key; kInp.className = 'env-key-input';
    kInp.addEventListener('input', () => { _envRows[i].key = kInp.value; });
    const vInp = document.createElement('input');
    vInp.type = 'text'; vInp.placeholder = 'value'; vInp.value = row.value; vInp.className = 'env-val-input';
    vInp.addEventListener('input', () => { _envRows[i].value = vInp.value; });
    const del = el('button', 'stage-row-del', '×');
    del.addEventListener('click', () => { _envRows.splice(i, 1); renderEnvList(); });
    div.append(kInp, vInp, del);
    list.appendChild(div);
  });
}

async function openEnvModal() {
  $('env-modal').classList.remove('hidden');
  try {
    const res = await fetch('/api/env/workspace');
    const data = await res.json();
    _envRows = _parseEnvContent(data.content || '');
    renderEnvList();
  } catch {}
}
$('btn-close-env').addEventListener('click',  () => $('env-modal').classList.add('hidden'));
$('btn-cancel-env').addEventListener('click', () => $('env-modal').classList.add('hidden'));
$('btn-env-add').addEventListener('click', () => { _envRows.push({key:'', value:''}); renderEnvList(); });
$('btn-submit-env').addEventListener('click', async () => {
  try {
    const content = _envRowsToContent(_envRows);
    const res = await fetch('/api/env/workspace', {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ content })
    });
    if (!res.ok) { await appAlert('Save failed: ' + await res.text()); return; }
    $('env-modal').classList.add('hidden');
  } catch(e) { await appAlert('Error: ' + e.message); }
});


/* ═══════════════════════════════════════════════════════════════════
   MODAL — MESSAGES
   ═══════════════════════════════════════════════════════════════════ */
let _msgs = [];

async function openMessagesModal() {
  if (!state.currentPipeline) return;
  _msgs = [];
  $('messages-modal').classList.remove('hidden');
  $('msg-pipe-name').textContent = state.currentPipeline;
  renderMessagesEditor();
  try {
    const res = await fetch(`/api/config/${encodeURIComponent(state.currentPipeline)}/messages`);
    const data = await res.json();
    _msgs = data.messages || [];
    renderMessagesEditor();
  } catch(e) { await appAlert('Error: ' + e.message); }
}

function renderMessagesEditor() {
  const container = $('msg-list');
  container.innerHTML = '';
  _msgs.forEach((msg, i) => {
    const row = el('div', 'msg-row');

    // ↑ ↓ reorder column
    const reorderCol = el('div', 'msg-reorder-col');
    const btnUp = el('button', 'msg-move-btn', '↑');
    btnUp.title = 'Move up';
    btnUp.disabled = i === 0;
    btnUp.addEventListener('click', () => {
      [_msgs[i - 1], _msgs[i]] = [_msgs[i], _msgs[i - 1]];
      renderMessagesEditor();
    });
    const btnDn = el('button', 'msg-move-btn', '↓');
    btnDn.title = 'Move down';
    btnDn.disabled = i === _msgs.length - 1;
    btnDn.addEventListener('click', () => {
      [_msgs[i], _msgs[i + 1]] = [_msgs[i + 1], _msgs[i]];
      renderMessagesEditor();
    });
    reorderCol.append(btnUp, btnDn);

    const roleSel = document.createElement('select');
    roleSel.className = 'msg-role-sel';
    for (const r of ['system','user','assistant']) {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      if (msg.role === r) opt.selected = true;
      roleSel.appendChild(opt);
    }
    roleSel.addEventListener('change', () => {
      _msgs[i].role = roleSel.value;
      $('msg-err').classList.add('hidden');
    });

    const ta = document.createElement('textarea');
    ta.className = 'msg-content-ta';
    ta.value = msg.content || '';
    ta.addEventListener('input', () => { _msgs[i].content = ta.value; });

    const del = el('button', 'msg-del-btn', '×');
    del.title = 'Delete';
    del.addEventListener('click', () => { _msgs.splice(i, 1); renderMessagesEditor(); });

    row.append(reorderCol, roleSel, ta, del);
    container.appendChild(row);
  });
}

$('btn-msg-add').addEventListener('click', () => {
  _msgs.push({ role: 'user', content: '' });
  renderMessagesEditor();
});
$('btn-close-messages').addEventListener('click',  () => $('messages-modal').classList.add('hidden'));
$('btn-cancel-messages').addEventListener('click', () => $('messages-modal').classList.add('hidden'));
$('btn-submit-messages').addEventListener('click', async () => {
  // Validate: no consecutive messages with the same role
  for (let i = 1; i < _msgs.length; i++) {
    if (_msgs[i].role === _msgs[i - 1].role) {
      showModalErr('msg-err', `Messages ${i} and ${i + 1} both have role "${_msgs[i].role}" — consecutive same-role messages are not allowed.`);
      return;
    }
  }
  $('msg-err').classList.add('hidden');
  try {
    const res = await fetch(`/api/config/${encodeURIComponent(state.currentPipeline)}/messages`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ messages: _msgs })
    });
    if (!res.ok) { await appAlert('Save failed: ' + await res.text()); return; }
    $('messages-modal').classList.add('hidden');
  } catch(e) { await appAlert('Error: ' + e.message); }
});

/* ═══════════════════════════════════════════════════════════════════
   MODAL — PURGE
   ═══════════════════════════════════════════════════════════════════ */
let _purgeAction = null;

function openPurgeOutModal(stageName) {
  $('purge-msg').textContent = `Clear out/ for stage "${stageName}"? Output files will be moved to the Recycle-Bin.`;
  _purgeAction = async () => {
    const res = await fetch(
      `/api/purge-out/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}`,
      { method: 'POST' }
    );
    if (!res.ok) throw new Error(await res.text());
    await refreshStageFiles(stageName);
  };
  $('purge-modal').classList.remove('hidden');
}

function openPurgeStageModal(stageName) {
  $('purge-msg').textContent = `Purge stage "${stageName}"? Repo files will be moved to the Recycle-Bin (out/ is preserved).`;
  _purgeAction = async () => {
    const res = await fetch(
      `/api/purge/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}`,
      { method: 'POST' }
    );
    if (!res.ok) throw new Error(await res.text());
    await refreshStageFiles(stageName);
  };
  $('purge-modal').classList.remove('hidden');
}

function openPurgePipelineModal() {
  if (!state.currentPipeline) { appAlert('Select a pipeline first'); return; }
  $('purge-msg').textContent = `Purge entire pipeline "${state.currentPipeline}"? All stage repo/ contents will be moved to the Recycle-Bin (out/ dirs preserved).`;
  _purgeAction = async () => {
    const res = await fetch(
      `/api/purge/${encodeURIComponent(state.currentPipeline)}`,
      { method: 'POST' }
    );
    if (!res.ok) throw new Error(await res.text());
    await renderTree();
  };
  $('purge-modal').classList.remove('hidden');
}

/* ── Graph traversal helpers ──────────────────────────────────────────────── */

/** BFS upstream (follow edges backward: find all stages that feed into `start`). */
function _graphUpstream(start) {
  const visited = new Set();
  const queue   = [start];
  while (queue.length) {
    const node = queue.shift();
    if (visited.has(node)) continue;
    visited.add(node);
    for (const { from, to } of _grEdgeList)
      if (to === node && !visited.has(from)) queue.push(from);
  }
  visited.delete(start);
  return [...visited];
}

/** BFS downstream (follow edges forward: find all stages that `start` feeds into). */
function _graphDownstream(start) {
  const visited = new Set();
  const queue   = [start];
  while (queue.length) {
    const node = queue.shift();
    if (visited.has(node)) continue;
    visited.add(node);
    for (const { from, to } of _grEdgeList)
      if (from === node && !visited.has(to)) queue.push(to);
  }
  visited.delete(start);
  return [...visited];
}

function openPurgeUpstreamModal(stageName) {
  const targets = [stageName, ..._graphUpstream(stageName)].filter(s => s !== 'Void');
  $('purge-msg').textContent =
    `Purge ${targets.length} stage(s) (self + upstream) of "${stageName}"? ` +
    `(${targets.join(', ')}) — repo files will be moved to the Recycle-Bin.`;
  _purgeAction = async () => {
    for (const s of targets) {
      const res = await fetch(
        `/api/purge/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(s)}`,
        { method: 'POST' }
      );
      if (!res.ok) throw new Error(await res.text());
    }
    await refreshGraphView();
  };
  $('purge-modal').classList.remove('hidden');
}

function openPurgeDownstreamModal(stageName) {
  const targets = [stageName, ..._graphDownstream(stageName)].filter(s => s !== 'Void');
  $('purge-msg').textContent =
    `Purge ${targets.length} stage(s) (self + downstream) of "${stageName}"? ` +
    `(${targets.join(', ')}) — repo files will be moved to the Recycle-Bin.`;
  _purgeAction = async () => {
    for (const s of targets) {
      const res = await fetch(
        `/api/purge/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(s)}`,
        { method: 'POST' }
      );
      if (!res.ok) throw new Error(await res.text());
    }
    await refreshGraphView();
  };
  $('purge-modal').classList.remove('hidden');
}

$('btn-close-purge').addEventListener('click',  () => $('purge-modal').classList.add('hidden'));
$('btn-cancel-purge').addEventListener('click', () => $('purge-modal').classList.add('hidden'));
$('btn-confirm-purge').addEventListener('click', async () => {
  $('purge-modal').classList.add('hidden');
  if (!_purgeAction) return;
  try { await _purgeAction(); } catch(e) { await appAlert('Purge failed: ' + e.message); }
  _purgeAction = null;
});

/* ═══════════════════════════════════════════════════════════════════
   MODAL — DELETE STAGE / PIPELINE
   ═══════════════════════════════════════════════════════════════════ */
let _deleteAction = null;

function openDeleteStageModal(stageName) {
  $('delete-msg').textContent = `Move stage "${stageName}" and all its files to the Recycle Bin?`;
  _deleteAction = async () => {
    const res = await fetch(
      `/api/stage/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stageName)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) throw new Error(await res.text());
    await loadWorkspace(state.workspace);
    await selectPipeline(state.currentPipeline);
  };
  $('delete-modal').classList.remove('hidden');
}

function openDeletePipelineModal() {
  if (!state.currentPipeline) { appAlert('Select a pipeline first'); return; }
  $('delete-msg').textContent = `Move pipeline "${state.currentPipeline}" and all its stages to the Recycle Bin?`;
  _deleteAction = async () => {
    const res = await fetch(
      `/api/pipeline/${encodeURIComponent(state.currentPipeline)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) throw new Error(await res.text());
    state.currentPipeline = null;
    state.tabs = []; state.activeTab = null;
    renderTabBar(); showEmptyEditor();
    await loadWorkspace(state.workspace);
  };
  $('delete-modal').classList.remove('hidden');
}

$('btn-close-delete').addEventListener('click',  () => $('delete-modal').classList.add('hidden'));
$('btn-cancel-delete').addEventListener('click', () => $('delete-modal').classList.add('hidden'));
$('btn-confirm-delete').addEventListener('click', async () => {
  $('delete-modal').classList.add('hidden');
  if (!_deleteAction) return;
  try { await _deleteAction(); } catch(e) { await appAlert('Delete failed: ' + e.message); }
  _deleteAction = null;
});

/* ═══════════════════════════════════════════════════════════════════
   TAB BAR ACTIONS
   ═══════════════════════════════════════════════════════════════════ */
$('btn-toggle-preview').addEventListener('click', togglePreview);

$('btn-graph-collapse').addEventListener('click', async () => {
  if (!_grCanvasEl) return;
  if (Object.keys(_grPopups).length > 0) {
    // Close all
    Object.keys(_grPopups).forEach(stage => {
      _grPopups[stage].remove();
      delete _grPopups[stage];
      delete _grPopupLoaders[stage];
    });
    _adjustGraphLayout();
  } else {
    // Open all
    for (const stage of _grStages) {
      const nc = _grNodeCoords[stage];
      if (nc) await openGraphNodePopup(stage, nc.x, nc.y, _GR.H, _grCanvasEl);
    }
  }
});

$('btn-graph-recenter').addEventListener('click', () => {
  if (!_grCanvasEl || !Object.keys(_grNodeCoords).length || !_grApplyXform) return;
  const { W, H } = _GR;
  const xs = Object.values(_grNodeCoords).map(c => c.x);
  const ys = Object.values(_grNodeCoords).map(c => c.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs) + W;
  const minY = Math.min(...ys), maxY = Math.max(...ys) + H;
  const graphW = maxX - minX, graphH = maxY - minY;
  const container = $('graph-container');
  const vw = container.clientWidth, vh = container.clientHeight;
  const pad = 60;
  _grScale = Math.max(0.15, Math.min(2, Math.min((vw - pad * 2) / graphW, (vh - pad * 2) / graphH)));
  _grPanX  = (vw - graphW * _grScale) / 2 - minX * _grScale;
  _grPanY  = (vh - graphH * _grScale) / 2 - minY * _grScale;
  _grApplyXform();
});

/* Re-render the graph and restore any open repo popups. */
async function refreshGraphView() {
  const openStages = Object.keys(_grPopups);
  // Clear stale refs — DOM nodes will be wiped by renderGraphView's container.innerHTML=''
  Object.keys(_grPopups).forEach(k => { delete _grPopups[k]; delete _grPopupLoaders[k]; });
  await renderGraphView();
  _graphDirty = false;
  // Re-open popups that were visible before the refresh
  for (const stage of openStages) {
    const nc = _grNodeCoords[stage];
    if (nc && _grCanvasEl) await openGraphNodePopup(stage, nc.x, nc.y, _GR.H, _grCanvasEl);
  }
}

$('btn-graph-refresh').addEventListener('click', async () => { await refreshGraphView(); });

// Persistent fallback: empty-space right-click when no SVG bgRect exists (no pipeline / no stages)
$('graph-container').addEventListener('contextmenu', e => {
  e.preventDefault();
  const ctx = $('ctx-menu');
  ctx.innerHTML = '';
  ctx.dataset.stage = ''; ctx.dataset.path = ''; ctx.dataset.isdir = 'false'; ctx.dataset.view = '';
  ctx.appendChild(_ctxItem('New Stage…',  'gr-new-stage'));
  ctx.classList.remove('hidden');
  ctx.style.left = e.clientX + 'px';
  ctx.style.top  = e.clientY + 'px';
  requestAnimationFrame(() => {
    const r2 = ctx.getBoundingClientRect();
    if (r2.right  > window.innerWidth)  ctx.style.left = (e.clientX - r2.width)  + 'px';
    if (r2.bottom > window.innerHeight) ctx.style.top  = (e.clientY - r2.height) + 'px';
  });
});

$('btn-close-all-tabs').addEventListener('click', async () => {
  await closeAllTabs();
});

$('btn-close-others').addEventListener('click', () => {
  if (state.activeTab === null) return;
  const keep = state.tabs[state.activeTab];
  state.tabs = [keep];
  state.activeTab = 0;
  renderTabBar();
  loadIntoEditor(keep);
});

/* ═══════════════════════════════════════════════════════════════════
   BUILD OUTPUT PANEL
   ═══════════════════════════════════════════════════════════════════ */
$('btn-toggle-output').addEventListener('click', () => {
  _outputVisible = !_outputVisible;
  $('app').classList.toggle('output-hidden', !_outputVisible);
  $('btn-toggle-output').textContent = _outputVisible ? '▼' : '▲';
  $('btn-toggle-output').title = _outputVisible ? 'Hide output' : 'Show output';
});

$('btn-clear-output').addEventListener('click', () => {
  $('build-output').textContent = '';
});

$('btn-copy-output').addEventListener('click', () => {
  const text = $('build-output').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = $('btn-copy-output');
    const prev = btn.innerHTML;
    btn.innerHTML = '&#10003;';
    setTimeout(() => { btn.innerHTML = prev; }, 1500);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════════════════ */
/* ── Modal Escape / Enter ──────────────────────────────────────────
   Each entry: { id, cancelFn, submitFn }
   cancelFn: closes the modal (Escape)
   submitFn: clicks the primary action button (Enter) — null = same as cancel
   ────────────────────────────────────────────────────────────────── */
const _MODAL_STACK = [
  { id: 'thread-modal',   cancelFn: () => $('thread-modal').classList.add('hidden'),   submitFn: () => $('btn-submit-thread').click() },
  { id: 'create-modal',   cancelFn: () => $('create-modal').classList.add('hidden'),   submitFn: () => $('btn-submit-create').click()  },
  { id: 'config-modal',   cancelFn: () => $('config-modal').classList.add('hidden'),   submitFn: () => $('btn-submit-config').click()  },
  { id: 'env-modal',      cancelFn: () => $('env-modal').classList.add('hidden'),      submitFn: () => $('btn-submit-env').click()     },
  { id: 'messages-modal', cancelFn: () => $('messages-modal').classList.add('hidden'), submitFn: () => $('btn-submit-messages').click()},
  { id: 'purge-modal',    cancelFn: () => $('purge-modal').classList.add('hidden'),    submitFn: () => $('btn-confirm-purge').click()  },
  { id: 'delete-modal',   cancelFn: () => $('delete-modal').classList.add('hidden'),   submitFn: () => $('btn-confirm-delete').click() },
  { id: 'app-alert-modal',   cancelFn: () => $('app-alert-ok').click(),    submitFn: () => $('app-alert-ok').click()    },
  { id: 'app-confirm-modal', cancelFn: () => $('app-confirm-cancel').click(), submitFn: () => $('app-confirm-ok').click() },
  // app-prompt-modal is handled internally in appPrompt()
];

document.addEventListener('keydown', async e => {
  // — Escape / Enter for modals (top of stack wins) ——————————————
  if (e.key === 'Escape' || e.key === 'Enter') {
    // Don't steal Enter from textareas or the app-prompt input (handled internally)
    const tag = document.activeElement && document.activeElement.tagName;
    if (e.key === 'Enter' && (tag === 'TEXTAREA' || document.activeElement.id === 'app-prompt-input')) {
      // let it propagate normally
    } else {
      // Find topmost visible modal
      for (const m of [..._MODAL_STACK].reverse()) {
        const el = $(m.id);
        if (el && !el.classList.contains('hidden')) {
          e.preventDefault();
          if (e.key === 'Escape') m.cancelFn();
          else if (e.key === 'Enter' && m.submitFn) m.submitFn();
          return;
        }
      }
      // No modal open — Escape closes context menu
      if (e.key === 'Escape') $('ctx-menu').classList.add('hidden');
    }
  }

  // F2 = rename focused sidebar item; Delete = delete it (only when editor not focused)
  if (e.key === 'F2' && _focusedCtx && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    _handleFocusedRename();
    return;
  }
  if (e.key === 'Delete' && _focusedCtx && !(cm && cm.hasFocus()) && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    await _handleFocusedDelete();
    return;
  }

  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 's') { e.preventDefault(); e.shiftKey ? saveAllTabs() : saveActiveTab(); }
  if (ctrl && e.key === 'w') { e.preventDefault(); if (state.activeTab !== null) await closeTab(state.activeTab); }
  if (ctrl && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
  if (ctrl && e.key === 'f') { e.preventDefault(); cmFind(); }
  if (ctrl && e.key === 'h') { e.preventDefault(); cmReplace(); }
  if (ctrl && e.key === 'g') { e.preventDefault(); cmGoToLine(); }
  if (ctrl && e.key === '=') { e.preventDefault(); changeFontSize(1); }
  if (ctrl && e.key === '-') { e.preventDefault(); changeFontSize(-1); }
});

window.addEventListener('beforeunload', e => {
  if (state.tabs.some(t => t.modified)) {
    e.preventDefault();
    return (e.returnValue = '');
  }
});

/* ═══════════════════════════════════════════════════════════════════
   GRAPH NODE POPUP — floating repo file tree (lives inside canvas)
   ═══════════════════════════════════════════════════════════════════ */
const _grPopups = {};        // stageName → popup element
const _grPopupLoaders = {};  // stageName → _loadPopup(view) fn
let _graphDirty  = true;
let _grCanvasEl  = null;  // current .gr-canvas element
let _grNodeCoords = {};  // stageName → {x,y} original coords
let _grSvgEl     = null;  // current graph <svg> element
let _grStages    = [];    // current stage list (for port drag hit-testing)
let _grEdgeList  = [];    // [{key, from, to}] — kept in sync with DOM for spread recompute
let _grNodeSizes = {};    // stageName → {w, h, ox, oy} visual overrides (Void uses this)
let _grScale     = 1;     // current graph zoom level (for popup drag conversion)
let _grPanX      = 0;     // current pan X
let _grPanY      = 0;     // current pan Y
let _grApplyXform = null; // () => void — apply current pan/zoom to canvas
let _grEventCtrl  = null; // AbortController for per-render pan/zoom listeners
let _portDrag    = null;  // { fromStage, svgX1, svgY1, line, portRect } — active port drag
let _portDragTarget = null; // stage name of currently hovered target box
let _portDragJustFinished = false; // set briefly after mouseup to swallow the trailing click
let _nodeDrag    = null;  // { s, g, startCX, startCY, startNX, startNY, popupOffsetX, popupOffsetY }
let _nodeDragged = false; // true once mouse has moved enough — suppresses the click-to-popup

// stageName → canvas-local {x, y} top-left anchor (set by caller)
async function openGraphNodePopup(stageName, nodeX, nodeY, nodeH, canvas) {
  // Toggle: click same stage → close its popup; otherwise open a new one
  if (_grPopups[stageName]) {
    _grPopups[stageName].remove();
    delete _grPopups[stageName];
    delete _grPopupLoaders[stageName];
    _adjustGraphLayout();
    return;
  }

  const popup = el('div', 'gr-file-popup');
  popup.dataset.stage = stageName;
  _grPopups[stageName] = popup;

  // ── Header ───────────────────────────────────────────────────────
  const hdr = el('div', 'gr-fp-hdr');
  hdr.style.cursor = 'grab';
  const title = el('span', 'gr-fp-title', stageName);
  hdr.appendChild(title);
  hdr.addEventListener('click', ev => { ev.stopPropagation(); $('ctx-menu').classList.add('hidden'); });

  // ── Drag-to-reposition ───────────────────────────────────────────
  hdr.addEventListener('mousedown', ev => {
    if (ev.target.closest('.gr-fp-close') || ev.target.closest('.gr-fp-view')) return;
    ev.stopPropagation();
    ev.preventDefault();
    const startX    = ev.clientX, startY = ev.clientY;
    const startLeft = parseFloat(popup.style.left) || 0;
    const startTop  = parseFloat(popup.style.top)  || 0;
    hdr.style.cursor = 'grabbing';
    const posKey = `lipside-popup-pos::${state.currentPipeline}::${stageName}`;
    const onMove = e => {
      popup.style.left = (startLeft + (e.clientX - startX) / _grScale) + 'px';
      popup.style.top  = (startTop  + (e.clientY - startY) / _grScale) + 'px';
      _adjustGraphLayout();
    };
    const onUp = () => {
      hdr.style.cursor = 'grab';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      const _nc = _grNodeCoords[stageName] || { x: nodeX, y: nodeY };
      localStorage.setItem(posKey, JSON.stringify({
        offX: parseFloat(popup.style.left) - _nc.x,
        offY: parseFloat(popup.style.top)  - _nc.y,
      }));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  });

  popup.appendChild(hdr);

  // ── File tree ────────────────────────────────────────────────────
  const treeDiv = el('div', 'gr-fp-tree');
  popup.appendChild(treeDiv);

  // ── Helpers ──────────────────────────────────────────────────────
  async function _popupFetch(stage, subpath, view) {
    const url = `/api/files/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(stage)}/${view}`
      + (subpath ? `?subpath=${encodeURIComponent(subpath)}` : '');
    const res = await fetch(url);
    if (!res.ok) return [];
    return (await res.json()).files || [];
  }
  async function _popupExpandDir(hdrEl, stage, dirPath, depth, view) {
    const dirItem  = hdrEl.closest('.dir-item');
    const children = dirItem.querySelector(':scope > .dir-children');
    const arrow    = hdrEl.querySelector('.dir-arrow');
    const icon     = hdrEl.querySelector('.dir-folder-icon');
    arrow.classList.add('open');
    if (icon) icon.textContent = '📂';
    children.classList.remove('hidden');
    if (children.children.length === 0) {
      const saved = state.viewMode;
      state.viewMode = view;
      const files = await _popupFetch(stage, dirPath, view);
      renderFilesInto(children, stage, files, dirPath, depth + 1);
      state.viewMode = saved;
    }
  }
  async function _loadPopup(view) {
    treeDiv.innerHTML = '<span style="color:var(--fg-dim);font-size:11px;padding:6px 8px;display:block">Loading…</span>';
    try {
      const files = await _popupFetch(stageName, '', view);
      const saved = state.viewMode;
      state.viewMode = view;
      renderFilesInto(treeDiv, stageName, files, '', 0);
      state.viewMode = saved;
      if (files.length === 0) {
        treeDiv.innerHTML = '<span class="gr-fp-empty">empty</span>';
      }
    } catch(err) {
      treeDiv.textContent = 'Error: ' + err.message;
    }
  }

  _grPopupLoaders[stageName] = _loadPopup;

  // ── Tree click delegation ─────────────────────────────────────────
  treeDiv.addEventListener('click', async ev => {
    ev.stopPropagation();
    $('ctx-menu').classList.add('hidden');
    const dirHdr2 = ev.target.closest('.dir-header');
    if (dirHdr2) {
      const dn     = dirHdr2.dataset.path;
      const depth2 = parseInt(dirHdr2.dataset.depth || '0');
      const children2 = dirHdr2.closest('.dir-item').querySelector(':scope > .dir-children');
      if (children2.classList.contains('hidden')) {
        await _popupExpandDir(dirHdr2, stageName, dn, depth2, 'repo');
      } else {
        _collapseDir(dirHdr2, stageName, dn);
      }
      return;
    }
    // run-button inside file item → trigger build, don't open
    if (ev.target.closest('.file-run-btn')) {
      const btn = ev.target.closest('.file-run-btn');
      runBuild(btn.dataset.stage, btn.dataset.stem);
      return;
    }
    const fileItem2 = ev.target.closest('.file-item');
    if (fileItem2) {
      await openFile(fileItem2.dataset.stage, fileItem2.dataset.path, 'repo');
    }
  });

  // ── Right-click inside popup → context menu ───────────────────────
  popup.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    const fileItem2 = ev.target.closest('.file-item');
    const dirHdr2   = ev.target.closest('.dir-header');
    const ctx = $('ctx-menu');
    ctx.innerHTML = '';
    ctx.dataset.view = 'repo';

    if (fileItem2) {
      ctx.dataset.stage = fileItem2.dataset.stage;
      ctx.dataset.path  = fileItem2.dataset.path;
      ctx.dataset.isdir = 'false';
      ctx.appendChild(_ctxItem('\uD83D\uDCC4 Open in Terminal', 'open-terminal'));
      ctx.appendChild(_ctxSep());
      ctx.appendChild(_ctxItem('Rename...', 'rename'));
      ctx.appendChild(_ctxItem('Move to...', 'move'));
      ctx.appendChild(_ctxSep());
      ctx.appendChild(_ctxItem('Delete File', 'delete', true));
    } else if (dirHdr2) {
      ctx.dataset.stage = dirHdr2.dataset.stage;
      ctx.dataset.path  = dirHdr2.dataset.path;
      ctx.dataset.isdir = 'true';
      ctx.appendChild(_ctxItem('New File', 'new-file'));
      ctx.appendChild(_ctxItem('New Folder', 'new-folder'));
      ctx.appendChild(_ctxItem('\uD83D\uDCCB Paste from Clipboard', 'paste-clipboard'));
      ctx.appendChild(_ctxSep());
      ctx.appendChild(_ctxItem('\uD83D\uDCC4 Open in Terminal', 'open-terminal'));
      ctx.appendChild(_ctxSep());
      ctx.appendChild(_ctxItem('Rename...', 'rename'));
      ctx.appendChild(_ctxItem('Move to...', 'move'));
      ctx.appendChild(_ctxSep());
      ctx.appendChild(_ctxItem('Delete Folder', 'delete', true));
    } else {
      // empty area or header → stage-level
      ctx.dataset.stage = stageName;
      ctx.dataset.path  = '';
      ctx.dataset.isdir = 'false';
      ctx.appendChild(_ctxItem('New File', 'new-file'));
      ctx.appendChild(_ctxItem('New Folder', 'new-folder'));
      ctx.appendChild(_ctxItem('\uD83D\uDCCB Paste from Clipboard', 'paste-clipboard'));
    }

    ctx.classList.remove('hidden');
    ctx.style.left = ev.clientX + 'px';
    ctx.style.top  = ev.clientY + 'px';
    requestAnimationFrame(() => {
      const r = ctx.getBoundingClientRect();
      if (r.right  > window.innerWidth)  ctx.style.left = (ev.clientX - r.width)  + 'px';
      if (r.bottom > window.innerHeight) ctx.style.top  = (ev.clientY - r.height) + 'px';
    });
  });

  // ── Position inside canvas — relative to node, with saved offset ──
  const _posKey = `lipside-popup-pos::${state.currentPipeline}::${stageName}`;
  let _savedPos = null;
  try { _savedPos = JSON.parse(localStorage.getItem(_posKey)); } catch { /**/ }
  const _nc0 = _grNodeCoords[stageName] || { x: nodeX, y: nodeY };
  if (_savedPos && typeof _savedPos.offX === 'number') {
    // saved as node-relative offset
    popup.style.left = (_nc0.x + _savedPos.offX) + 'px';
    popup.style.top  = (_nc0.y + _savedPos.offY) + 'px';
  } else if (_savedPos) {
    // legacy: absolute canvas position
    popup.style.left = _savedPos.left + 'px';
    popup.style.top  = _savedPos.top  + 'px';
  } else {
    // Default: centred below the node (popup min-width 190px → offset by half)
    popup.style.left = (_nc0.x + _GR.W / 2 - 95) + 'px';
    popup.style.top  = (_nc0.y + nodeH + 8) + 'px';
  }
  canvas.appendChild(popup);

  await _loadPopup('repo');
  _adjustGraphLayout();
}

/* ── Arrowhead orientation ────────────────────────────────────────── */
//  All markers use orient="auto" so SVG reads the actual path tangent at
//  the tip and rotates the arrowhead to match — correct for any bend amount.

/* ── Port-side selection ──────────────────────────────────────────── */
// Returns which side of each box the edge should connect to.
// Uses edge-to-edge gap (not center-to-center) so boxes that overlap on one
// axis don't get misclassified.
function _portSides(fc, fW, fH, tc, tW, tH) {
  const scx = fc.x + fW / 2, scy = fc.y + fH / 2;
  const tcx = tc.x + tW / 2, tcy = tc.y + tH / 2;
  const dx = tcx - scx, dy = tcy - scy;
  const hGap = Math.abs(dx) - (fW / 2 + tW / 2);
  const vGap = Math.abs(dy) - (fH / 2 + tH / 2);
  if (hGap >= vGap) {
    return dx >= 0
      ? { fromSide: 'E', toSide: 'W' }
      : { fromSide: 'W', toSide: 'E' };
  } else {
    return dy >= 0
      ? { fromSide: 'S', toSide: 'N' }
      : { fromSide: 'N', toSide: 'S' };
  }
}

/* ── Bezier path from explicit port positions ─────────────────────── */
// Behaviour:
//   d → 0   : arm → 0, C1 = P1, C2 = P2  →  straight line
//   d → ∞   : arm ≈ 0.45·d, C1 exits cardinally, C2 arrives cardinally  →  S-shape
// t = 1 − e^(−d/150) blends smoothly between the two extremes.
function _edgeBezier(x1, y1, x2, y2, fromSide, toSide) {
  const arrDir = { E: 'R', W: 'L', S: 'D', N: 'U' }[fromSide] || 'R';
  const pdx = x2 - x1, pdy = y2 - y1;
  // d = max(|dx|, |dy|): grows with the dominant axis offset.
  const plen = Math.max(Math.abs(pdx), Math.abs(pdy));

  // t: 0 at d=0 (straight), →1 at d=∞ (full S-shape)
  const t   = 1 - Math.exp(-plen / 150);
  const arm = t * plen * 0.45;

  // Cardinal exit at source port face
  const exitX = fromSide === 'E' ? 1 : fromSide === 'W' ? -1 : 0;
  const exitY = fromSide === 'S' ? 1 : fromSide === 'N' ? -1 : 0;

  // Cardinal pull at target port face (C2 approaches from outside the face)
  const _ts   = toSide || { E:'W', W:'E', N:'S', S:'N' }[fromSide];
  const entryX = _ts === 'E' ? 1 : _ts === 'W' ? -1 : 0;
  const entryY = _ts === 'S' ? 1 : _ts === 'N' ? -1 : 0;

  const c1x = x1 + exitX  * arm,  c1y = y1 + exitY  * arm;
  const c2x = x2 + entryX * arm,  c2y = y2 + entryY * arm;

  // Arrowhead direction: blend chord (d→0) → cardinal arrival (d→∞)
  // Cardinal arrival is opposite to entryX/Y (C2 pulls away from target).
  const clen   = Math.sqrt(pdx * pdx + pdy * pdy) || 1;
  const chordX = pdx / clen, chordY = pdy / clen;
  const cardX  = -entryX,    cardY  = -entryY;
  const blendX = (1 - t) * chordX + t * cardX;
  const blendY = (1 - t) * chordY + t * cardY;
  const blen   = Math.sqrt(blendX * blendX + blendY * blendY) || 1;
  const arrowUx = blendX / blen, arrowUy = blendY / blen;

  return { d: `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`,
           x1, y1, x2, y2, arrDir, plen, arrowUx, arrowUy };
}

/* ── Arrowhead polygon ───────────────────────────────────────────────
   tip    : {x,y}  — endpoint of the edge path
   ux, uy : unit vector pointing toward the tip (pre-blended direction)
   size   : half-length of the arrow (0 = invisible)                   */
function _mkArrowhead(mkS, tip, ux, uy, size, color) {
  if (size < 0.1) return null;
  const px = -uy, py = ux;                          // perpendicular
  const bx = tip.x - ux * size * 1.8, by = tip.y - uy * size * 1.8;
  const hw = size * 0.6;
  const pts = `${bx+px*hw},${by+py*hw} ${tip.x},${tip.y} ${bx-px*hw},${by-py*hw}`;
  return mkS('polygon', { points: pts, fill: color,
    'pointer-events': 'none', class: 'gr-arrowhead' });
}

/* ── Spread port positions across shared edges ────────────────────── */
/*
 * When multiple edges share the same side of a box they would all connect at
 * the same midpoint.  This function distributes them evenly along the side,
 * sorted by the other end's center coordinate (left→right for N/S sides,
 * top→bottom for E/W sides).
 *
 * edgeList : [{key, from, to}, ...]
 * coords   : stageName → {x, y}  (top-left of each node box)
 * W, H     : uniform node dimensions
 *
 * Returns  : Map<key, {x1,y1,x2,y2,fromSide,toSide}>
 */
/* nodeSizes: optional map of stageName → {w, h, ox, oy} for nodes whose visual
   rect differs from the standard W×H layout cell (e.g. the Void sink node).
   ox/oy are offsets of the rect's top-left relative to the group's origin. */
function _computeSpreadPorts(edgeList, coords, W, H, nodeSizes = {}) {
  const MARGIN = 12;
  const nw  = n => nodeSizes[n]?.w  ?? W;
  const nh  = n => nodeSizes[n]?.h  ?? H;
  // Adjust group origin → visual rect top-left for a node.
  const adj = (nc, n) => ({
    x: nc.x + (nodeSizes[n]?.ox ?? 0),
    y: nc.y + (nodeSizes[n]?.oy ?? 0),
  });

  // 1. Determine port sides for every edge (using actual visual rect positions).
  const infos = [];
  for (const { key, from, to } of edgeList) {
    const fc = coords[from], tc = coords[to];
    if (!fc || !tc) continue;
    const afc = adj(fc, from), atc = adj(tc, to);
    const { fromSide, toSide } = _portSides(afc, nw(from), nh(from), atc, nw(to), nh(to));
    infos.push({ key, from, to, fc: afc, tc: atc, fromSide, toSide });
  }

  // 2. Group by (node, side) — each slot records the edge key, which end is on
  //    this node, and the other node's center (for sort ordering).
  const groups = {}; // `${node}:${side}` → [{key, role, sortVal}]
  const add = (node, side, key, role, otherNode, otherCoords) => {
    const k = `${node}:${side}`;
    if (!groups[k]) groups[k] = [];
    const isHoriz = side === 'N' || side === 'S';
    const sortVal = isHoriz
      ? otherCoords.x + nw(otherNode) / 2   // sort left→right by other node center-x
      : otherCoords.y + nh(otherNode) / 2;  // sort top→bottom by other node center-y
    groups[k].push({ key, role, sortVal });
  };
  for (const ei of infos) {
    add(ei.from, ei.fromSide, ei.key, 'from', ei.to,   ei.tc);
    add(ei.to,   ei.toSide,   ei.key, 'to',   ei.from, ei.fc);
  }

  // 3. Sort each group and assign evenly-spaced positions along the side.
  const pts = {}; // `${key}:from` or `${key}:to` → {x, y}
  for (const [k, entries] of Object.entries(groups)) {
    const [node, side] = k.split(':');
    const nc = coords[node];
    if (!nc) continue;
    const anc = adj(nc, node);
    const nW = nw(node), nH = nh(node);
    entries.sort((a, b) => a.sortVal - b.sortVal);
    const n = entries.length;
    entries.forEach((e, i) => {
      let x, y;
      if (side === 'N' || side === 'S') {
        x = n === 1
          ? anc.x + nW / 2
          : anc.x + MARGIN + (nW - 2 * MARGIN) / (n - 1) * i;
        y = side === 'S' ? anc.y + nH : anc.y;
      } else {
        x = side === 'E' ? anc.x + nW : anc.x;
        y = n === 1
          ? anc.y + nH / 2
          : anc.y + MARGIN + (nH - 2 * MARGIN) / (n - 1) * i;
      }
      pts[`${e.key}:${e.role}`] = { x, y };
    });
  }

  // 4. Assemble result map.
  const result = new Map();
  for (const ei of infos) {
    const p1 = pts[`${ei.key}:from`];
    const p2 = pts[`${ei.key}:to`];
    if (p1 && p2) result.set(ei.key, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
                                        fromSide: ei.fromSide, toSide: ei.toSide });
  }
  return result;
}

// Legacy wrapper kept for any callers that pass two coord objects directly.
function _flowEdgePath(fc, tc, fW, fH, tW, tH) {
  if (tW === undefined) { tW = fW; tH = fH; }
  const { fromSide, toSide } = _portSides(fc, fW, fH, tc, tW, tH);
  const scx = fc.x + fW/2, scy = fc.y + fH/2;
  const tcx = tc.x + tW/2, tcy = tc.y + tH/2;
  const dx = tcx - scx, dy = tcy - scy;
  let x1, y1, x2, y2;
  if (fromSide === 'E') { x1 = fc.x+fW; y1 = scy; x2 = tc.x;     y2 = tcy; }
  else if (fromSide === 'W') { x1 = fc.x;    y1 = scy; x2 = tc.x+tW; y2 = tcy; }
  else if (fromSide === 'S') { x1 = scx; y1 = fc.y+fH; x2 = tcx; y2 = tc.y; }
  else                       { x1 = scx; y1 = fc.y;    x2 = tcx; y2 = tc.y+tH; }
  return _edgeBezier(x1, y1, x2, y2, fromSide, toSide);
}

/* ── Redraw edges connected to a node (called during node drag) ───── */
function _redrawEdgesForNode(stageName) {
  if (!_grSvgEl) return;
  const { W, H } = _GR;

  // Recompute spread positions for ALL edges (a dragged node affects its
  // neighbours' spread too, so we always recompute the full set).
  const spreadMap = _computeSpreadPorts(_grEdgeList, _grNodeCoords, W, H, _grNodeSizes);

  // BFS from the dragged node to find every node whose port-spread may have
  // changed.  Dragging A re-sorts B's port group, which can shift B→D and
  // B→E even though those edges don't touch A directly.
  const adj = {};
  for (const { from, to } of _grEdgeList) {
    (adj[from] = adj[from] || []).push(to);
    (adj[to]   = adj[to]   || []).push(from);
  }
  const visited = new Set([stageName]);
  const queue   = [stageName];
  while (queue.length) {
    const node = queue.shift();
    for (const nb of (adj[node] || [])) {
      if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
    }
  }
  // Collect all edges that touch any reachable node.
  const affectedKeys = new Set();
  for (const { key, from, to } of _grEdgeList) {
    if (visited.has(from) || visited.has(to)) affectedKeys.add(key);
  }

  // Flow edges where this stage is source or target
  _grSvgEl.querySelectorAll('.gr-edge-g[data-from][data-to]').forEach(edgeG => {
    const from = edgeG.dataset.from, to = edgeG.dataset.to;
    const key  = edgeG.dataset.key || `${from}→${to}`;
    if (!affectedKeys.has(key)) return;
    const sp   = spreadMap.get(key);
    if (!sp) return;
    const { d, x1, y1, x2, y2, arrDir, plen, arrowUx: aUx, arrowUy: aUy } = _edgeBezier(sp.x1, sp.y1, sp.x2, sp.y2, sp.fromSide, sp.toSide);
    edgeG.dataset.arrDir = arrDir;
    edgeG.querySelectorAll('path').forEach(p => p.setAttribute('d', d));
    // Reposition polygon arrowheads using blended direction
    const elen2 = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
    const aSize2 = 3 + 5 * (1 - Math.exp(-elen2 / 150));
    const px2 = -aUy, py2 = aUx;
    const bx2 = x2 - aUx*aSize2*1.8, by2 = y2 - aUy*aSize2*1.8;
    const hw2 = aSize2 * 0.6;
    const pts2 = `${bx2+px2*hw2},${by2+py2*hw2} ${x2},${y2} ${bx2-px2*hw2},${by2-py2*hw2}`;
    edgeG.querySelectorAll('.gr-arrowhead').forEach(ah => ah.setAttribute('points', pts2));
    // Update label positions
    const mx = (x1 + x2) / 2;
    const myBase = (y1 + y2) / 2;
    edgeG.querySelectorAll('[data-lbl-i]').forEach(el => {
      const i = parseInt(el.dataset.lblI);
      const my = myBase - 7 - i * 13;
      if (el.tagName.toLowerCase() === 'text') {
        el.setAttribute('x', mx); el.setAttribute('y', my);
      } else {
        const fl = parseInt(el.dataset.fileLen || 0);
        el.setAttribute('x', mx - fl * 3 - 3); el.setAttribute('y', my - 9);
      }
    });
  });

  // Reposition self-loop labels for every visited stage
  const _SL_LINE_H = 15;
  const _SL_PAD    = 8;
  for (const sn of visited) {
    const nc = _grNodeCoords[sn];
    if (!nc) continue;
    const badges = [..._grSvgEl.querySelectorAll(`.gr-sl-badge[data-sl-stage="${CSS.escape(sn)}"]`)];
    const n = badges.length;
    badges.forEach((sg, idx) => {
      const labelX = nc.x + W / 2;
      const labelY = nc.y - _SL_PAD - (n - 1 - idx) * _SL_LINE_H;
      const ltxt = sg.querySelector('.gr-sl-lbl');
      const lbg  = sg.querySelector('[data-sl-lbl-i]');
      if (ltxt) { ltxt.setAttribute('x', labelX); ltxt.setAttribute('y', labelY); }
      if (lbg && lbg.tagName.toLowerCase() === 'rect') {
        const textLen = parseInt(lbg.dataset.labelTextLen || 0);
        const approxW = textLen * 6 + 6;
        lbg.setAttribute('x', labelX - approxW / 2);
        lbg.setAttribute('y', labelY - 8);
      }
    });
  }
}

/* ── Draw dotted arrows from each open popup back to its stage node ── */
function _updatePopupArrows() {
  if (!_grSvgEl) return;
  _grSvgEl.querySelectorAll('.gr-popup-arrow').forEach(el => el.remove());
  const { W, H } = _GR;
  const NS = 'http://www.w3.org/2000/svg';

  for (const [stage, popup] of Object.entries(_grPopups)) {
    const nc = _grNodeCoords[stage];
    if (!nc) continue;

    // Resolve current node Y (may be nudged by layout)
    const nodeEl = _grSvgEl.querySelector(`.gr-node[data-stage="${CSS.escape(stage)}"]`);
    let ny = nc.y;
    if (nodeEl) {
      const m = (nodeEl.getAttribute('transform') || '').match(/translate\(([^,]+),([^)]+)\)/);
      if (m) ny = parseFloat(m[2]);
    }
    const nx = nc.x;

    // Node cardinal ports
    const node = {
      N: { x: nx + W / 2, y: ny         },
      S: { x: nx + W / 2, y: ny + H     },
      W: { x: nx,         y: ny + H / 2 },
      E: { x: nx + W,     y: ny + H / 2 },
      cx: nx + W / 2, cy: ny + H / 2,
    };

    // Popup cardinal ports
    const pl = parseFloat(popup.style.left) || 0;
    const pt = parseFloat(popup.style.top)  || 0;
    const pw = popup.offsetWidth  || 260;
    const ph = popup.offsetHeight || 120;
    const pop = {
      N: { x: pl + pw / 2, y: pt      },
      S: { x: pl + pw / 2, y: pt + ph },
      W: { x: pl,          y: pt + ph / 2 },
      E: { x: pl + pw,     y: pt + ph / 2 },
      cx: pl + pw / 2, cy: pt + ph / 2,
    };

    const dx = pop.cx - node.cx;
    const dy = pop.cy - node.cy;

    // Pick side using edge-to-edge gap, same as _portSides.
    const hGap = Math.abs(dx) - (W / 2 + pw / 2);
    const vGap = Math.abs(dy) - (H / 2 + ph / 2);
    let tail, head, fromSide;
    if (hGap >= vGap) {
      if (dx >= 0) { tail = node.E; head = pop.W; fromSide = 'E'; }
      else         { tail = node.W; head = pop.E; fromSide = 'W'; }
    } else {
      if (dy >= 0) { tail = node.S; head = pop.N; fromSide = 'S'; }
      else         { tail = node.N; head = pop.S; fromSide = 'N'; }
    }

    const _oppSide = { E:'W', W:'E', N:'S', S:'N' };
    const { d, arrowUx, arrowUy, plen } = _edgeBezier(tail.x, tail.y, head.x, head.y, fromSide, _oppSide[fromSide]);
    const edx = head.x - tail.x, edy = head.y - tail.y;
    const elen = Math.sqrt(edx * edx + edy * edy);
    const arrowSize = 3 + 5 * (1 - Math.exp(-elen / 150));

    const mkSvg = (tag, attrs = {}) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };

    const line = mkSvg('path', { d, fill: 'none', stroke: 'var(--fg-dim)',
      'stroke-width': 1.2, 'stroke-dasharray': '4,3',
      opacity: 0.45, 'pointer-events': 'none', class: 'gr-popup-arrow' });

    const arrowEl = _mkArrowhead(mkSvg, { x: head.x, y: head.y },
      arrowUx, arrowUy, arrowSize, 'var(--fg-dim)');
    if (arrowEl) {
      arrowEl.setAttribute('opacity', '0.45');
      arrowEl.setAttribute('class', 'gr-popup-arrow');
    }

    const firstNode = _grSvgEl.querySelector('.gr-node');
    if (firstNode) {
      _grSvgEl.insertBefore(line, firstNode);
      if (arrowEl) _grSvgEl.insertBefore(arrowEl, firstNode);
    } else {
      _grSvgEl.appendChild(line);
      if (arrowEl) _grSvgEl.appendChild(arrowEl);
    }
  }
}

/* ── Adjust node positions to avoid being covered by open popups ── */
function _adjustGraphLayout() {
  if (!_grCanvasEl) return;
  const nodes = _grCanvasEl.querySelectorAll('.gr-node[data-stage]');
  if (!nodes.length) return;

  // Collect popup bounding rects in canvas-local space
  const popupRects = Object.entries(_grPopups).map(([stage, popup]) => {
    const l = parseFloat(popup.style.left)  || 0;
    const t = parseFloat(popup.style.top)   || 0;
    const w = popup.offsetWidth  || 260;
    const h = popup.offsetHeight || 0;
    return { stage, l, t, r: l + w, b: t + h };
  }).filter(pr => pr.h > 0);

  // Build a list of nodes with their current Y offsets
  const nodeList = [...nodes].map(g => {
    const s    = g.dataset.stage;
    const orig = _grNodeCoords[s] || { x: 0, y: 0 };
    return { el: g, stage: s, origX: orig.x, origY: orig.y, curY: orig.y };
  }).sort((a, b) => a.origY - b.origY);

  // For each popup (processed top-to-bottom), push overlapping nodes down
  const sortedRects = [...popupRects].sort((a, b) => a.t - b.t);
  for (const pr of sortedRects) {
    for (const node of nodeList) {
      if (node.stage === pr.stage) continue;
      const nl = node.origX, nr = node.origX + _GR.W;
      const nt = node.curY,  nb = node.curY  + _GR.H;
      if (nr > pr.l + 8 && nl < pr.r - 8 && nb > pr.t + 8 && nt < pr.b - 8) {
        node.curY = pr.b + 20;
      }
    }
  }

  // Apply transforms
  for (const node of nodeList) {
    node.el.setAttribute('transform', `translate(${node.origX},${node.curY})`);
  }

  _updatePopupArrows();
}

/* ═══════════════════════════════════════════════════════════════════
   GRAPH VIEW
   ═══════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════
   GRAPH VIEW — unconstrained hierarchical DAG renderer
   ═══════════════════════════════════════════════════════════════════ */

/* ── Layout constants ─────────────────────────────────────────────── */
const _GR = { W: 130, H: 130, hGap: 70, vGap: 55, padX: 56, padY: 52 };

/* ── Port-drag: global handlers (registered once) ────────────────── */
window.addEventListener('mousemove', e => {
  if (!_portDrag || !_grSvgEl) return;
  const pt = _grSvgEl.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  const svgPt = pt.matrixTransform(_grSvgEl.getScreenCTM().inverse());
  const { svgX1, svgY1 } = _portDrag;
  // Straight temp arrow
  _portDrag.line.setAttribute('d', `M${svgX1},${svgY1} L${svgPt.x},${svgPt.y}`);
  // Hit-test: is the mouse inside any node box?
  const { W, H } = _GR;
  let newTarget = null;
  for (const ts of _grStages) {
    const tc = _grNodeCoords[ts];
    if (!tc) continue;
    if (svgPt.x >= tc.x && svgPt.x <= tc.x + W &&
        svgPt.y >= tc.y && svgPt.y <= tc.y + H) {
      newTarget = ts; break;
    }
  }
  if (newTarget !== _portDragTarget) {
    if (_portDragTarget) {
      // un-highlight previous target box
      const prev = _grSvgEl.querySelector(`.gr-node-rect[data-stage="${CSS.escape(_portDragTarget)}"]`)
        || _grSvgEl.querySelector(`.gr-node[data-stage="${CSS.escape(_portDragTarget)}"] .gr-node-rect`);
      if (prev) { prev.setAttribute('stroke', 'var(--border)'); prev.setAttribute('stroke-width', 1.5); }
    }
    _portDragTarget = newTarget;
    if (_portDragTarget) {
      // highlight new target box
      const next = _grSvgEl.querySelector(`.gr-node[data-stage="${CSS.escape(_portDragTarget)}"] .gr-node-rect`);
      if (next) { next.setAttribute('stroke', 'var(--accent)'); next.setAttribute('stroke-width', 2.5); }
    }
  }
});

window.addEventListener('mouseup', async () => {
  if (!_portDrag) return;
  const { fromStage, line, portRect } = _portDrag;
  const toStage   = _portDragTarget;
  const svgEl     = _grSvgEl;
  line.remove();
  // Reset the port square back to default style
  if (portRect) {
    portRect.setAttribute('fill', 'var(--bg3)');
    portRect.setAttribute('stroke', 'var(--border)');
  }
  // Un-highlight target box border on release
  if (toStage && svgEl) {
    const nr = svgEl.querySelector(`.gr-node[data-stage="${CSS.escape(toStage)}"] .gr-node-rect`);
    if (nr) { nr.setAttribute('stroke', 'var(--border)'); nr.setAttribute('stroke-width', 1.5); }
  }
  _portDrag = null;
  _portDragTarget = null;
  // Swallow the trailing click that fires on the source node after any drag
  _portDragJustFinished = true;
  setTimeout(() => { _portDragJustFinished = false; }, 150);

  if (toStage && state.currentPipeline) {
    const raw = await appPromptExt(`Build file name (no extension)\n${fromStage} → ${toStage}`);
    if (raw) {
      const safeName = raw.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const fileName = safeName + '.' + raw.ext;
      const content  = fromStage === toStage
        ? 'Your task is to update the repository <env:SOURCE> by generating files needed to be updated.\n'
        : raw.ext === 'py'
          ? 'env_block = """\n```env\nTARGET=' + toStage + '\n```\n"""\nimport os\nimport time\nimport sys\nfrom lips.utils.parse_build_files import env_from_build_file\n_, env = env_from_build_file(env_block)\n'
          : '```env\nTARGET=' + toStage + '\n```\n\nYour task is to transform the repository <env:SOURCE> to <env:TARGET> by generating files.\n';
      try {
        const r = await fetch(
          `/api/file/${encodeURIComponent(state.currentPipeline)}/${encodeURIComponent(fromStage)}/build?path=${encodeURIComponent(fileName)}`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }) }
        );
        if (!r.ok) throw new Error(await r.text());
        await renderGraphView(); _graphDirty = false;
      } catch (err) {
        await appAlert('Could not create build file: ' + err.message);
      }
    }
  }
});

/* ── Node-drag: global handlers (registered once) ────────────────── */
let _nodeDragRefreshTimer = null;

window.addEventListener('mousemove', e => {
  if (!_nodeDrag) return;
  const { s, g, startCX, startCY, startNX, startNY, popupOffsetX, popupOffsetY } = _nodeDrag;
  if (!_nodeDragged && Math.hypot(e.clientX - startCX, e.clientY - startCY) > 4) {
    _nodeDragged = true;
    // Periodically re-run layout nudging every 200 ms while dragging
    _nodeDragRefreshTimer = setInterval(() => { if (_nodeDrag) _adjustGraphLayout(); }, 200);
  }
  if (!_nodeDragged) return;
  const nx = startNX + (e.clientX - startCX) / _grScale;
  const ny = startNY + (e.clientY - startCY) / _grScale;
  g.setAttribute('transform', `translate(${nx},${ny})`);
  _grNodeCoords[s] = { x: nx, y: ny };
  _redrawEdgesForNode(s);
  _updatePopupArrows();
  const popup = _grPopups[s];
  if (popup) {
    popup.style.left = (nx + popupOffsetX) + 'px';
    popup.style.top  = (ny + popupOffsetY) + 'px';
  }
});

window.addEventListener('mouseup', () => {
  if (!_nodeDrag) return;
  clearInterval(_nodeDragRefreshTimer);
  _nodeDragRefreshTimer = null;
  const { s, g } = _nodeDrag;
  _nodeDrag = null;
  const rectEl = g.querySelector('.gr-node-rect');
  if (rectEl) rectEl.style.cursor = 'grab';
  if (_nodeDragged) {
    _adjustGraphLayout();
    const { x, y } = _grNodeCoords[s];
    localStorage.setItem(
      `lipside-node-pos::${state.currentPipeline}::${s}`,
      JSON.stringify({ x, y })
    );
  }
});

/* ── Build directed adjacency maps (strips self-loops) ───────────── */
function _grAdj(stages, rawEdges) {
  const set  = new Set(stages);
  const succ = Object.fromEntries(stages.map(s => [s, []]));
  const pred = Object.fromEntries(stages.map(s => [s, []]));
  const flow = [], self = [];
  for (const e of rawEdges) {
    if (!set.has(e.from) || !set.has(e.to)) continue;
    if (e.from === e.to) { self.push(e); continue; }
    if (!succ[e.from].includes(e.to)) {
      succ[e.from].push(e.to);
      pred[e.to].push(e.from);
      flow.push({ from: e.from, to: e.to });
    }
  }
  return { succ, pred, flow, self };
}

/* ── Longest-path rank (column) assignment ───────────────────────── */
function _grRanks(stages, succ, pred) {
  const rank  = Object.fromEntries(stages.map(s => [s, 0]));
  const indeg = Object.fromEntries(stages.map(s => [s, pred[s].length]));
  const q = stages.filter(s => indeg[s] === 0);
  while (q.length) {
    const n = q.shift();
    for (const c of succ[n]) {
      if (rank[n] + 1 > rank[c]) rank[c] = rank[n] + 1;
      if (--indeg[c] === 0) q.push(c);
    }
  }
  return rank;
}

/* ── Barycenter crossing-minimisation (forward + backward sweeps) ── */
function _grOrder(byLevel, pred, succ) {
  const pos = {};
  for (const col of byLevel) col.forEach((s, i) => { pos[s] = i; });
  const bc = (nbrs) => nbrs.length
    ? nbrs.reduce((sum, n) => sum + (pos[n] ?? 0), 0) / nbrs.length
    : Infinity;
  for (let pass = 0; pass < 4; pass++) {
    for (let lv = 1; lv < byLevel.length; lv++) {
      byLevel[lv].sort((a, b) => bc(pred[a]) - bc(pred[b]));
      byLevel[lv].forEach((s, i) => { pos[s] = i; });
    }
    for (let lv = byLevel.length - 2; lv >= 0; lv--) {
      byLevel[lv].sort((a, b) => bc(succ[a]) - bc(succ[b]));
      byLevel[lv].forEach((s, i) => { pos[s] = i; });
    }
  }
}

/* ── Assign pixel coordinates from level + in-level position ─────── */
function _grCoords(byLevel) {
  const { W, H, hGap, vGap, padX, padY } = _GR;
  const coords = {};
  for (const [lv, col] of byLevel.entries()) {
    col.forEach((s, i) => {
      coords[s] = { x: padX + lv * (W + hGap), y: padY + i * (H + vGap) };
    });
  }
  const maxLv  = byLevel.length - 1;
  const maxCol = Math.max(...byLevel.map(l => l.length));
  return {
    coords,
    totalW: padX * 2 + (maxLv + 1) * (W + hGap) - hGap,
    totalH: padY * 2 + maxCol * (H + vGap) - vGap,
  };
}

/* ── Master layout: works for any graph topology ─────────────────── */
function _layoutDag(stages, rawEdges) {
  if (!stages.length) return { coords: {}, flow: [], self: [], totalW: 0, totalH: 0 };
  const { succ, pred, flow, self } = _grAdj(stages, rawEdges);
  const rank     = _grRanks(stages, succ, pred);
  const maxRank  = Math.max(0, ...Object.values(rank));
  const byLevel  = Array.from({ length: maxRank + 1 }, () => []);
  for (const s of stages) byLevel[rank[s]].push(s);
  for (const col of byLevel) col.sort((a, b) => stages.indexOf(a) - stages.indexOf(b));
  _grOrder(byLevel, pred, succ);
  const { coords, totalW, totalH } = _grCoords(byLevel);
  return { coords, flow, self, totalW, totalH };
}

/* ── Render graph into #graph-pane ───────────────────────────────── */
async function renderGraphView() {
  if (_grEventCtrl) { _grEventCtrl.abort(); }
  _grEventCtrl = new AbortController();
  const { signal } = _grEventCtrl;

  const container = $('graph-container');
  const pipeline  = state.currentPipeline;
  $('graph-pipeline-label').textContent = pipeline || '';
  container.innerHTML = '';

  if (!pipeline) {
    container.innerHTML = '<div class="gr-empty">Select a pipeline.</div>';
    return;
  }

  let stages = [], edges = [];
  try {
    const r = await fetch('/api/workspace');
    if (!r.ok) throw new Error(r.statusText);
    const data = await r.json();
    const pipeInfo = (data.pipelines || []).find(p => p.name === pipeline);
    stages = pipeInfo?.stages || [];
    // Parse TARGET= from each stage's build files to derive edges
    for (const stage of stages) {
      try {
        const fr = await fetch(`/api/files/${encodeURIComponent(pipeline)}/${encodeURIComponent(stage)}/build`);
        if (!fr.ok) continue;
        const { files = [] } = await fr.json();
        for (const f of files) {
          if (f.is_dir || !/\.(md|py|sh)$/.test(f.name)) continue;
          try {
            const cr = await fetch(`/api/file/${encodeURIComponent(pipeline)}/${encodeURIComponent(stage)}/build?path=${encodeURIComponent(f.path)}`);
            if (!cr.ok) continue;
            const { content = '' } = await cr.json();
            const extM  = f.name.match(/\.(\w+)$/);
            const ext   = extM ? '.' + extM[1] : '';
            const m     = content.match(/```env\s+([\s\S]*?)```/);
            const tm    = m && m[1].match(/^TARGET\s*=\s*(.+)$/m);
            const target  = tm ? tm[1].trim() : 'Void';
            const aliasM  = m && m[1].match(/^ALIAS\s*=\s*(.+)$/m);
            const isMain  = aliasM ? aliasM[1].trim() === 'main' : false;
            edges.push({ from: stage, file: f.name, to: target, ext, isMain });
          } catch { /**/ }
        }
      } catch { /**/ }
    }
  } catch (err) {
    container.innerHTML = `<div class="gr-empty">Could not load graph: ${err.message}</div>`;
    return;
  }
  if (!stages.length) {
    container.innerHTML = '<div class="gr-empty">No stages found.</div>';
    return;
  }

  // Inject a synthetic "Void" sink for any edges whose target stage doesn't exist.
  const _stageSet  = new Set(stages);
  const _needsVoid = edges.some(e => !_stageSet.has(e.to));
  // Void node dimensions — square, centred within the standard W×H layout cell.
  const VS  = 80;
  const vOx = (_GR.W - VS) / 2, vOy = (_GR.H - VS) / 2;
  _grNodeSizes = _needsVoid ? { Void: { w: VS, h: VS, ox: vOx, oy: vOy } } : {};
  if (_needsVoid) {
    edges  = edges.map(e => _stageSet.has(e.to) ? e : { ...e, to: 'Void' });
    stages = [...stages, 'Void'];
  }

  let { coords, flow, self, totalW, totalH } = _layoutDag(stages, edges);
  const { W, H } = _GR;

  // Restore any saved node positions from localStorage
  for (const s of stages) {
    try {
      const sv = JSON.parse(localStorage.getItem(`lipside-node-pos::${pipeline}::${s}`));
      if (sv && typeof sv.x === 'number') coords[s] = { x: sv.x, y: sv.y };
    } catch { /**/ }
  }
  totalW = Math.max(totalW, ...stages.map(s => (coords[s]?.x ?? 0) + W + _GR.padX));
  totalH = Math.max(totalH, ...stages.map(s => (coords[s]?.y ?? 0) + H + _GR.padY));
  const NS = 'http://www.w3.org/2000/svg';

  const mkS = (tag, attrs = {}) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };

  /* ── SVG canvas ──────────────────────────────────────────────── */
  const svg = mkS('svg', { width: totalW, height: totalH,
    viewBox: `0 0 ${totalW} ${totalH}`, style: 'overflow:visible;display:block' });

  const defs = mkS('defs', {});
  // orient="auto" lets SVG rotate the marker to match the path tangent at the tip.
  const mkMarker = (id, color, size = 9) => {
    const m = mkS('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: size, markerHeight: size, orient: 'auto' });
    m.appendChild(mkS('path', { d: 'M0,1.5 L10,5 L0,8.5 z', fill: color }));
    return m;
  };
  // One marker per color — direction is handled by the path tangent automatically.
  defs.appendChild(mkMarker('gr-arr',       'var(--fg-dim)'));
  defs.appendChild(mkMarker('gr-arr-hi',    'var(--accent)'));
  svg.appendChild(defs);

  // Transparent background rect — reliable target for empty-space right-click
  const bgRect = mkS('rect', { x: -2000, y: -2000, width: 9999, height: 9999,
    fill: 'transparent', 'pointer-events': 'all', class: 'gr-bg' });
  bgRect.addEventListener('contextmenu', ev => {
    ev.preventDefault(); ev.stopPropagation();
    const ctx = $('ctx-menu');
    ctx.innerHTML = '';
    ctx.dataset.stage = ''; ctx.dataset.path = ''; ctx.dataset.isdir = 'false'; ctx.dataset.view = '';
    ctx.appendChild(_ctxItem('New Stage…',  'gr-new-stage'));
    ctx.appendChild(_ctxItem('New Thread…', 'gr-new-thread'));
    ctx.classList.remove('hidden');
    ctx.style.left = ev.clientX + 'px';
    ctx.style.top  = ev.clientY + 'px';
    requestAnimationFrame(() => {
      const r2 = ctx.getBoundingClientRect();
      if (r2.right  > window.innerWidth)  ctx.style.left = (ev.clientX - r2.width)  + 'px';
      if (r2.bottom > window.innerHeight) ctx.style.top  = (ev.clientY - r2.height) + 'px';
    });
  });
  svg.appendChild(bgRect);

  /* ── Flow edges ──────────────────────────────────────────────── */
  // Extension → color mapping for non-dotted arrows
  const _EXT_COLORS = { '.sh': 'var(--green)', '.py': 'var(--accent)', '.md': 'var(--yellow)' };
  const _extColor = (fileInfos) => {
    if (!fileInfos || !fileInfos.length) return 'var(--fg-dim)';
    return _EXT_COLORS[fileInfos[0].ext] || 'var(--fg-dim)';
  };

  // One entry per file — each file gets its own separate arrow
  const edgeMap = new Map();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const key = `${e.from}→${e.to}→${e.file || ''}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { from: e.from, to: e.to,
        files:     e.file ? [e.file] : [],
        fileInfos: e.file ? [{ name: e.file, ext: e.ext || '', isMain: e.isMain || false }] : [] });
    }
  }

  // Build the global edge list and compute spread port positions.
  _grEdgeList = [...edgeMap.keys()].map(key => {
    const { from, to } = edgeMap.get(key);
    return { key, from, to };
  });
  const _spreadMap = _computeSpreadPorts(_grEdgeList, coords, W, H, _grNodeSizes);

  for (const [key, { from, to, files, fileInfos }] of edgeMap.entries()) {
    const sp  = _spreadMap.get(key);
    if (!sp) continue;
    const { d, x1, y1, x2, y2, arrDir, plen, arrowUx, arrowUy } = _edgeBezier(sp.x1, sp.y1, sp.x2, sp.y2, sp.fromSide, sp.toSide);

    const edgeColor = _extColor(fileInfos);
    const elen = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
    const arrowSize = 3 + 5 * (1 - Math.exp(-elen / 150));
    const tip = { x: x2, y: y2 };

    const g = mkS('g', { class: 'gr-edge-g', 'data-from': from, 'data-to': to,
      'data-key': key, 'data-arr-dir': arrDir });
    const vis = mkS('path', { d, fill: 'none', stroke: edgeColor,
      'stroke-width': 1.8, opacity: 0.6, class: 'gr-edge-vis' });
    const hit = mkS('path', { d, fill: 'none', stroke: 'transparent',
      'stroke-width': 14, style: 'cursor:pointer' });
    const arrow   = _mkArrowhead(mkS, tip, arrowUx, arrowUy, arrowSize, edgeColor);
    const arrowHi = _mkArrowhead(mkS, tip, arrowUx, arrowUy, arrowSize, 'var(--accent)');

    g.addEventListener('mouseenter', () => {
      vis.setAttribute('stroke', 'var(--accent)');
      vis.setAttribute('stroke-width', 2.5);
      vis.setAttribute('opacity', 1);
      if (arrow)   arrow.style.display   = 'none';
      if (arrowHi) arrowHi.style.display = '';
    });
    g.addEventListener('mouseleave', () => {
      vis.setAttribute('stroke', edgeColor);
      vis.setAttribute('stroke-width', 1.8);
      vis.setAttribute('opacity', 0.6);
      if (arrow)   arrow.style.display   = '';
      if (arrowHi) arrowHi.style.display = 'none';
    });
    g.addEventListener('click', ev => {
      if (ev.target.closest('.gr-edge-lbl')) return;
      if (files.length) files.forEach(f => openFile(from, f, 'build'));
    });
    g.addEventListener('contextmenu', ev => {
      if (ev.target.closest('.gr-edge-lbl')) return;
      if (!files.length) return;
      ev.preventDefault(); ev.stopPropagation();
      const file = files[0];
      const ctx = $('ctx-menu');
      ctx.innerHTML = '';
      ctx.dataset.stage = from;
      ctx.dataset.path  = file;
      ctx.dataset.isdir = 'false';
      ctx.dataset.view  = 'build';
      ctx.appendChild(_ctxItem('Open File', 'open-file'));
      ctx.appendChild(_ctxItem('▶ Build', 'run-build-file'));
      ctx.appendChild(_ctxSep());
      ctx.appendChild(_ctxItem('Rename…', 'rename'));
      ctx.appendChild(_ctxItem('Move to…', 'move'));
      ctx.appendChild(_ctxSep());
      ctx.appendChild(_ctxItem('Delete File', 'delete', true));
      ctx.classList.remove('hidden');
      ctx.style.left = ev.clientX + 'px';
      ctx.style.top  = ev.clientY + 'px';
      requestAnimationFrame(() => {
        const r2 = ctx.getBoundingClientRect();
        if (r2.right  > window.innerWidth)  ctx.style.left = (ev.clientX - r2.width)  + 'px';
        if (r2.bottom > window.innerHeight) ctx.style.top  = (ev.clientY - r2.height) + 'px';
      });
    });

    if (arrowHi) arrowHi.style.display = 'none';
    g.append(vis, hit);
    if (arrow)   g.appendChild(arrow);   // rendered above path, below hit layer
    if (arrowHi) g.appendChild(arrowHi);

    // File labels at midpoint — each clickable to open that build file
    if (files.length) {
      const mx = (x1 + x2) / 2 + (x2 <= x1 ? 60 : 0);
      files.forEach((file, i) => {
        const info = fileInfos[i] || {};
        const my = (y1 + y2) / 2 - 7 - i * 13;
        const bg = mkS('rect', {
          x: mx - file.length * 3 - 3, y: my - 9,
          width: file.length * 6 + 6, height: 12,
          fill: 'var(--bg1)', rx: 3, opacity: 0.9,
          style: 'cursor:pointer',
          'data-lbl-i': i, 'data-file-len': file.length,
        });
        const txt = mkS('text', { x: mx, y: my,
          'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-size': 9.5, fill: 'var(--fg-dim)',
          'font-weight': info.isMain ? 'bold' : 'normal',
          class: 'gr-edge-lbl', style: 'cursor:pointer', 'data-lbl-i': i });
        txt.textContent = file;
        const openIt = ev => { ev.stopPropagation(); openFile(from, file, 'build'); };
        bg.addEventListener('click', openIt);
        txt.addEventListener('click', openIt);
        txt.addEventListener('mouseenter', ev => { ev.stopPropagation(); txt.setAttribute('fill', 'var(--accent)'); });
        txt.addEventListener('mouseleave', ev => { ev.stopPropagation(); txt.setAttribute('fill', 'var(--fg-dim)'); });
        const showCtx = ev => {
          ev.preventDefault(); ev.stopPropagation();
          const ctx = $('ctx-menu');
          ctx.innerHTML = '';
          ctx.dataset.stage = from;
          ctx.dataset.path  = file;
          ctx.dataset.isdir = 'false';
          ctx.dataset.view  = 'build';
          ctx.appendChild(_ctxItem('Open File', 'open-file'));
          ctx.appendChild(_ctxSep());
          ctx.appendChild(_ctxItem('Rename…', 'rename'));
          ctx.appendChild(_ctxItem('Move to…', 'move'));
          ctx.appendChild(_ctxSep());
          ctx.appendChild(_ctxItem('Delete File', 'delete', true));
          ctx.classList.remove('hidden');
          ctx.style.left = ev.clientX + 'px';
          ctx.style.top  = ev.clientY + 'px';
          requestAnimationFrame(() => {
            const r2 = ctx.getBoundingClientRect();
            if (r2.right  > window.innerWidth)  ctx.style.left = (ev.clientX - r2.width)  + 'px';
            if (r2.bottom > window.innerHeight) ctx.style.top  = (ev.clientY - r2.height) + 'px';
          });
        };
        bg.addEventListener('contextmenu', showCtx);
        txt.addEventListener('contextmenu', showCtx);
        g.append(bg, txt);
      });
    }
    svg.appendChild(g);
  }

  /* ── Self-loops — labels stacked north of box, alphabetically ── */
  const SL_PAD = 8;   // gap above top of box

  // Group files per stage
  const selfMap = new Map();
  for (const e of self) {
    if (!selfMap.has(e.from)) selfMap.set(e.from, []);
    const arr = selfMap.get(e.from);
    if (!arr.find(x => x.file === e.file)) {
      arr.push({ file: e.file, ext: e.ext || '', isMain: e.isMain || false });
    }
  }

  for (const [stage, fileInfos] of selfMap) {
    const c = coords[stage];
    if (!c) continue;

    // Sort alphabetically, stack vertically above the box (first alpha = top)
    fileInfos.sort((a, b) => a.file.localeCompare(b.file));
    const n = fileInfos.length;
    const LINE_H = 15;

    fileInfos.forEach((info, idx) => {
      const slColor  = _EXT_COLORS[info.ext] || 'var(--fg-dim)';
      const labelX   = c.x + W / 2;
      // idx=0 (first alpha) → topmost; idx=n-1 → closest to box
      const labelY   = c.y - SL_PAD - (n - 1 - idx) * LINE_H;
      const labelText = '↻' + info.file;
      const approxW  = labelText.length * 6 + 6;

      const sg = mkS('g', { class: 'gr-edge-g gr-sl-badge',
        'data-sl-stage': stage, 'data-sl-file': info.file });

      // Background rect behind label
      const lbg = mkS('rect', {
        x: labelX - approxW / 2, y: labelY - 8,
        width: approxW, height: 13,
        fill: 'var(--bg1)', rx: 2, opacity: 0.9,
        style: 'cursor:pointer',
        'data-sl-lbl-i': 0, 'data-file-len': info.file.length,
        'data-label-text-len': labelText.length,
      });
      // Label: icon + filename as one string
      const ltxt = mkS('text', { x: labelX, y: labelY,
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': 9.5, fill: slColor,
        'font-weight': info.isMain ? 'bold' : 'normal',
        class: 'gr-edge-lbl gr-sl-lbl', style: 'cursor:pointer', 'data-sl-lbl-i': 0 });
      ltxt.textContent = labelText;

      sg.addEventListener('mouseenter', () => {
        ltxt.setAttribute('fill', 'var(--accent)');
      });
      sg.addEventListener('mouseleave', () => {
        ltxt.setAttribute('fill', slColor);
      });
      sg.addEventListener('click', ev => {
        if (ev.target.closest('.gr-sl-lbl')) return;
        openFile(stage, info.file, 'build');
      });
      const showSlCtx = ev => {
        ev.preventDefault(); ev.stopPropagation();
        const ctx = $('ctx-menu');
        ctx.innerHTML = '';
        ctx.dataset.stage = stage;
        ctx.dataset.path  = info.file;
        ctx.dataset.isdir = 'false';
        ctx.dataset.view  = 'build';
        ctx.appendChild(_ctxItem('Open File', 'open-file'));
        ctx.appendChild(_ctxItem('▶ Build', 'run-build-file'));
        ctx.appendChild(_ctxSep());
        ctx.appendChild(_ctxItem('Rename…', 'rename'));
        ctx.appendChild(_ctxItem('Move to…', 'move'));
        ctx.appendChild(_ctxSep());
        ctx.appendChild(_ctxItem('Delete File', 'delete', true));
        ctx.classList.remove('hidden');
        ctx.style.left = ev.clientX + 'px';
        ctx.style.top  = ev.clientY + 'px';
        requestAnimationFrame(() => {
          const r2 = ctx.getBoundingClientRect();
          if (r2.right  > window.innerWidth)  ctx.style.left = (ev.clientX - r2.width)  + 'px';
          if (r2.bottom > window.innerHeight) ctx.style.top  = (ev.clientY - r2.height) + 'px';
        });
      };
      sg.addEventListener('contextmenu', showSlCtx);
      lbg.addEventListener('click', ev => { ev.stopPropagation(); openFile(stage, info.file, 'build'); });
      ltxt.addEventListener('click', ev => { ev.stopPropagation(); openFile(stage, info.file, 'build'); });
      lbg.addEventListener('contextmenu', showSlCtx);
      ltxt.addEventListener('contextmenu', showSlCtx);
      ltxt.addEventListener('mouseenter', ev => { ev.stopPropagation(); ltxt.setAttribute('fill', 'var(--accent)'); });
      ltxt.addEventListener('mouseleave', ev => { ev.stopPropagation(); ltxt.setAttribute('fill', slColor); });

      sg.append(lbg, ltxt);
      svg.appendChild(sg);
    });
  }

  /* ── Node cards ──────────────────────────────────────────────── */
  for (const s of stages) {
    const c = coords[s];
    if (!c) continue;

    // ── Void sink node — square, dimmed, dashed, draggable ───────
    if (s === 'Void') {
      // VS / vOx / vOy are hoisted from the Void injection block above.
      const vg = mkS('g', { transform: `translate(${c.x},${c.y})`,
        class: 'gr-node gr-void-node', 'data-stage': 'Void' });
      const vRect = mkS('rect', { x: vOx, y: vOy, width: VS, height: VS, rx: 7,
        fill: 'var(--bg1)', stroke: 'var(--fg-dim)', 'stroke-width': 1.5,
        'stroke-dasharray': '6 3', opacity: 0.55,
        class: 'gr-node-rect', style: 'cursor:grab' });
      const vTxt = mkS('text', { x: vOx + VS / 2, y: vOy + VS / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': 14, 'font-weight': 600, fill: 'var(--fg-dim)',
        opacity: 0.55, 'pointer-events': 'none' });
      vTxt.textContent = 'Void';
      vRect.addEventListener('mousedown', ev => {
        if (ev.button !== 0) return;
        ev.stopPropagation(); ev.preventDefault();
        const nc = _grNodeCoords['Void'] || { x: c.x, y: c.y };
        _nodeDrag = {
          s: 'Void', g: vg,
          startCX: ev.clientX, startCY: ev.clientY,
          startNX: nc.x, startNY: nc.y,
          popupOffsetX: 0, popupOffsetY: 0,
        };
        _nodeDragged = false;
        vRect.style.cursor = 'grabbing';
      });
      vg.append(vRect, vTxt);
      svg.appendChild(vg);
      continue;
    }

    const g = mkS('g', { transform: `translate(${c.x},${c.y})`, class: 'gr-node', 'data-stage': s });

    // Drop-shadow
    g.appendChild(mkS('rect', { x: 2, y: 3, width: W, height: H, rx: 7,
      fill: 'rgba(0,0,0,0.25)', class: 'gr-shadow' }));
    // Body — highlight if this stage is the one currently open in the editor
    const isActive = state.tabs[state.activeTab]?.stage === s;
    const rect = mkS('rect', { x: 0, y: 0, width: W, height: H, rx: 7,
      fill: isActive ? 'var(--bg3)' : 'var(--bg2)',
      stroke: isActive ? 'var(--accent)' : 'var(--border)',
      'stroke-width': isActive ? 2 : 1.5,
      class: 'gr-node-rect', style: 'cursor:grab' });
    g.appendChild(rect);

    rect.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      ev.stopPropagation(); ev.preventDefault();
      const nc = _grNodeCoords[s] || { x: c.x, y: c.y };
      const popup = _grPopups[s];
      _nodeDrag = {
        s, g,
        startCX: ev.clientX, startCY: ev.clientY,
        startNX: nc.x, startNY: nc.y,
        popupOffsetX: popup ? (parseFloat(popup.style.left) - nc.x) : 0,
        popupOffsetY: popup ? (parseFloat(popup.style.top)  - nc.y) : 0,
      };
      _nodeDragged = false;
      rect.style.cursor = 'grabbing';
    });

    // Horizontal divider separating name (top) from controls (bottom)
    g.appendChild(mkS('line', { x1: 0, y1: H / 2, x2: W, y2: H / 2,
      stroke: 'var(--border)', 'stroke-width': 1, 'pointer-events': 'none' }));
    // Vertical divider between port and run button
    g.appendChild(mkS('line', { x1: W / 2, y1: H / 2, x2: W / 2, y2: H,
      stroke: 'var(--border)', 'stroke-width': 1, 'pointer-events': 'none' }));

    // Stage name — top half
    const label = s.length > 14 ? s.slice(0, 13) + '…' : s;
    const txt = mkS('text', { x: W / 2, y: H / 4,
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': 18, 'font-weight': 600, fill: 'var(--fg)',
      class: 'gr-node-text', 'pointer-events': 'none' });
    txt.textContent = label;
    g.appendChild(txt);

    // ── Port square (+) and run button — bottom half, evenly spread ─
    const portSize = 30, runSize = 28;
    const btmCY = H * 3 / 4;
    // Each button occupies one half of the node width, centred in its slot
    const portX = W / 4 - portSize / 2, portY = btmCY - portSize / 2;
    const portG = mkS('g', { class: 'gr-out-port', style: 'cursor:crosshair' });
    const portRect = mkS('rect', { x: portX, y: portY, width: portSize, height: portSize, rx: 3,
      fill: 'var(--bg3)', stroke: 'var(--border)', 'stroke-width': 1.5 });
    const pcx = portX + portSize / 2, pcy = portY + portSize / 2;
    const plusH = mkS('line', { x1: pcx - 5, y1: pcy, x2: pcx + 5, y2: pcy,
      stroke: 'var(--fg-dim)', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'pointer-events': 'none' });
    const plusV = mkS('line', { x1: pcx, y1: pcy - 5, x2: pcx, y2: pcy + 5,
      stroke: 'var(--fg-dim)', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'pointer-events': 'none' });
    portG.append(portRect, plusH, plusV);
    portG.addEventListener('mouseenter', ev => {
      ev.stopPropagation();
      if (!_portDrag) {
        portRect.setAttribute('fill', 'var(--accent)');
        portRect.setAttribute('stroke', 'var(--accent)');
        plusH.setAttribute('stroke', '#fff');
        plusV.setAttribute('stroke', '#fff');
      }
    });
    portG.addEventListener('mouseleave', ev => {
      ev.stopPropagation();
      if (!_portDrag) {
        portRect.setAttribute('fill', 'var(--bg3)');
        portRect.setAttribute('stroke', 'var(--border)');
        plusH.setAttribute('stroke', 'var(--fg-dim)');
        plusV.setAttribute('stroke', 'var(--fg-dim)');
      }
    });
    portG.addEventListener('mousedown', ev => {
      ev.stopPropagation();
      ev.preventDefault();
      const _nc = _grNodeCoords[s] || { x: c.x, y: c.y };
      const svgX1 = _nc.x + W / 2, svgY1 = _nc.y + H / 2;
      const dragLine = mkS('path', {
        d: `M${svgX1},${svgY1} L${svgX1},${svgY1}`,
        fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2,
        'stroke-dasharray': '5,3',
        'pointer-events': 'none', class: 'gr-drag-line'
      });
      svg.appendChild(dragLine);
      _portDrag = { fromStage: s, svgX1, svgY1, line: dragLine, portRect };
      _portDragTarget = null;
    });
    g.appendChild(portG);

    // Run button
    const runX = 3 * W / 4 - runSize / 2, runY = btmCY - runSize / 2;
    const runG = mkS('g', { class: 'gr-run-g', transform: `translate(${runX},${runY})` });
    runG.setAttribute('title', `Run ${s}`);
    const runRect = mkS('rect', { x: 0, y: 0, width: runSize, height: runSize, rx: 5,
      fill: 'var(--bg3)', stroke: 'var(--green)', 'stroke-width': 1.5,
      class: 'gr-run-rect' });
    const runTxt = mkS('text', { x: runSize / 2, y: runSize / 2,
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': 11, fill: 'var(--green)', 'pointer-events': 'none',
      'font-family': 'sans-serif' });
    runTxt.textContent = '▶';
    runG.append(runRect, runTxt);
    runG.addEventListener('mouseenter', ev => {
      ev.stopPropagation();
      runRect.setAttribute('fill', 'var(--green)');
      runTxt.setAttribute('fill', '#fff');
    });
    runG.addEventListener('mouseleave', ev => {
      ev.stopPropagation();
      runRect.setAttribute('fill', 'var(--bg3)');
      runTxt.setAttribute('fill', 'var(--green)');
    });
    runG.addEventListener('click', ev => { ev.stopPropagation(); runBuild(s); });
    g.appendChild(runG);

    // Node hover — only affects border, no click action
    g.addEventListener('mouseenter', ev => {
      if (ev.target.closest('.gr-run-g')) return;
      rect.setAttribute('stroke', 'var(--accent)');
      rect.setAttribute('stroke-width', 2);
    });
    g.addEventListener('mouseleave', () => {
      rect.setAttribute('stroke', isActive ? 'var(--accent)' : 'var(--border)');
      rect.setAttribute('stroke-width', isActive ? 2 : 1.5);
    });
    g.addEventListener('click', ev => {
      if (ev.target.closest('.gr-run-g') || ev.target.closest('.gr-out-port')) return;
      if (_nodeDragged) { _nodeDragged = false; return; }
      if (_portDragJustFinished) return;  // swallow click after a port drag ends on this node
      ev.stopPropagation();
      const nc = _grNodeCoords[s] || coords[s];
      const cv = container.querySelector('.gr-canvas');
      openGraphNodePopup(s, nc.x, nc.y, _GR.H, cv || container);
    });
    svg.appendChild(g);
  }

  /* ── Canvas wrapper ──────────────────────────────────────────── */
  const canvas = el('div', 'gr-canvas');
  canvas.appendChild(svg);
  _grCanvasEl   = canvas;
  _grSvgEl      = svg;
  _grStages     = stages.filter(s => s !== 'Void');  // Void is synthetic — exclude from interactions
  _grNodeCoords = Object.fromEntries(stages.map(s => [s, { ...coords[s] }]));

  /* ── Pan & zoom ──────────────────────────────────────────────── */
  const _freshRender = _grApplyXform === null;
  if (_freshRender) { _grScale = 1; _grPanX = 0; _grPanY = 0; }
  let dragging = false, lx = 0, ly = 0;
  _grApplyXform = () => {
    canvas.style.transform = `translate(${_grPanX}px,${_grPanY}px) scale(${_grScale})`;
  };
  const applyXform = _grApplyXform;
  applyXform(); // re-apply current camera to new canvas immediately
  container.addEventListener('mousedown', e => {
    if (e.target.closest('.gr-run-g') || e.target.closest('.gr-edge-lbl') || e.target.closest('.gr-out-port') || e.button !== 0) return;
    dragging = true; lx = e.clientX; ly = e.clientY;
    container.style.cursor = 'grabbing'; e.preventDefault();
  }, { signal });

  // Right-click on graph nodes → same context menu as stage-header in build view
  container.addEventListener('contextmenu', e => {
    // Find which stage node was right-clicked (walk up through SVG <g class="gr-node">)
    let nodeG = null;
    let el2 = e.target;
    while (el2 && el2 !== container) {
      if (el2.classList && el2.classList.contains('gr-node')) { nodeG = el2; break; }
      el2 = el2.parentElement;
    }
    if (!nodeG) { e.preventDefault(); return; }
    e.preventDefault();

    const stageName = nodeG.dataset.stage;
    if (!stageName || stageName === 'Void') return;

    // Build context menu exactly as stage-header right-click
    const ctx = $('ctx-menu');
    ctx.innerHTML = '';
    ctx.dataset.stage = stageName;
    ctx.dataset.path  = '';
    ctx.dataset.isdir = 'false';
    ctx.dataset.view  = 'build';
    ctx.appendChild(_ctxItem('New File', 'new-file'));
    ctx.appendChild(_ctxItem('New Folder', 'new-folder'));
    ctx.appendChild(_ctxItem('\uD83D\uDCCB Paste from Clipboard', 'paste-clipboard'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('\uD83D\uDCC4 Open in Terminal', 'open-terminal'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('\u25B6 Build', 'run-build'));
    ctx.appendChild(_ctxSep());
    ctx.appendChild(_ctxItem('Purge Stage\u2026', 'purge-stage', true));
    ctx.appendChild(_ctxItem('Purge Upstream\u2026', 'gr-purge-upstream', true));
    ctx.appendChild(_ctxItem('Purge Downstream\u2026', 'gr-purge-downstream', true));
    ctx.appendChild(_ctxItem('Delete Stage\u2026', 'delete-stage', true));

    ctx.classList.remove('hidden');
    ctx.style.left = e.clientX + 'px';
    ctx.style.top  = e.clientY + 'px';
    requestAnimationFrame(() => {
      const rect2 = ctx.getBoundingClientRect();
      if (rect2.right  > window.innerWidth)  ctx.style.left = (e.clientX - rect2.width)  + 'px';
      if (rect2.bottom > window.innerHeight) ctx.style.top  = (e.clientY - rect2.height) + 'px';
    });
  }, { signal });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    _grPanX += e.clientX - lx; _grPanY += e.clientY - ly;
    lx = e.clientX; ly = e.clientY; applyXform();
  }, { signal });
  window.addEventListener('mouseup', () => {
    dragging = false; container.style.cursor = '';
  }, { signal });
  container.addEventListener('wheel', e => {
    e.preventDefault();
    const factor   = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.max(0.15, Math.min(5, _grScale * factor));
    const rect = container.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    _grPanX = cx - (cx - _grPanX) * (newScale / _grScale);
    _grPanY = cy - (cy - _grPanY) * (newScale / _grScale);
    _grScale = newScale; applyXform();
  }, { passive: false, signal });

  container.appendChild(canvas);

  // Auto-recenter on first open or pipeline switch
  if (_freshRender && stages.length) {
    const { W: _W, H: _H } = _GR;
    const _xs = stages.map(s => _grNodeCoords[s]?.x ?? 0);
    const _ys = stages.map(s => _grNodeCoords[s]?.y ?? 0);
    const _minX = Math.min(..._xs), _maxX = Math.max(..._xs) + _W;
    const _minY = Math.min(..._ys), _maxY = Math.max(..._ys) + _H;
    const _gw = _maxX - _minX || 1, _gh = _maxY - _minY || 1;
    const _vw = container.clientWidth, _vh = container.clientHeight;
    const _pad = 60;
    _grScale = Math.max(0.15, Math.min(2,
      Math.min((_vw - _pad * 2) / _gw, (_vh - _pad * 2) / _gh)));
    _grPanX = (_vw - _gw * _grScale) / 2 - _minX * _grScale;
    _grPanY = (_vh - _gh * _grScale) / 2 - _minY * _grScale;
    _grApplyXform();
  }
}

function showModalErr(id, msg) {
  const errEl = $(id);
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}



/* ═══════════════════════════════════════════════════════════════
   SESSION COUNTDOWN CLOCK
   ═══════════════════════════════════════════════════════════════ */
(function initSessionClock() {
  const el = $('session-clock');
  let expiresAt = null;
  let ticker = null;

  function fmt(secs) {
    if (secs <= 0) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function tick() {
    const remaining = Math.max(0, Math.round(expiresAt - Date.now() / 1000));
    el.textContent = fmt(remaining);
    el.classList.toggle('urgent', remaining <= 60);
    el.classList.toggle('warn', remaining > 60 && remaining <= 300);
    if (remaining === 0) {
      clearInterval(ticker);
      window.location.reload();
    }
  }

  async function fetchSession() {
    try {
      const res = await fetch('/session');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.passkey_user || !data.expires_at) {
        el.classList.add('hidden');
        return;
      }
      expiresAt = data.expires_at;
      el.classList.remove('hidden');
      tick();
      if (!ticker) ticker = setInterval(tick, 1000);
    } catch (_) {}
  }

  fetchSession();
  setInterval(fetchSession, 60000);
})();

/* ═══════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════ */
cm = CodeMirror($('editor-container'), {
  mode: 'markdown', theme: 'dracula', lineNumbers: true, lineWrapping: true,
  tabSize: 2, indentWithTabs: false, autofocus: false,
  extraKeys: { 'Ctrl-S': () => saveActiveTab() }
});

cm.on('change', () => {
  if (_cmLoading) return;
  if (state.activeTab !== null && state.tabs[state.activeTab]) {
    state.tabs[state.activeTab].modified = true;
    renderTabBar();
  }
});

initResizeHandles();
initMenubar();
(async () => { setViewMode(state.viewMode); await loadWorkspace('.'); })();
