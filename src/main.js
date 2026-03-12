import * as THREE from 'three';
import * as OBC from '@thatopen/components';

// =====================================
// GEOBIM.LAB — BIM Viewer v0.1
// That Open Components + Three.js
// =====================================

const state = {
  components: null,
  world: null,
  ifcLoader: null,
  fragments: null,
  caster: null,
  model: null,
};

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

  // Wire model loading
  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);

    let fitted = false;
    model.onViewUpdated.add(() => {
      fragments.core.update(true);
      if (!fitted && model.object.children.length > 0) {
        fitted = true;
        const bbox = new THREE.Box3().setFromObject(model.object);
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        console.log('Model loaded, bbox size:', size);
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
          world.camera.controls.setLookAt(
            center.x + maxDim, center.y + maxDim * 0.5, center.z + maxDim,
            center.x, center.y, center.z,
            true
          );
        }
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

  setStatus('Ready — Open an IFC file or drag & drop');
  console.log('geobim.lab initialized');

  setupUI();
  setupDragDrop();
}

// =====================================
// IFC LOADING
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
    state.model = model;

    updateProgress(100);
    setStatus(`${file.name} loaded`);
    console.log('IFC loaded:', file.name, `${(file.size / 1024 / 1024).toFixed(1)} MB`);
    hideLoading();
    buildModelTree(model);
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
    state.model = model;

    updateProgress(100);
    setStatus(`${name} loaded`);
    console.log('Server IFC loaded:', name, `${sizeMB} MB`);
    hideLoading();
    buildModelTree(model);
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

  // Toggle dropdown
  btn.addEventListener('click', () => {
    menu.classList.toggle('hidden');
  });

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });

  // Fetch model list (auto-generated by build script)
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
// MODEL TREE
// =====================================

async function buildModelTree(model) {
  const container = document.getElementById('modelTree');
  if (!container) return;

  container.innerHTML = '<p class="empty-state">Building tree...</p>';

  // Open sidebar
  document.getElementById('sidebar')?.classList.remove('hidden');
  document.getElementById('toggleTree')?.classList.add('active');

  try {
    // getItems() returns Map<localId, RawItemData{data, category, guid}>
    const itemsMap = await model.getItems();
    const modelId = model.id;

    if (!itemsMap || itemsMap.size === 0) {
      container.innerHTML = '<p class="empty-state">No elements found</p>';
      return;
    }

    // Group by category (IFC type)
    const groups = {}; // { category: [{localId, name, guid}] }
    itemsMap.forEach((rawItem, localId) => {
      const category = rawItem.category || 'Unknown';
      const name = rawItem.data?.Name?.value || rawItem.data?.name?.value || '';
      const guid = rawItem.guid || '';

      if (!groups[category]) groups[category] = [];
      groups[category].push({ localId, name: String(name), guid });
    });

    // Render tree
    container.innerHTML = '';
    const sortedTypes = Object.keys(groups).sort();
    let totalElements = 0;

    sortedTypes.forEach((type) => {
      const items = groups[type];
      totalElements += items.length;
      const groupEl = document.createElement('div');
      groupEl.className = 'tree-group';
      groupEl.dataset.type = type.toLowerCase();

      const header = document.createElement('div');
      header.className = 'tree-item';
      const color = typeColor(type);
      header.innerHTML = `<span class="tree-toggle">▶</span><span class="type-badge" style="background:${color}"></span><span>${escapeHtml(type)} (${items.length})</span>`;

      const children = document.createElement('div');
      children.className = 'tree-children collapsed';

      items.forEach(({ localId, name }) => {
        const item = document.createElement('div');
        item.className = 'tree-item tree-leaf';
        item.style.paddingLeft = '24px';
        item.dataset.name = (name || '').toLowerCase();
        item.dataset.localid = localId;
        item.textContent = name || `#${localId}`;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          // Mark selected
          container.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          selectFromTree(modelId, localId);
        });
        children.appendChild(item);
      });

      header.addEventListener('click', () => {
        const collapsed = children.classList.contains('collapsed');
        children.classList.toggle('collapsed');
        header.querySelector('.tree-toggle').textContent = collapsed ? '▼' : '▶';
      });

      groupEl.appendChild(header);
      groupEl.appendChild(children);
      container.appendChild(groupEl);
    });

    // Wire search
    const searchInput = document.getElementById('treeSearch');
    const countEl = document.getElementById('treeCount');
    if (countEl) countEl.textContent = `${totalElements}`;

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase().trim();
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
          // Auto-expand groups with matches when searching
          if (q && groupVisible > 0) {
            group.querySelector('.tree-children')?.classList.remove('collapsed');
            const toggle = group.querySelector('.tree-toggle');
            if (toggle) toggle.textContent = '▼';
          }
          visible += groupVisible;
        });

        if (countEl) countEl.textContent = q ? `${visible}/${totalElements}` : `${totalElements}`;
      });
    }

    setStatus(`${model.id} — ${totalElements} elements, ${sortedTypes.length} types`);
  } catch (err) {
    console.error('buildModelTree failed:', err);
    container.innerHTML = '<p class="empty-state">Could not build tree</p>';
  }
}

