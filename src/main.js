import * as THREE from 'three';
import * as OBC from '@thatopen/components';

// =====================================
// GEOBIM.LAB — BIM Viewer v0.2
// That Open Components + Three.js
// Phase 1: Multi-file, Hide, Delete, Type-Filter, Clipping
// =====================================

const state = {
  components: null,
  world: null,
  ifcLoader: null,
  fragments: null,
  caster: null,
  // Multi-file support
  files: [],        // { id, name, size, modelId, model, elementCount, color, visible }
  fileIdCounter: 0,
  // Hide mode
  hideMode: false,
  hiddenItems: new Map(),  // key: `${modelId}:${localId}` → { modelId, localId, name }
  // Delete mode
  deleteMode: false,
  deletedStack: [],        // [{modelId, localId, name}] for undo
  deletedSet: new Set(),   // `${modelId}:${localId}` for quick lookup
  // Clipping
  clipPlanes: { x: null, y: null, z: null },
  clipFlipped: { x: false, y: false, z: false },
  clipEnabled: { x: false, y: false, z: false },
  modelBBox: null,
  // Type filter
  typeVisibility: new Map(), // `${modelId}:${type}` → boolean
};

// File colors for the file manager
const FILE_COLORS = [
  '#2ECFB0', '#60a5fa', '#f59e0b', '#ef4444', '#a78bfa',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4',
];

// =====================================
// STATUS
// =====================================

function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function showLoading(text) {
  const overlay = document.getElementById('loadingOverlay');
  const textEl = document.getElementById('loadingText');
  const fill = document.getElementById('progressFill');
  if (overlay) overlay.classList.remove('hidden');
  if (textEl) textEl.textContent = text || 'Loading...';
  if (fill) fill.style.width = '0%';
}

function updateProgress(pct) {
  const fill = document.getElementById('progressFill');
  if (fill) fill.style.width = Math.min(100, pct) + '%';
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.classList.add('hidden');
}

// =====================================
// INIT
// =====================================

async function init() {
  setStatus('Initializing...');

  const viewport = document.getElementById('viewport');
  if (!viewport) {
    console.error('Viewport element not found');
    return;
  }

  const components = new OBC.Components();
  state.components = components;

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();
  state.world = world;

  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = new THREE.Color(0x0D1017);

  world.renderer = new OBC.SimpleRenderer(components, viewport);

  world.camera = new OBC.SimpleCamera(components);
  world.camera.controls.setLookAt(10, 10, 10, 0, 0, 0);

  components.init();

  const grids = components.get(OBC.Grids);
  const grid = grids.create(world);
  grid.material.uniforms.uColor.value = new THREE.Color(0x333333);
  state.grid = grid;

  // ---- FragmentsManager ----
  setStatus('Loading fragment worker...');
  const fragments = components.get(OBC.FragmentsManager);
  state.fragments = fragments;

  const workerResponse = await fetch(
    'https://thatopen.github.io/engine_fragment/resources/worker.mjs'
  );
  const workerBlob = await workerResponse.blob();
  const workerFile = new File([workerBlob], 'worker.mjs', {
    type: 'text/javascript',
  });
  const workerUrl = URL.createObjectURL(workerFile);
  fragments.init(workerUrl);

  // Forward render updates to fragments renderer
  world.renderer.onBeforeUpdate.add(() => {
    fragments.core.update();
  });

  // Wire model loading — multi-file aware
  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);

    let fitted = false;
    model.onViewUpdated.add(() => {
      fragments.core.update(true);
      if (!fitted && model.object.children.length > 0) {
        fitted = true;
        fitCameraToAllModels();
        recomputeClipBounds();
      }
    });
  });

  // ---- Raycaster for picking ----
  const casters = components.get(OBC.Raycasters);
  const caster = casters.get(world);
  state.caster = caster;

  // ---- IFC Loader ----
  setStatus('Setting up IFC loader...');
  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      path: 'https://unpkg.com/web-ifc@0.0.74/',
      absolute: true,
    },
  });
  state.ifcLoader = ifcLoader;

  // Enable clipping on renderer
  world.renderer.three.localClippingEnabled = true;

  setStatus('Ready — Open an IFC file or drag & drop');
  console.log('geobim.lab initialized');

  setupUI();
  setupDragDrop();
  setupClipping();
}

// =====================================
// FIT CAMERA
// =====================================

function fitCameraToAllModels() {
  const bbox = new THREE.Box3();
  let hasContent = false;
  for (const f of state.files) {
    if (f.model && f.model.object && f.model.object.children.length > 0) {
      bbox.expandByObject(f.model.object);
      hasContent = true;
    }
  }
  if (!hasContent) return;

  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    state.world.camera.controls.setLookAt(
      center.x + maxDim, center.y + maxDim * 0.5, center.z + maxDim,
      center.x, center.y, center.z,
      true
    );
  }
}

// =====================================
// IFC LOADING (Multi-file)
// =====================================

async function loadIFC(file) {
  if (!state.ifcLoader || !state.world) {
    setStatus('Error: Viewer not initialized');
    return;
  }

  showLoading(
    `Loading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`
  );
  setStatus('Loading IFC...');

  try {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    updateProgress(20);

    const model = await state.ifcLoader.load(data, false, file.name);

    updateProgress(100);

    // Register file
    const fileEntry = {
      id: state.fileIdCounter++,
      name: file.name,
      size: file.size,
      modelId: model.id,
      model: model,
      elementCount: 0,
      color: FILE_COLORS[state.files.length % FILE_COLORS.length],
      visible: true,
    };

    // Count elements
    try {
      const itemsMap = await model.getItems();
      fileEntry.elementCount = itemsMap ? itemsMap.size : 0;
    } catch (_) {}

    state.files.push(fileEntry);

    setStatus(`${file.name} loaded`);
    console.log('IFC loaded:', file.name, `${(file.size / 1024 / 1024).toFixed(1)} MB`);
    hideLoading();

    updateFilesBadge();
    renderFilesPanel();
    buildModelTree();
  } catch (err) {
    console.error('IFC loading failed:', err);
    setStatus('Error: ' + err.message);
    hideLoading();
  }
}

// =====================================
// SERVER MODELS
// =====================================

async function loadServerModel(url, name) {
  if (!state.ifcLoader || !state.world) {
    setStatus('Error: Viewer not initialized');
    return;
  }

  showLoading(`Downloading ${name}...`);
  setStatus(`Downloading ${name}...`);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = await response.arrayBuffer();
    const data = new Uint8Array(buffer);
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);

    updateProgress(30);
    setStatus(`Loading ${name} (${sizeMB} MB)...`);

    const model = await state.ifcLoader.load(data, false, name);

    const fileEntry = {
      id: state.fileIdCounter++,
      name: name,
      size: buffer.byteLength,
      modelId: model.id,
      model: model,
      elementCount: 0,
      color: FILE_COLORS[state.files.length % FILE_COLORS.length],
      visible: true,
    };

    try {
      const itemsMap = await model.getItems();
      fileEntry.elementCount = itemsMap ? itemsMap.size : 0;
    } catch (_) {}

    state.files.push(fileEntry);

    updateProgress(100);
    setStatus(`${name} loaded`);
    console.log('Server IFC loaded:', name, `${sizeMB} MB`);
    hideLoading();

    updateFilesBadge();
    renderFilesPanel();
    buildModelTree();
  } catch (err) {
    console.error('Server model load failed:', err);
    setStatus('Error: ' + err.message);
    hideLoading();
  }
}

async function setupServerModels() {
  const btn = document.getElementById('serverModelsBtn');
  const menu = document.getElementById('serverModelsMenu');
  if (!btn || !menu) return;

  btn.addEventListener('click', () => {
    menu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });

  try {
    const res = await fetch('/models/index.php');
    if (!res.ok) throw new Error('No models index');
    const models = await res.json();

    if (models.length === 0) {
      menu.innerHTML = '<div class="dropdown-empty">No models available</div>';
      return;
    }

    menu.innerHTML = '';
    models.forEach((m) => {
      const item = document.createElement('button');
      item.className = 'dropdown-item';
      item.textContent = m.name;
      item.title = `${m.file} (${m.size})`;
      item.addEventListener('click', () => {
        menu.classList.add('hidden');
        loadServerModel(`/models/${m.file}`, m.name);
      });
      menu.appendChild(item);
    });
  } catch (err) {
    menu.innerHTML = '<div class="dropdown-empty">Could not load model list</div>';
  }
}

// =====================================
// FILE MANAGER PANEL
// =====================================