async function selectFromTree(modelId, localId) {
  if (!state.fragments) return;

  const items = { [modelId]: new Set([localId]) };

  // Highlight
  try {
    await state.fragments.resetHighlight();
    await state.fragments.highlight(
      { color: new THREE.Color(0x2ECFB0), opacity: 0.6, transparent: true },
      items
    );
  } catch (_) {}

  // Show properties
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
// ELEMENT SELECTION + PROPERTIES
// =====================================

async function handleSelection() {
  if (!state.caster || !state.fragments) return;

  const result = await state.caster.castRay();

  // Clear previous highlight
  try {
    await state.fragments.resetHighlight();
  } catch (_) {}

  if (!result || !result.object) return;

  // Get model and element IDs
  let modelId = null;
  const localId = result.localId ?? result.itemId ?? null;

  if (result.fragments?.id) {
    modelId = result.fragments.id;
  } else if (state.fragments.list.size > 0) {
    modelId = state.fragments.list.keys().next().value;
  }

  // Highlight selected element
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
    // Separate direct attributes from property sets
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
      html += `<div class="props-group-title" onclick="this.parentElement.classList.toggle('collapsed')"><span class="pset-toggle">▶</span> ${escapeHtml(name)}</div>`;
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
  html += propRow('Local ID', result.localId ?? '—');
  html += propRow('Item ID', result.itemId ?? '—');
  html += propRow('Distance', result.distance?.toFixed(2) ?? '—');
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
  if (val === null || val === undefined) return '—';
  if (typeof val === 'number') return Number.isInteger(val) ? val.toString() : val.toFixed(4);
  return String(val);
}

// =====================================
// CLIPPING
// =====================================

let clipperActive = false;

function toggleClipper() {
  clipperActive = !clipperActive;
  const btn = document.getElementById('toggleClipper');
  if (clipperActive) {
    btn?.classList.add('active');
    setStatus('Click on model to place clipping plane');
  } else {
    btn?.classList.remove('active');
    setStatus('Clipping mode off');
  }
}

// =====================================
// UI WIRING
// =====================================

function setupUI() {
  document.getElementById('ifcInput')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadIFC(file);
  });

  document.getElementById('toggleTree')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('hidden');
    document.getElementById('toggleTree')?.classList.toggle('active');
  });

  document.getElementById('toggleProps')?.addEventListener('click', () => {
    document.getElementById('propsPanel')?.classList.toggle('hidden');
    document.getElementById('toggleProps')?.classList.toggle('active');
  });

  document.getElementById('toggleClipper')?.addEventListener('click', toggleClipper);
  setupServerModels();

  document.getElementById('toggleGrid')?.addEventListener('click', () => {
    const btn = document.getElementById('toggleGrid');
    if (state.grid) {
      state.grid.visible = !state.grid.visible;
      btn?.classList.toggle('active');
    }
  });

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

  // ESC to clear selection
  document.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      try { await state.fragments.resetHighlight(); } catch (_) {}
      document.getElementById('propsPanel')?.classList.add('hidden');
      document.getElementById('toggleProps')?.classList.remove('active');
    }
  });
}

// =====================================
// DRAG & DROP
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

    const file = e.dataTransfer?.files?.[0];
    if (file && file.name.toLowerCase().endsWith('.ifc')) {
      loadIFC(file);
    } else {
      setStatus('Please drop an .ifc file');
    }
  });
}

// =====================================
// START
// =====================================

init().catch((err) => {
  console.error('Init failed:', err);
  setStatus('Initialization failed: ' + err.message);
});