function updateFilesBadge() {
  const badge = document.getElementById('filesBadge');
  if (badge) {
    const count = state.files.length;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

function renderFilesPanel() {
  const list = document.getElementById('filesList');
  const info = document.getElementById('filesTotalInfo');
  if (!list) return;

  if (state.files.length === 0) {
    list.innerHTML = '<p class="files-empty">No files loaded</p>';
    if (info) info.textContent = '';
    return;
  }

  const totalElements = state.files.reduce((s, f) => s + f.elementCount, 0);
  const totalSize = state.files.reduce((s, f) => s + f.size, 0);
  if (info) info.textContent = `${state.files.length} files · ${totalElements} elements · ${formatSize(totalSize)}`;

  list.innerHTML = '';
  state.files.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-card-color" style="background:${f.color}"></div>
      <div class="file-card-info">
        <div class="file-card-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <div class="file-card-meta">
          <span>${f.elementCount} elements</span>
          <span>${formatSize(f.size)}</span>
        </div>
      </div>
      <div class="file-card-actions">
        <button class="file-card-btn" title="${f.visible ? 'Hide' : 'Show'}" data-action="toggle" data-id="${f.id}">
          ${f.visible ? eyeIcon() : eyeOffIcon()}
        </button>
        <button class="file-card-btn danger" title="Remove" data-action="remove" data-id="${f.id}">
          ${trashIcon()}
        </button>
      </div>
    `;
    list.appendChild(card);
  });

  // Wire buttons
  list.querySelectorAll('[data-action="toggle"]').forEach((btn) => {
    btn.addEventListener('click', () => toggleFileVisibility(parseInt(btn.dataset.id)));
  });
  list.querySelectorAll('[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => removeFile(parseInt(btn.dataset.id)));
  });
}

function toggleFileVisibility(fileId) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f || !f.model) return;
  f.visible = !f.visible;
  f.model.object.visible = f.visible;
  state.fragments.core.update(true);
  renderFilesPanel();
}

function removeFile(fileId) {
  const idx = state.files.findIndex((x) => x.id === fileId);
  if (idx === -1) return;
  const f = state.files[idx];

  // Remove from scene
  if (f.model && f.model.object) {
    state.world.scene.three.remove(f.model.object);
  }

  // Dispose model from fragments
  try {
    if (f.model) {
      state.fragments.list.delete(f.modelId);
      f.model.dispose();
    }
  } catch (err) {
    console.warn('Model dispose error:', err);
  }

  // Remove hidden/deleted items for this model
  for (const [key] of state.hiddenItems) {
    if (key.startsWith(f.modelId + ':')) state.hiddenItems.delete(key);
  }
  for (const key of state.deletedSet) {
    if (key.startsWith(f.modelId + ':')) state.deletedSet.delete(key);
  }

  state.files.splice(idx, 1);
  state.fragments.core.update(true);

  updateFilesBadge();
  renderFilesPanel();
  buildModelTree();
  recomputeClipBounds();
  updateHideBadge();
  updateDeleteBadge();
  setStatus(state.files.length > 0 ? `${f.name} removed` : 'Ready');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// =====================================
// MODEL TREE (Multi-file + Type Filter)
// =====================================

async function buildModelTree() {
  const container = document.getElementById('modelTree');
  const filterActions = document.getElementById('filterActions');
  if (!container) return;

  if (state.files.length === 0) {
    container.innerHTML = '<p class="empty-state">Load an IFC file to see the model tree</p>';
    if (filterActions) filterActions.style.display = 'none';
    return;
  }

  container.innerHTML = '<p class="empty-state">Building tree...</p>';
  document.getElementById('sidebar')?.classList.remove('hidden');
  document.getElementById('toggleTree')?.classList.add('active');
  if (filterActions) filterActions.style.display = 'flex';

  let totalElements = 0;
  const allGroups = []; // { fileEntry, type, items[] }

  // Build groups from all files
  for (const fileEntry of state.files) {
    try {
      const itemsMap = await fileEntry.model.getItems();
      if (!itemsMap || itemsMap.size === 0) continue;

      const groups = {};
      itemsMap.forEach((rawItem, localId) => {
        const category = rawItem.category || 'Unknown';
        const name = rawItem.data?.Name?.value || rawItem.data?.name?.value || '';
        const guid = rawItem.guid || '';
        if (!groups[category]) groups[category] = [];
        groups[category].push({ localId, name: String(name), guid });
      });

      Object.keys(groups).sort().forEach((type) => {
        allGroups.push({ fileEntry, type, items: groups[type] });
        totalElements += groups[type].length;
      });
    } catch (err) {
      console.warn('buildModelTree failed for', fileEntry.name, err);
    }
  }

  // Render tree
  container.innerHTML = '';

  // If multi-file, group by file
  if (state.files.length > 1) {
    for (const fileEntry of state.files) {
      const fileSection = document.createElement('div');
      fileSection.className = 'tree-file-section open';

      const fileHeader = document.createElement('div');
      fileHeader.className = 'tree-file-header';
      fileHeader.innerHTML = `<span class="tree-file-name" style="color:${fileEntry.color}">${escapeHtml(fileEntry.name)}</span>`;
      fileHeader.addEventListener('click', () => fileSection.classList.toggle('open'));
      fileSection.appendChild(fileHeader);

      const fileGroups = allGroups.filter((g) => g.fileEntry.id === fileEntry.id);
      fileGroups.forEach((g) => {
        fileSection.appendChild(createTreeGroup(g.fileEntry, g.type, g.items));
      });

      container.appendChild(fileSection);
    }
  } else {
    // Single file — flat groups
    allGroups.forEach((g) => {
      container.appendChild(createTreeGroup(g.fileEntry, g.type, g.items));
    });
  }

  // Wire search
  const searchInput = document.getElementById('treeSearch');
  const countEl = document.getElementById('treeCount');
  if (countEl) countEl.textContent = `${totalElements}`;

  if (searchInput) {
    // Remove old listeners by cloning
    const newSearch = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newSearch, searchInput);

    newSearch.addEventListener('input', () => {
      const q = newSearch.value.toLowerCase().trim();
      let visible = 0;

      container.querySelectorAll('.tree-group').forEach((group) => {
        const type = group.dataset.type || '';
        const leaves = group.querySelectorAll('.tree-leaf');
        let groupVisible = 0;

        leaves.forEach((leaf) => {
          const name = leaf.dataset.name || '';
          const id = leaf.dataset.localid || '';
          const match = !q || type.includes(q) || name.includes(q) || id.includes(q);
          leaf.classList.toggle('hidden-by-filter', !match);
          if (match) groupVisible++;
        });

        group.classList.toggle('hidden-by-filter', groupVisible === 0);
        if (q && groupVisible > 0) {
          group.classList.add('open');
        }
        visible += groupVisible;
      });

      if (countEl) countEl.textContent = q ? `${visible}/${totalElements}` : `${totalElements}`;
    });
  }

  setStatus(`${state.files.length} file(s) — ${totalElements} elements`);
}

function createTreeGroup(fileEntry, type, items) {
  const groupEl = document.createElement('div');
  groupEl.className = 'tree-group';
  groupEl.dataset.type = type.toLowerCase();
  groupEl.dataset.modelid = fileEntry.modelId;

  const header = document.createElement('div');
  header.className = 'tree-group-header';
  const color = typeColor(type);

  // Type filter checkbox
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'tree-checkbox';
  const visKey = `${fileEntry.modelId}:${type}`;
  checkbox.checked = state.typeVisibility.get(visKey) !== false;
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    const visible = checkbox.checked;
    state.typeVisibility.set(visKey, visible);
    setTypeVisibility(fileEntry.modelId, type, items, visible);
  });

  const label = document.createElement('span');
  label.className = 'tree-group-label';
  label.innerHTML = `<span class="type-badge" style="background:${color}"></span> ${escapeHtml(type)} (${items.length})`;

  header.appendChild(checkbox);
  header.appendChild(label);

  label.addEventListener('click', (e) => {
    e.stopPropagation();
    groupEl.classList.toggle('open');
  });

  const childrenWrap = document.createElement('div');
  childrenWrap.className = 'tree-items';

  items.forEach(({ localId, name }) => {
    const key = `${fileEntry.modelId}:${localId}`;
    if (state.deletedSet.has(key)) return; // skip deleted

    const item = document.createElement('div');
    item.className = 'tree-item tree-leaf';
    item.dataset.name = (name || '').toLowerCase();
    item.dataset.localid = localId;
    item.dataset.modelid = fileEntry.modelId;
    item.innerHTML = `<span>${escapeHtml(name || `#${localId}`)}</span>`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('modelTree')?.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');
      selectFromTree(fileEntry.modelId, localId);
    });
    childrenWrap.appendChild(item);
  });

  groupEl.appendChild(header);
  groupEl.appendChild(childrenWrap);
  return groupEl;
}

function setTypeVisibility(modelId, type, items, visible) {
  if (!state.fragments) return;
  const model = state.fragments.list.get(modelId);
  if (!model) return;

  const localIds = items.map((i) => i.localId);
  const itemsObj = { [modelId]: new Set(localIds) };

  try {
    if (visible) {
      state.fragments.setVisibility(true, itemsObj);
    } else {
      state.fragments.setVisibility(false, itemsObj);
    }
    state.fragments.core.update(true);
  } catch (err) {
    console.warn('setTypeVisibility failed:', err);
  }
}

async function selectFromTree(modelId, localId) {
  if (!state.fragments) return;

  const items = { [modelId]: new Set([localId]) };

  try {
    await state.fragments.resetHighlight();
    await state.fragments.highlight(
      { color: new THREE.Color(0x2ECFB0), opacity: 0.6, transparent: true },
      items
    );
  } catch (_) {}

  try {
    const model = state.fragments.list.get(modelId);
    if (model) {
      const data = await model.getItemsData([localId]);
      showProperties(data, localId);
    }
  } catch (err) {
    console.warn('selectFromTree properties failed:', err);
  }
}

// =====================================
// TYPE FILTER ACTIONS
// =====================================

function setupFilterActions() {
  document.getElementById('filterAll')?.addEventListener('click', () => {
    document.querySelectorAll('#modelTree .tree-checkbox').forEach((cb) => {
      if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    });
  });
  document.getElementById('filterNone')?.addEventListener('click', () => {
    document.querySelectorAll('#modelTree .tree-checkbox').forEach((cb) => {
      if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
    });
  });
  document.getElementById('filterInvert')?.addEventListener('click', () => {
    document.querySelectorAll('#modelTree .tree-checkbox').forEach((cb) => {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
  });
}

// =====================================
// ELEMENT SELECTION + PROPERTIES
// =====================================

async function handleSelection() {
  if (!state.caster || !state.fragments) return;

  // In hide mode, hide the clicked element
  if (state.hideMode) {
    await handleHideClick();
    return;
  }

  // In delete mode, delete the clicked element
  if (state.deleteMode) {
    await handleDeleteClick();
    return;
  }

  const result = await state.caster.castRay();

  try {
    await state.fragments.resetHighlight();
  } catch (_) {}

  if (!result || !result.object) return;

  let modelId = null;
  const localId = result.localId ?? result.itemId ?? null;

  if (result.fragments?.id) {
    modelId = result.fragments.id;
  } else if (state.fragments.list.size > 0) {
    modelId = state.fragments.list.keys().next().value;
  }

  if (modelId && localId != null) {
    const items = { [modelId]: new Set([localId]) };
    try {
      await state.fragments.highlight(
        { color: new THREE.Color(0x2ECFB0), opacity: 0.6, transparent: true },
        items
      );
    } catch (err) {
      console.warn('Highlight failed:', err);
    }

    try {
      const model = state.fragments.list.get(modelId);
      if (model) {
        const data = await model.getItemsData([localId]);
        showProperties(data, localId);
        return;
      }
    } catch (err) {
      console.warn('getItemsData failed:', err);
    }
  }

  showPropertiesFallback(result);
}

function showProperties(dataArray, localId) {
  const container = document.getElementById('propsContent');
  if (!container) return;

  document.getElementById('propsPanel')?.classList.remove('hidden');
  document.getElementById('toggleProps')?.classList.add('active');

  let html = '';

  if (!dataArray || dataArray.length === 0) {
    container.innerHTML = '<p class="empty-state">No properties found</p>';
    return;
  }

  dataArray.forEach((itemData) => {
    if (!itemData) return;
    const entries = Object.entries(itemData);
    const attrs = [];
    const psets = [];

    entries.forEach(([key, val]) => {
      if (Array.isArray(val)) {
        psets.push([key, val]);
      } else if (val && typeof val === 'object' && 'value' in val) {
        attrs.push([key, val.value]);
      }
    });

    if (attrs.length > 0) {
      html += '<div class="props-group">';
      html += '<div class="props-group-title">Attributes</div>';
      html += propRow('Local ID', localId);
      attrs.forEach(([key, val]) => {
        html += propRow(key, formatValue(val));
      });
      html += '</div>';
    }

    psets.forEach(([name, items]) => {
      html += '<div class="props-group collapsed">';
      html += `<div class="props-group-title" onclick="this.parentElement.classList.toggle('collapsed')"><span class="pset-toggle">&#9654;</span> ${escapeHtml(name)}</div>`;
      items.forEach((subItem) => {
        if (!subItem) return;
        Object.entries(subItem).forEach(([subKey, subVal]) => {
          if (subVal && typeof subVal === 'object' && 'value' in subVal) {
            html += propRow(subKey, formatValue(subVal.value));
          }
        });
      });
      html += '</div>';
    });
  });

  container.innerHTML = html || '<p class="empty-state">No properties found</p>';
}

function showPropertiesFallback(result) {
  const container = document.getElementById('propsContent');
  if (!container) return;

  document.getElementById('propsPanel')?.classList.remove('hidden');
  document.getElementById('toggleProps')?.classList.add('active');

  let html = '<div class="props-group">';
  html += '<div class="props-group-title">Element</div>';
  html += propRow('Local ID', result.localId ?? '--');
  html += propRow('Item ID', result.itemId ?? '--');
  html += propRow('Distance', result.distance?.toFixed(2) ?? '--');
  html += '</div>';
  container.innerHTML = html;
}

function propRow(key, value) {
  return `<div class="props-row"><span class="props-key">${escapeHtml(key)}</span><span class="props-value">${escapeHtml(String(value))}</span></div>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function typeColor(typeName) {
  let hash = 0;
  for (let i = 0; i < typeName.length; i++) {
    hash = typeName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function formatValue(val) {
  if (val === null || val === undefined) return '--';
  if (typeof val === 'number') return Number.isInteger(val) ? val.toString() : val.toFixed(4);
  return String(val);
}

// =====================================
// HIDE MODE
// =====================================

function toggleHideMode() {
  if (state.deleteMode) toggleDeleteMode(); // exit delete mode first
  state.hideMode = !state.hideMode;
  document.getElementById('toggleHide')?.classList.toggle('active', state.hideMode);
  document.getElementById('hideBanner')?.classList.toggle('hidden', !state.hideMode);
  document.getElementById('showAllBtn')?.classList.toggle('hidden', state.hiddenItems.size === 0);

  if (state.hideMode) {
    setStatus('Hide Mode — click elements to hide');
  } else {
    setStatus('Hide mode off');
  }
}

async function handleHideClick() {
  if (!state.caster || !state.fragments) return;
  const result = await state.caster.castRay();
  if (!result || !result.object) return;

  let modelId = null;
  const localId = result.localId ?? result.itemId ?? null;

  if (result.fragments?.id) {
    modelId = result.fragments.id;
  } else if (state.fragments.list.size > 0) {
    modelId = state.fragments.list.keys().next().value;
  }

  if (modelId == null || localId == null) return;

  const key = `${modelId}:${localId}`;
  if (state.hiddenItems.has(key)) return;

  // Get name for display
  let name = `#${localId}`;
  try {
    const model = state.fragments.list.get(modelId);
    if (model) {
      const data = await model.getItemsData([localId]);
      if (data && data[0]) {
        const nameVal = data[0].Name?.value || data[0].name?.value;
        if (nameVal) name = String(nameVal);
      }
    }
  } catch (_) {}

  state.hiddenItems.set(key, { modelId, localId, name });

  // Hide using FragmentsManager visibility
  try {
    const items = { [modelId]: new Set([localId]) };
    state.fragments.setVisibility(false, items);
    state.fragments.core.update(true);
  } catch (err) {
    console.warn('Hide failed:', err);
  }

  updateHideBadge();
  document.getElementById('showAllBtn')?.classList.remove('hidden');
}

function showAllHidden() {
  if (state.hiddenItems.size === 0) return;

  // Group by model
  const byModel = {};
  for (const [, val] of state.hiddenItems) {
    if (!byModel[val.modelId]) byModel[val.modelId] = new Set();
    byModel[val.modelId].add(val.localId);
  }

  try {
    state.fragments.setVisibility(true, byModel);
    state.fragments.core.update(true);
  } catch (err) {
    console.warn('Show all failed:', err);
  }

  state.hiddenItems.clear();
  updateHideBadge();
  document.getElementById('showAllBtn')?.classList.add('hidden');
  setStatus('All elements shown');
}

function updateHideBadge() {
  const badge = document.getElementById('hideBadge');
  if (badge) {
    const count = state.hiddenItems.size;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

// =====================================
// DELETE MODE
// =====================================

function toggleDeleteMode() {
  if (state.hideMode) toggleHideMode(); // exit hide mode first
  state.deleteMode = !state.deleteMode;
  document.getElementById('toggleDelete')?.classList.toggle('active', state.deleteMode);
  document.getElementById('deleteBanner')?.classList.toggle('hidden', !state.deleteMode);
  document.getElementById('undoDeleteBtn')?.classList.toggle('hidden', state.deletedStack.length === 0);

  if (state.deleteMode) {
    setStatus('Delete Mode — click elements to delete (Ctrl+Z to undo)');
  } else {
    setStatus('Delete mode off');
  }
}

async function handleDeleteClick() {
  if (!state.caster || !state.fragments) return;
  const result = await state.caster.castRay();
  if (!result || !result.object) return;

  let modelId = null;
  const localId = result.localId ?? result.itemId ?? null;

  if (result.fragments?.id) {
    modelId = result.fragments.id;
  } else if (state.fragments.list.size > 0) {
    modelId = state.fragments.list.keys().next().value;
  }

  if (modelId == null || localId == null) return;

  const key = `${modelId}:${localId}`;
  if (state.deletedSet.has(key)) return;

  // Get name
  let name = `#${localId}`;
  try {
    const model = state.fragments.list.get(modelId);
    if (model) {
      const data = await model.getItemsData([localId]);
      if (data && data[0]) {
        const nameVal = data[0].Name?.value || data[0].name?.value;
        if (nameVal) name = String(nameVal);
      }
    }
  } catch (_) {}

  state.deletedStack.push({ modelId, localId, name });
  state.deletedSet.add(key);

  // Hide the element (simulating delete)
  try {
    const items = { [modelId]: new Set([localId]) };
    state.fragments.setVisibility(false, items);
    state.fragments.core.update(true);
  } catch (err) {
    console.warn('Delete failed:', err);
  }

  updateDeleteBadge();
  document.getElementById('undoDeleteBtn')?.classList.remove('hidden');

  // Rebuild tree to remove deleted items
  buildModelTree();
}

function undoDelete() {
  if (state.deletedStack.length === 0) return;

  const item = state.deletedStack.pop();
  const key = `${item.modelId}:${item.localId}`;
  state.deletedSet.delete(key);

  // Show the element again
  try {
    const items = { [item.modelId]: new Set([item.localId]) };
    state.fragments.setVisibility(true, items);
    state.fragments.core.update(true);
  } catch (err) {
    console.warn('Undo delete failed:', err);
  }

  updateDeleteBadge();
  if (state.deletedStack.length === 0) {
    document.getElementById('undoDeleteBtn')?.classList.add('hidden');
  }

  buildModelTree();
  setStatus(`Restored: ${item.name}`);
}

function updateDeleteBadge() {
  const badge = document.getElementById('deleteBadge');
  if (badge) {
    const count = state.deletedSet.size;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

// =====================================
// CLIPPING PLANES
// =====================================

function setupClipping() {
  ['x', 'y', 'z'].forEach((axis) => {
    const enable = document.getElementById(`clip${axis.toUpperCase()}Enable`);
    const slider = document.getElementById(`clip${axis.toUpperCase()}Slider`);
    const flip = document.getElementById(`clip${axis.toUpperCase()}Flip`);
    const valEl = document.getElementById(`clip${axis.toUpperCase()}Val`);

    if (!enable || !slider) return;

    enable.addEventListener('change', () => {
      state.clipEnabled[axis] = enable.checked;
      slider.disabled = !enable.checked;
      if (enable.checked) {
        updateClipPlane(axis);
      } else {
        removeClipPlane(axis);
        if (valEl) valEl.textContent = '--';
      }
    });

    slider.addEventListener('input', () => {
      if (state.clipEnabled[axis]) {
        updateClipPlane(axis);
      }
    });

    if (flip) {
      flip.addEventListener('click', () => {
        state.clipFlipped[axis] = !state.clipFlipped[axis];
        flip.classList.toggle('active', state.clipFlipped[axis]);
        if (state.clipEnabled[axis]) updateClipPlane(axis);
      });
    }
  });
}

function recomputeClipBounds() {
  const bbox = new THREE.Box3();
  let hasContent = false;
  for (const f of state.files) {
    if (f.model && f.model.object && f.model.object.children.length > 0) {
      bbox.expandByObject(f.model.object);
      hasContent = true;
    }
  }
  if (!hasContent) {
    state.modelBBox = null;
    return;
  }
  state.modelBBox = bbox;
}

function updateClipPlane(axis) {
  if (!state.modelBBox) recomputeClipBounds();
  if (!state.modelBBox) return;

  const slider = document.getElementById(`clip${axis.toUpperCase()}Slider`);
  const valEl = document.getElementById(`clip${axis.toUpperCase()}Val`);
  if (!slider) return;

  const t = parseInt(slider.value) / 100;
  const min = state.modelBBox.min;
  const max = state.modelBBox.max;

  const normal = new THREE.Vector3();
  let pos;
  const flipped = state.clipFlipped[axis];

  if (axis === 'x') {
    pos = min.x + t * (max.x - min.x);
    normal.set(flipped ? 1 : -1, 0, 0);
  } else if (axis === 'y') {
    pos = min.y + t * (max.y - min.y);
    normal.set(0, flipped ? 1 : -1, 0);
  } else {
    pos = min.z + t * (max.z - min.z);
    normal.set(0, 0, flipped ? 1 : -1);
  }

  const plane = new THREE.Plane(normal, -normal.dot(new THREE.Vector3(
    axis === 'x' ? pos : 0,
    axis === 'y' ? pos : 0,
    axis === 'z' ? pos : 0
  )));

  state.clipPlanes[axis] = plane;
  if (valEl) valEl.textContent = pos.toFixed(2);

  applyClipPlanes();
}

function removeClipPlane(axis) {
  state.clipPlanes[axis] = null;
  applyClipPlanes();
}

function applyClipPlanes() {
  const planes = [];
  ['x', 'y', 'z'].forEach((axis) => {
    if (state.clipPlanes[axis]) planes.push(state.clipPlanes[axis]);
  });

  // Apply to all model meshes via renderer
  const renderer = state.world?.renderer?.three;
  if (renderer) {
    renderer.clippingPlanes = planes;
  }

  // Also apply to all mesh materials in the scene
  state.world?.scene?.three?.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((mat) => {
        mat.clippingPlanes = planes.length > 0 ? planes : null;
        mat.clipShadows = true;
        mat.needsUpdate = true;
      });
    }
  });
}

// =====================================
// UI WIRING
// =====================================

function setupUI() {
  // File input — multi-file
  document.getElementById('ifcInput')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files) {
      for (const file of files) loadIFC(file);
    }
    e.target.value = ''; // reset so same file can be re-loaded
  });

  // Add file from file manager
  document.getElementById('addFileInput')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files) {
      for (const file of files) loadIFC(file);
    }
    e.target.value = '';
  });

  // Files button
  document.getElementById('toggleFiles')?.addEventListener('click', () => {
    if (state.files.length === 0) {
      // No files — open file picker directly
      document.getElementById('ifcInput')?.click();
      return;
    }
    const panel = document.getElementById('filesPanel');
    panel?.classList.toggle('hidden');
    document.getElementById('toggleFiles')?.classList.toggle('active', !panel?.classList.contains('hidden'));
  });

  // Tree toggle
  document.getElementById('toggleTree')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('hidden');
    document.getElementById('toggleTree')?.classList.toggle('active');
  });

  // Props toggle
  document.getElementById('toggleProps')?.addEventListener('click', () => {
    document.getElementById('propsPanel')?.classList.toggle('hidden');
    document.getElementById('toggleProps')?.classList.toggle('active');
  });

  // Clip toggle
  document.getElementById('toggleClipper')?.addEventListener('click', () => {
    const panel = document.getElementById('clipPanel');
    panel?.classList.toggle('hidden');
    document.getElementById('toggleClipper')?.classList.toggle('active', !panel?.classList.contains('hidden'));
  });

  // Hide mode
  document.getElementById('toggleHide')?.addEventListener('click', toggleHideMode);
  document.getElementById('showAllBtn')?.addEventListener('click', showAllHidden);

  // Delete mode
  document.getElementById('toggleDelete')?.addEventListener('click', toggleDeleteMode);
  document.getElementById('undoDeleteBtn')?.addEventListener('click', undoDelete);

  // Grid toggle
  document.getElementById('toggleGrid')?.addEventListener('click', () => {
    const btn = document.getElementById('toggleGrid');
    if (state.grid) {
      state.grid.visible = !state.grid.visible;
      btn?.classList.toggle('active');
    }
  });

  // Server models
  setupServerModels();

  // Filter actions
  setupFilterActions();

  // Double-click to select element
  const rendererDom = state.world.renderer.three.domElement;
  rendererDom.addEventListener('dblclick', () => {
    handleSelection();
  });

  // Hover highlight
  let hoverThrottle = false;
  rendererDom.addEventListener('mousemove', () => {
    if (hoverThrottle || !state.caster) return;
    hoverThrottle = true;
    requestAnimationFrame(async () => {
      hoverThrottle = false;
      const result = await state.caster.castRay();
      rendererDom.style.cursor = (result && result.object) ? 'crosshair' : '';
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', async (e) => {
    // ESC — clear selection, exit modes
    if (e.key === 'Escape') {
      if (state.hideMode) toggleHideMode();
      if (state.deleteMode) toggleDeleteMode();
      try { await state.fragments.resetHighlight(); } catch (_) {}
      document.getElementById('propsPanel')?.classList.add('hidden');
      document.getElementById('toggleProps')?.classList.remove('active');
    }

    // H — toggle hide mode
    if (e.key === 'h' || e.key === 'H') {
      if (e.shiftKey) {
        showAllHidden();
      } else if (!e.ctrlKey && !e.metaKey) {
        toggleHideMode();
      }
    }

    // D — toggle delete mode
    if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      toggleDeleteMode();
    }

    // Ctrl+Z — undo delete
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      undoDelete();
    }
  });
}

// =====================================
// DRAG & DROP (Multi-file)
// =====================================

function setupDragDrop() {
  const dropZone = document.getElementById('dropZone');
  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropZone?.classList.remove('hidden');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropZone?.classList.add('hidden');
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone?.classList.add('hidden');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    let loaded = 0;
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.ifc')) {
        loadIFC(file);
        loaded++;
      }
    }
    if (loaded === 0) {
      setStatus('Please drop .ifc file(s)');
    }
  });
}

// =====================================
// SVG ICONS
// =====================================

function eyeIcon() {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
}

function eyeOffIcon() {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
}

function trashIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
}

// =====================================
// START
// =====================================

init().catch((err) => {
  console.error('Init failed:', err);
  setStatus('Initialization failed: ' + err.message);
});
