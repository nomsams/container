// core-app.js
// Main logic for Dust Container Designer
// Uses Three.js ES modules via CDN

import * as THREE from "https://unpkg.com/three@0.162.0/build/three.module.js";
import { OrbitControls } from "https://unpkg.com/three@0.162.0/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "https://unpkg.com/three@0.162.0/examples/jsm/loaders/STLLoader.js";
import { STLExporter } from "https://unpkg.com/three@0.162.0/examples/jsm/exporters/STLExporter.js";

const HTML_VERSION = "1.0.0";
const JS_VERSION = "1.0.0";
const LOCAL_STORAGE_KEY = "dustContainerConfigV1";

const DEFAULTS = {
  L_rect: 1400,
  x_hopper: 700,
  H: 900,
  W: 1300,
  t_wall: 5,

  include_frame: true,
  H_frame: 100,
  W_pocket: 230,
  H_pocket: 91,
  S_pocket: 142,
  unlock_pockets: false,

  include_lid: false,
  t_lid: 3,
  r_hole: 200,
  lid_edge_length: 100,
  lid_offset_from_hopper_edge: 500,
  advanced_lid_material: false,
  rho_lid: 7850,

  shell_material: "steel",
  rho_shell: 7850,
  rho_dust: 1850,
  humidity: 0,
  fill_percentage: 80,

  snap_to_grid: true,
  move_step_mm: 50,
  show_reference_cube: false,
  show_cog_empty: true,
  show_cog_filled: true,

  export_lid_with_container: false,
};

let state = structuredClone(DEFAULTS);
let lastValidState = structuredClone(DEFAULTS);

// Undo / redo stacks
const undoStack = [];
const redoStack = [];

// Three.js globals
let renderer, scene, camera, controls;
let containerGroup, lidMesh, frameGroup;
let referenceCube;
let cogEmptyArrow, cogFilledArrow;
let importedObjects = []; // { mesh, name }
let selectedObject = null;

const loader = new STLLoader();
const exporter = new STLExporter();

let logListEl;
let logTextEl;

// Modal data
let pendingInvalid = null;

// Utility
function mmToM(mm) {
  return mm / 1000;
}
function formatNumber(value, decimals) {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return value.toFixed(decimals);
}

// Logging
function log(msg) {
  const ts = new Date().toLocaleTimeString();
  if (logTextEl) logTextEl.textContent = `${ts} – ${msg}`;
  if (logListEl) {
    const li = document.createElement("li");
    li.textContent = `${ts} – ${msg}`;
    logListEl.prepend(li);
    const max = 100;
    while (logListEl.children.length > max) {
      logListEl.removeChild(logListEl.lastChild);
    }
  }
}

// State helpers
function getCurrentState() {
  return structuredClone(state);
}
function applyStateToInputs() {
  // Main geometry
  setInputValue("input-l-rect", state.L_rect);
  setInputValue("input-x-hopper", state.x_hopper);
  setInputValue("input-h", state.H);
  setInputValue("input-w", state.W);
  setInputValue("input-t-wall", state.t_wall);

  // Frame
  setCheckbox("chk-include-frame", state.include_frame);
  setInputValue("input-h-frame", state.H_frame);
  setCheckbox("chk-unlock-pockets", state.unlock_pockets);
  setInputValue("input-w-pocket", state.W_pocket);
  setInputValue("input-h-pocket", state.H_pocket);
  setInputValue("input-s-pocket", state.S_pocket);
  setPocketLocked(!state.unlock_pockets);

  // Lid
  setCheckbox("chk-include-lid", state.include_lid);
  setInputValue("input-t-lid", state.t_lid);
  setInputValue("input-r-hole", state.r_hole);
  setInputValue("input-lid-edge", state.lid_edge_length);
  setInputValue("input-lid-offset", state.lid_offset_from_hopper_edge);
  setCheckbox("chk-advanced-lid-mat", state.advanced_lid_material);
  setInputValue("input-rho-lid", state.rho_lid);
  setLidMaterialInputsEnabled(state.advanced_lid_material);

  // Materials
  const shellSel = document.getElementById("select-shell-material");
  if (shellSel) shellSel.value = state.shell_material;
  setInputValue("input-rho-shell", state.rho_shell);
  setInputValue("input-rho-dust", state.rho_dust);
  setInputValue("input-humidity", state.humidity);
  setInputValue("input-fill-perc", state.fill_percentage);

  // View & movement
  setCheckbox("chk-snap-grid", state.snap_to_grid);
  setInputValue("input-move-step", state.move_step_mm);
  setCheckbox("chk-ref-cube", state.show_reference_cube);
  setCheckbox("chk-show-cog-empty", state.show_cog_empty);
  setCheckbox("chk-show-cog-filled", state.show_cog_filled);

  setCheckbox("chk-export-lid-with-container", state.export_lid_with_container);

  updateShellDensityByMaterial(false);
}

function setInputValue(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v;
}
function setCheckbox(id, checked) {
  const el = document.getElementById(id);
  if (el) el.checked = !!checked;
}

function setPocketLocked(locked) {
  ["input-w-pocket", "input-h-pocket", "input-s-pocket"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });
}
function setLidMaterialInputsEnabled(enabled) {
  const el = document.getElementById("input-rho-lid");
  if (el) el.disabled = !enabled;
}

function loadStateFromLocalStorage() {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = Object.assign(structuredClone(DEFAULTS), parsed);
      lastValidState = structuredClone(state);
      log("Loaded config from localStorage.");
    } else {
      log("Using default configuration.");
    }
  } catch (e) {
    console.warn("Failed to load state from localStorage", e);
    state = structuredClone(DEFAULTS);
    lastValidState = structuredClone(DEFAULTS);
  }
}
function saveStateToLocalStorage() {
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save state to localStorage", e);
  }
}

// Validation and Fix/Ignore modal
function openErrorModal(message, fixText, onFix, onIgnore) {
  const modal = document.getElementById("error-modal");
  const msgEl = document.getElementById("error-message");
  const fixEl = document.getElementById("error-fix-text");
  if (!modal || !msgEl || !fixEl) return;
  msgEl.textContent = message;
  fixEl.textContent = fixText || "";
  pendingInvalid = { onFix, onIgnore };
  modal.style.display = "flex";
}
function closeErrorModal() {
  const modal = document.getElementById("error-modal");
  if (modal) modal.style.display = "none";
  pendingInvalid = null;
}

function validateState(candidate) {
  // Returns { ok, message, fix, fields }.
  const c = candidate;

  // Basic positive checks
  if (c.L_rect <= 0 || c.H <= 0 || c.W <= 0 || c.t_wall <= 0) {
    return {
      ok: false,
      message: "All main dimensions (L_rect, H, W, t_wall) must be > 0.",
      fix: () => {
        c.L_rect = Math.max(c.L_rect, 100);
        c.H = Math.max(c.H, 100);
        c.W = Math.max(c.W, 100);
        c.t_wall = Math.max(c.t_wall, 2);
      },
      fields: ["input-l-rect", "input-h", "input-w", "input-t-wall"],
    };
  }

  // Wall thickness vs width
  const maxWall = Math.min(c.W, c.L_rect) / 4;
  if (c.t_wall * 2 >= c.W || c.t_wall * 2 >= c.L_rect) {
    return {
      ok: false,
      message: "Wall thickness is too large compared to width/length; inner cavity would collapse.",
      fix: () => {
        c.t_wall = Math.max(2, Math.floor(maxWall));
      },
      fields: ["input-t-wall"],
    };
  }

  // Pockets vs width
  if (c.include_frame) {
    const minMargin = 20;
    const neededWidth = 2 * c.W_pocket + c.S_pocket + 2 * minMargin;
    if (neededWidth > c.W) {
      return {
        ok: false,
        message:
          "Forklift pockets plus spacing require more width than available. Either reduce pocket size/spacing or increase container width.",
        fix: () => {
          const available = c.W - 2 * minMargin;
          // Keep spacing, shrink pockets equally
          const newPocket = Math.max(50, Math.floor((available - c.S_pocket) / 2));
          c.W_pocket = newPocket;
        },
        fields: ["input-w-pocket", "input-s-pocket", "input-w"],
      };
    }
  }

  // Lid: hole + edge must fit
  if (c.include_lid) {
    const maxRadiusByWidth = (c.W / 2) - c.lid_edge_length;
    const maxRadiusByLength = (c.L_rect / 2) - c.lid_edge_length;
    const maxAllow = Math.max(20, Math.min(maxRadiusByWidth, maxRadiusByLength));
    if (c.r_hole > maxAllow) {
      return {
        ok: false,
        message: "Lid hole radius too large relative to lid edge; ring thickness would be negative.",
        fix: () => {
          c.r_hole = maxAllow;
        },
        fields: ["input-r-hole", "input-lid-edge"],
      };
    }
  }

  return { ok: true };
}

function markInvalidFields(fields) {
  const all = document.querySelectorAll("input");
  all.forEach((el) => el.classList.remove("invalid"));
  if (!fields) return;
  fields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("invalid");
  });
}

// Commit state after validation and geometry update
function commitState(newState, logMsg = "Updated parameters.") {
  // Validate
  const cand = structuredClone(newState);
  const v = validateState(cand);
  if (!v.ok) {
    // highlight
    markInvalidFields(v.fields);
    openErrorModal(
      v.message,
      "Click Fix to auto-correct values; Ignore to keep values but keep previous geometry.",
      () => {
        // Fix
        v.fix && v.fix();
        markInvalidFields([]);
        // Update inputs & recalc with fixed values
        state = cand;
        lastValidState = structuredClone(state);
        pushUndoState();
        applyStateToInputs();
        rebuildSceneGeometry();
        updateOutputs();
        saveStateToLocalStorage();
        log("Auto-fix applied after invalid parameters.");
      },
      () => {
        // Ignore: keep visual but revert to lastValidState internally
        state = structuredClone(lastValidState);
        applyStateToInputs();
        log("Invalid parameters ignored; geometry unchanged.");
      }
    );
    return;
  }

  // OK
  markInvalidFields([]);
  // Save previous state for undo
  pushUndoState();
  redoStack.length = 0;
  state = cand;
  lastValidState = structuredClone(state);
  applyStateToInputs();
  rebuildSceneGeometry();
  updateOutputs();
  saveStateToLocalStorage();
  updateUndoRedoButtons();
  log(logMsg);
}

function pushUndoState() {
  undoStack.push(structuredClone(state));
  if (undoStack.length > 50) undoStack.shift();
}
function undo() {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  redoStack.push(structuredClone(state));
  state = prev;
  lastValidState = structuredClone(state);
  applyStateToInputs();
  rebuildSceneGeometry();
  updateOutputs();
  saveStateToLocalStorage();
  updateUndoRedoButtons();
  log("Undo.");
}
function redo() {
  if (!redoStack.length) return;
  const next = redoStack.pop();
  undoStack.push(structuredClone(state));
  state = next;
  lastValidState = structuredClone(state);
  applyStateToInputs();
  rebuildSceneGeometry();
  updateOutputs();
  saveStateToLocalStorage();
  updateUndoRedoButtons();
  log("Redo.");
}
function updateUndoRedoButtons() {
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

// Geometry building
function createContainerGroup() {
  const group = new THREE.Group();

  const L = mmToM(state.L_rect);
  const H = mmToM(state.H);
  const W = mmToM(state.W);
  const x = mmToM(state.x_hopper);
  const Hf = mmToM(state.H_frame);

  const shellColor = 0x2563eb;
  const frameColor = 0x00a676;
  const lidColor = 0x9ca3af;

  const shellMat = new THREE.MeshStandardMaterial({
    color: shellColor,
    metalness: 0.5,
    roughness: 0.4,
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: frameColor,
    metalness: 0.6,
    roughness: 0.3,
  });
  const lidMat = new THREE.MeshStandardMaterial({
    color: lidColor,
    metalness: 0.3,
    roughness: 0.6,
  });

  // Rectangular body
  const rectGeom = new THREE.BoxGeometry(L, H, W);
  const rectMesh = new THREE.Mesh(rectGeom, shellMat);
  rectMesh.position.set(L / 2, 0, H / 2);
  group.add(rectMesh);

  // Hopper wedge
  if (state.x_hopper > 0) {
    const wedgeGeom = buildWedgeGeometry(L, H, W, x);
    const wedgeMesh = new THREE.Mesh(wedgeGeom, shellMat);
    group.add(wedgeMesh);
  }

  // Frame
  if (state.include_frame && Hf > 0.001) {
    const frameGeom = new THREE.BoxGeometry(L, Hf, W);
    const frameMesh = new THREE.Mesh(frameGeom, frameMat);
    frameMesh.position.set(L / 2, 0, Hf / 2);
    group.add(frameMesh);
    frameGroup = frameMesh;
  } else {
    frameGroup = null;
  }

  // Lid mesh created separately
  lidMesh = null;
  if (state.include_lid) {
    const lidThickness = mmToM(state.t_lid);
    const lidGeom = new THREE.BoxGeometry(L, lidThickness, W);
    const lid = new THREE.Mesh(lidGeom, lidMat);
    // Place on top of container
    lid.position.set(L / 2, 0, H + lidThickness / 2);
    group.add(lid);
    lidMesh = lid;
  }

  // Set group position so that base aligned with z=0 and origin is at 0,0
  // We already have base at z=0; group is anchored at x from -x_hopper (if wedge) to L_rect
  // For simplicity, keep group origin at (0,0,0) here and use for CoG calculations.

  return group;
}

// Build wedge geometry as triangular prism
function buildWedgeGeometry(L_rect_m, H_m, W_m, x_m) {
  // wedge extends from x = -x_m to 0
  const hw = W_m / 2;
  // vertices
  const vertices = [
    // left side triangle (y = -hw)
    0, -hw, 0, // P1
    -x_m, -hw, 0, // P2
    0, -hw, H_m, // P3
    // right side triangle (y = +hw)
    0, hw, 0, // P4
    -x_m, hw, 0, // P5
    0, hw, H_m, // P6
  ];

  const indices = [
    // bottom quad (P1, P2, P5, P4)
    0, 1, 4,
    0, 4, 3,
    // back quad (P2, P3, P6, P5)
    1, 2, 5,
    1, 5, 4,
    // front quad (P3, P1, P4, P6)
    2, 0, 3,
    2, 3, 5,
    // left triangle (P1, P2, P3)
    0, 1, 2,
    // right triangle (P4, P6, P5)
    3, 5, 4,
  ];

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geom.setIndex(indices);
  geom.computeVertexNormals();

  // Shift wedge so that its right vertical edge sits at x=0; we already did that.
  return geom;
}

// Scene setup
function initThree() {
  const container = document.getElementById("renderer-container");
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 600;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f4f6);

  // Camera
  const aspect = w / h;
  const camSize = 3;
  camera = new THREE.OrthographicCamera(
    -camSize * aspect,
    camSize * aspect,
    camSize,
    -camSize,
    0.1,
    100
  );
  resetCameraToIsometric();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enablePan = true;
  // Pitch can go below floor (Q33), so no limit.

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(3, 4, 5);
  scene.add(dir);

  // Ground grid / slab
  const groundSize = 10;
  const slabGeom = new THREE.BoxGeometry(groundSize, 0.1, groundSize);
  const slabMat = new THREE.MeshStandardMaterial({
    color: 0xe5e7eb,
    roughness: 0.9,
    metalness: 0,
  });
  const slab = new THREE.Mesh(slabGeom, slabMat);
  slab.position.set(groundSize / 2 - 0.5, 0, -0.05);
  slab.receiveShadow = true;
  scene.add(slab);

  const grid = new THREE.GridHelper(groundSize, 20, 0xcbd5f5, 0xe5e7eb);
  grid.position.set(groundSize / 2 - 0.5, 0, 0.001);
  scene.add(grid);

  // Reference cube (1m)
  const cubeGeom = new THREE.BoxGeometry(1, 1, 1);
  const cubeMat = new THREE.MeshStandardMaterial({
    color: 0x7c3aed,
    transparent: true,
    opacity: 0.5,
  });
  referenceCube = new THREE.Mesh(cubeGeom, cubeMat);
  referenceCube.position.set(-1, -1, 0.5);
  referenceCube.visible = state.show_reference_cube;
  scene.add(referenceCube);

  // Container group
  containerGroup = createContainerGroup();
  scene.add(containerGroup);

  // CoG markers
  cogEmptyArrow = buildArrowHelper(0x0ea5e9);
  cogFilledArrow = buildArrowHelper(0xf97316);
  scene.add(cogEmptyArrow);
  scene.add(cogFilledArrow);

  // Raycaster for selection
  setupSelection();

  window.addEventListener("resize", onWindowResize);
  animate();
}

function resetCameraToIsometric() {
  const distance = 8;
  const angle = (Math.PI / 180) * 35;
  const azimuth = (Math.PI / 180) * 45;
  const x = distance * Math.cos(angle) * Math.cos(azimuth);
  const y = distance * Math.cos(angle) * Math.sin(azimuth);
  const z = distance * Math.sin(angle);
  camera.position.set(x, y, z);
  camera.lookAt(2, 0, 1);
}

function buildArrowHelper(color) {
  const dir = new THREE.Vector3(0, 0, -1);
  const origin = new THREE.Vector3(0, 0, 0);
  const length = 0.8;
  const headLength = 0.2;
  const headWidth = 0.15;
  const arrow = new THREE.ArrowHelper(dir, origin, length, color);
  return arrow;
}

function onWindowResize() {
  if (!renderer || !camera) return;
  const container = document.getElementById("renderer-container");
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 600;
  renderer.setSize(w, h);
  const aspect = w / h;
  const camSize = 3;
  camera.left = -camSize * aspect;
  camera.right = camSize * aspect;
  camera.top = camSize;
  camera.bottom = -camSize;
  camera.updateProjectionMatrix();
}

// Selection handling
let raycaster, mouse;
function setupSelection() {
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  renderer.domElement.addEventListener("pointerdown", (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const objects = [];
    if (containerGroup) objects.push(containerGroup);
    importedObjects.forEach((o) => objects.push(o.mesh));
    if (lidMesh && !containerGroup.children.includes(lidMesh)) objects.push(lidMesh);
    const intersects = raycaster.intersectObjects(objects, true);
    if (intersects.length > 0) {
      const obj = findRootObject(intersects[0].object);
      selectObject(obj);
    }
  });
}
function findRootObject(obj) {
  // We treat containerGroup as single object, imported meshes by top-level.
  if (!obj || !obj.parent) return obj;
  let current = obj;
  while (current.parent && current.parent !== scene) {
    if (current === containerGroup) return containerGroup;
    current = current.parent;
  }
  return current;
}
function selectObject(obj) {
  selectedObject = obj;
  log(`Selected object: ${obj === containerGroup ? "Container" : (obj.userData.name || "Imported")}`);
}

// Movement (WASD)
function setupKeyboard() {
  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if (!selectedObject) return;
    let dx = 0;
    let dy = 0;
    if (key === "w") dy += 1;
    else if (key === "s") dy -= 1;
    else if (key === "a") dx -= 1;
    else if (key === "d") dx += 1;
    else return;

    e.preventDefault();

    const step = mmToM(state.move_step_mm);
    const pos = selectedObject.position.clone();
    pos.x += dx * step;
    pos.y += dy * step;

    if (state.snap_to_grid) {
      const gs = mmToM(100); // 100 mm grid
      pos.x = Math.round(pos.x / gs) * gs;
      pos.y = Math.round(pos.y / gs) * gs;
    }

    selectedObject.position.copy(pos);
    log(`Moved selected object with ${key.toUpperCase()}.`);
    // Collision recalculation happens naturally in animate/render.
  });
}

// Scene update
function rebuildSceneGeometry() {
  if (containerGroup) {
    scene.remove(containerGroup);
  }
  containerGroup = createContainerGroup();
  scene.add(containerGroup);
  referenceCube.visible = state.show_reference_cube;
  updateCogMarkers();
}

// CoG + outputs
function updateOutputs() {
  const results = computeVolumesAndMasses();

  document.getElementById("out-v-int").textContent = formatNumber(results.V_internal, 3);
  document.getElementById("out-v-fill").textContent = formatNumber(results.V_fill, 3);
  document.getElementById("out-m-shell").textContent = formatNumber(results.m_shell, 1);
  document.getElementById("out-m-lid").textContent = formatNumber(results.m_lid, 1);
  document.getElementById("out-m-dust").textContent = formatNumber(results.m_dust, 1);
  document.getElementById("out-m-total").textContent = formatNumber(results.m_total, 1);

  const cEmpty = results.cog_empty;
  const cFilled = results.cog_filled;
  document.getElementById("out-cog-empty").textContent =
    cEmpty ? `(${formatNumber(cEmpty.x, 3)}, ${formatNumber(cEmpty.y, 3)}, ${formatNumber(cEmpty.z, 3)})` : "–";
  document.getElementById("out-cog-filled").textContent =
    cFilled ? `(${formatNumber(cFilled.x, 3)}, ${formatNumber(cFilled.y, 3)}, ${formatNumber(cFilled.z, 3)})` : "–";

  updateCogMarkers(results);
}

function computeVolumesAndMasses() {
  // Outer volumes
  const L = mmToM(state.L_rect);
  const H = mmToM(state.H);
  const W = mmToM(state.W);
  const x = mmToM(state.x_hopper);
  const Hf = mmToM(state.H_frame);
  const t = mmToM(state.t_wall);

  // Rectangular internal
  const L_inner = Math.max(0.001, L - 2 * t);
  const W_inner = Math.max(0.001, W - 2 * t);
  const H_inner = Math.max(0.001, H - t); // simple: open top, only bottom thickness

  // Hopper internal (approx)
  const x_inner = Math.max(0, x - t);
  const H_inner_tri = H_inner;

  const V_rect_inner = L_inner * W_inner * H_inner;
  const V_hopper_inner = 0.5 * x_inner * H_inner_tri * W_inner;
  const V_internal = V_rect_inner + V_hopper_inner;

  const fillFraction = Math.min(1, Math.max(0, state.fill_percentage / 100));
  const V_fill = V_internal * fillFraction;

  // Outer volumes (solid)
  const V_rect_outer = L * W * H;
  const V_hopper_outer = x > 0 ? 0.5 * x * H * W : 0;
  const V_frame_outer = state.include_frame ? L * W * Hf : 0;

  // Approx pockets volume
  const Wp = mmToM(state.W_pocket);
  const Hp = mmToM(state.H_pocket);
  const Sp = mmToM(state.S_pocket);
  const minMargin = mmToM(20);
  let V_pockets = 0;
  if (state.include_frame) {
    const availableWidth = W - 2 * minMargin;
    if (2 * Wp + Sp <= availableWidth + 1e-6) {
      // pockets full-height through frame
      const V_one = L * Wp * Hp;
      V_pockets = 2 * V_one;
    }
  }

  const V_outer = V_rect_outer + V_hopper_outer + V_frame_outer;
  const V_shell = Math.max(0, V_outer - V_internal - V_pockets);

  const rhoShell = state.rho_shell;
  const rhoDust = state.rho_dust;
  const rhoLid = state.advanced_lid_material ? state.rho_lid : rhoShell;

  // Lid volume
  let V_lid = 0;
  if (state.include_lid) {
    const lidThickness = mmToM(state.t_lid);
    const areaLid = L * W;
    const rHole = mmToM(state.r_hole);
    const areaHole = Math.PI * rHole * rHole;
    V_lid = Math.max(0, (areaLid - areaHole) * lidThickness);
  }

  const m_shell = V_shell * rhoShell;
  const m_lid = V_lid * (state.include_lid ? rhoLid : 0);
  const m_dust = V_fill * rhoDust;
  const m_empty = m_shell + m_lid;
  const m_total = m_empty + m_dust;

  // CoG (outer-only centroids)
  const c_rect = {
    x: L / 2,
    y: 0,
    z: H / 2,
  };
  const c_hopper =
    x > 0
      ? {
          x: -x / 3,
          y: 0,
          z: H / 3,
        }
      : null;
  const c_frame = state.include_frame
    ? {
        x: L / 2,
        y: 0,
        z: Hf / 2,
      }
    : null;
  const c_lid =
    state.include_lid && V_lid > 0
      ? {
          x: L / 2,
          y: 0,
          z: H + mmToM(state.t_lid) / 2,
        }
      : null;

  // Outer volumes for centroid weighting (shell)
  const components_empty = [];
  if (V_rect_outer > 0) components_empty.push({ v: V_rect_outer, c: c_rect });
  if (V_hopper_outer > 0) components_empty.push({ v: V_hopper_outer, c: c_hopper });
  if (V_frame_outer > 0) components_empty.push({ v: V_frame_outer, c: c_frame });
  if (state.include_lid && V_lid > 0) {
    components_empty.push({ v: V_lid, c: c_lid });
  }

  function weightedCentroid(components) {
    let vx = 0,
      vy = 0,
      vz = 0,
      vt = 0;
    components.forEach((comp) => {
      if (!comp || !comp.c) return;
      vx += comp.v * comp.c.x;
      vy += comp.v * comp.c.y;
      vz += comp.v * comp.c.z;
      vt += comp.v;
    });
    if (vt <= 0) return null;
    return { x: vx / vt, y: vy / vt, z: vz / vt };
  }

  const cog_empty = weightedCentroid(components_empty);

  // Dust centroid: simple approximation
  let cog_dust = null;
  if (m_dust > 0 && V_internal > 0) {
    const z_int = H_inner / 2; // approximate centroid of internal cavity in z
    const z_dust = z_int * fillFraction; // simple linear model
    cog_dust = {
      x: L / 2, // approximate
      y: 0,
      z: z_dust,
    };
  }

  let cog_filled = null;
  if (cog_empty && cog_dust && m_dust > 0 && m_empty > 0) {
    const M1 = m_empty;
    const M2 = m_dust;
    const x = (M1 * cog_empty.x + M2 * cog_dust.x) / (M1 + M2);
    const y = (M1 * cog_empty.y + M2 * cog_dust.y) / (M1 + M2);
    const z = (M1 * cog_empty.z + M2 * cog_dust.z) / (M1 + M2);
    cog_filled = { x, y, z };
  } else if (cog_empty) {
    cog_filled = cog_empty;
  }

  return {
    V_internal,
    V_fill,
    m_shell,
    m_lid,
    m_dust,
    m_total,
    cog_empty,
    cog_filled,
  };
}

function updateCogMarkers(results) {
  if (!results) results = computeVolumesAndMasses();
  const { cog_empty, cog_filled } = results;

  const showEmpty = state.show_cog_empty && cog_empty;
  const showFilled = state.show_cog_filled && cog_filled;

  cogEmptyArrow.visible = !!showEmpty;
  cogFilledArrow.visible = !!showFilled;

  if (showEmpty) {
    const origin = new THREE.Vector3(cog_empty.x, cog_empty.y, cog_empty.z);
    const dir = new THREE.Vector3(0, 0, -1);
    const length = 0.8;
    cogEmptyArrow.position.copy(origin);
    cogEmptyArrow.setDirection(dir);
    cogEmptyArrow.setLength(length, 0.2, 0.12);
  }

  if (showFilled) {
    const origin = new THREE.Vector3(cog_filled.x, cog_filled.y, cog_filled.z);
    const dir = new THREE.Vector3(0, 0, -1);
    const length = 0.8;
    cogFilledArrow.position.copy(origin);
    cogFilledArrow.setDirection(dir);
    cogFilledArrow.setLength(length, 0.2, 0.12);
  }
}

// Collision detection (AABB)
function updateCollisions() {
  // For simplicity, check containerGroup vs importedObjects
  if (!containerGroup) return;
  const containerBox = new THREE.Box3().setFromObject(containerGroup);
  importedObjects.forEach((obj) => {
    const box = new THREE.Box3().setFromObject(obj.mesh);
    if (containerBox.intersectsBox(box)) {
      const intersection = containerBox.clone().intersect(box);
      const size = new THREE.Vector3();
      intersection.getSize(size);
      const dx = size.x;
      const dy = size.y;
      const dz = size.z;
      const V_int_m3 = dx * dy * dz;
      const V_int_l = V_int_m3 * 1000;
      if (V_int_m3 > 0) {
        log(
          `Collision: overlap approx ${formatNumber(dx * 1000, 1)} x ${formatNumber(
            dy * 1000,
            1
          )} x ${formatNumber(dz * 1000, 1)} mm, ~${formatNumber(V_int_l, 2)} L`
        );
      }
    }
  });
}

// STL import/export
function importSTL(file) {
  if (!file) return;
  const maxSize = 15 * 1024 * 1024;
  if (file.size > maxSize) {
    const proceed = window.confirm(
      "File is large and may slow your browser (" +
        (file.size / (1024 * 1024)).toFixed(1) +
        " MB). Continue?"
    );
    if (!proceed) return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    const buffer = e.target.result;
    const geom = loader.parse(buffer);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6b7280,
      metalness: 0.1,
      roughness: 0.7,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    mesh.position.sub(center);
    mesh.position.z += size.z / 2 + 0.01;
    mesh.userData.name = file.name;
    scene.add(mesh);
    importedObjects.push({ mesh, name: file.name });
    log(`Imported STL: ${file.name}`);
  };
  reader.readAsArrayBuffer(file);
}

function exportContainer(includeLidInExport) {
  if (!containerGroup) return;
  // Clone containerGroup to new group and normalize base center to origin
  const exportGroup = new THREE.Group();
  containerGroup.traverse((obj) => {
    if (obj.isMesh) {
      const clone = obj.clone();
      clone.material = clone.material.clone();
      exportGroup.add(clone);
    }
  });
  if (includeLidInExport && lidMesh && !containerGroup.children.includes(lidMesh)) {
    const cloneLid = lidMesh.clone();
    exportGroup.add(cloneLid);
  }

  const box = new THREE.Box3().setFromObject(exportGroup);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Translate so base at z=0 and center at (0,0)
  const offset = new THREE.Vector3(-center.x, -center.y, -box.min.z);
  exportGroup.position.add(offset);

  const result = exporter.parse(exportGroup, { binary: true });
  const blob = new Blob([result], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  const L = state.L_rect;
  const H = state.H;
  const W = state.W;
  link.href = url;
  link.download = `container_${L}x${W}x${H}.stl`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  log("Exported container STL.");
}

function exportLid() {
  if (!state.include_lid || !lidMesh) {
    log("Lid not included; nothing to export.");
    return;
  }

  const exportGroup = new THREE.Group();
  const clone = lidMesh.clone();
  exportGroup.add(clone);

  const box = new THREE.Box3().setFromObject(exportGroup);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const offset = new THREE.Vector3(-center.x, -center.y, -box.min.z);
  exportGroup.position.add(offset);

  const result = exporter.parse(exportGroup, { binary: true });
  const blob = new Blob([result], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `lid_${state.L_rect}x${state.W}.stl`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  log("Exported lid STL.");
}

// Shell material / density link
function updateShellDensityByMaterial(updateState = true) {
  const sel = document.getElementById("select-shell-material");
  const densityInput = document.getElementById("input-rho-shell");
  if (!sel || !densityInput) return;

  let rho = state.rho_shell;
  if (sel.value === "steel") rho = 7850;
  else if (sel.value === "stainless") rho = 8000;
  else if (sel.value === "aluminum") rho = 2700;
  if (sel.value !== "custom") {
    densityInput.value = rho;
    densityInput.disabled = true;
  } else {
    densityInput.disabled = false;
  }

  if (updateState) {
    state.shell_material = sel.value;
    state.rho_shell = parseFloat(densityInput.value) || rho;
    commitState(state, "Changed shell material.");
  }
}

// Config export/import
function exportConfig() {
  const json = JSON.stringify(state, null, 2);
  navigator.clipboard
    .writeText(json)
    .then(() => {
      log("Config JSON copied to clipboard.");
    })
    .catch(() => {
      log("Failed to copy config to clipboard.");
      alert("Config JSON:\n\n" + json);
    });
}
function importConfig() {
  const text = window.prompt("Paste JSON config here:");
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    const merged = Object.assign(structuredClone(DEFAULTS), parsed);
    commitState(merged, "Imported configuration.");
  } catch (e) {
    alert("Invalid JSON.");
  }
}

// Copy HTML + JS source
async function copyFullSource() {
  try {
    const [htmlResp, jsResp] = await Promise.all([
      fetch(window.location.href),
      fetch("core-app.js"),
    ]);
    const htmlText = await htmlResp.text();
    const jsText = await jsResp.text();
    const combined =
      "----- HTML START -----\n" +
      htmlText +
      "\n----- HTML END -----\n\n" +
      "----- JS START -----\n" +
      jsText +
      "\n----- JS END -----\n";
    await navigator.clipboard.writeText(combined);
    log("HTML + JS source copied to clipboard.");
  } catch (e) {
    console.warn("Copy source failed", e);
    alert("Failed to copy source automatically. See console for details.");
  }
}

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
  updateCollisions();
}

// Event wiring
function setupUI() {
  // Version labels
  const htmlLabel = document.getElementById("html-version-label");
  const jsLabel = document.getElementById("js-version-label");
  if (htmlLabel) htmlLabel.textContent = HTML_VERSION;
  if (jsLabel) jsLabel.textContent = JS_VERSION;

  logListEl = document.getElementById("log-list");
  logTextEl = document.getElementById("log-text");

  // Error modal buttons
  const fixBtn = document.getElementById("btn-error-fix");
  const ignoreBtn = document.getElementById("btn-error-ignore");
  if (fixBtn) {
    fixBtn.addEventListener("click", () => {
      if (pendingInvalid && pendingInvalid.onFix) pendingInvalid.onFix();
      closeErrorModal();
    });
  }
  if (ignoreBtn) {
    ignoreBtn.addEventListener("click", () => {
      if (pendingInvalid && pendingInvalid.onIgnore) pendingInvalid.onIgnore();
      closeErrorModal();
    });
  }

  // Log toggle
  const logToggle = document.getElementById("log-toggle");
  const logPanel = document.getElementById("log-panel");
  if (logToggle && logPanel) {
    logToggle.addEventListener("click", () => {
      logPanel.style.display = logPanel.style.display === "block" ? "none" : "block";
    });
  }

  // Main geometry inputs
  hookNumberInput("input-l-rect", (v) => {
    const s = getCurrentState();
    s.L_rect = v;
    commitState(s, "Changed L_rect.");
  });
  hookNumberInput("input-x-hopper", (v) => {
    const s = getCurrentState();
    s.x_hopper = v;
    commitState(s, "Changed x_hopper.");
  });
  hookNumberInput("input-h", (v) => {
    const s = getCurrentState();
    s.H = v;
    commitState(s, "Changed H.");
  });
  hookNumberInput("input-w", (v) => {
    const s = getCurrentState();
    s.W = v;
    commitState(s, "Changed W.");
  });
  hookNumberInput("input-t-wall", (v) => {
    const s = getCurrentState();
    s.t_wall = v;
    commitState(s, "Changed t_wall.");
  });

  // Frame
  hookCheckbox("chk-include-frame", (checked) => {
    const s = getCurrentState();
    s.include_frame = checked;
    commitState(s, "Toggled frame.");
  });
  hookNumberInput("input-h-frame", (v) => {
    const s = getCurrentState();
    s.H_frame = v;
    commitState(s, "Changed H_frame.");
  });
  hookCheckbox("chk-unlock-pockets", (checked) => {
    const s = getCurrentState();
    s.unlock_pockets = checked;
    setPocketLocked(!checked);
    commitState(s, "Toggled pocket lock.");
  });
  hookNumberInput("input-w-pocket", (v) => {
    const s = getCurrentState();
    s.W_pocket = v;
    commitState(s, "Changed pocket width.");
  });
  hookNumberInput("input-h-pocket", (v) => {
    const s = getCurrentState();
    s.H_pocket = v;
    commitState(s, "Changed pocket height.");
  });
  hookNumberInput("input-s-pocket", (v) => {
    const s = getCurrentState();
    s.S_pocket = v;
    commitState(s, "Changed pocket spacing.");
  });

  // Lid
  hookCheckbox("chk-include-lid", (checked) => {
    const s = getCurrentState();
    s.include_lid = checked;
    commitState(s, "Toggled lid.");
  });
  hookNumberInput("input-t-lid", (v) => {
    const s = getCurrentState();
    s.t_lid = v;
    commitState(s, "Changed lid thickness.");
  });
  hookNumberInput("input-r-hole", (v) => {
    const s = getCurrentState();
    s.r_hole = v;
    commitState(s, "Changed lid hole radius.");
  });
  hookNumberInput("input-lid-edge", (v) => {
    const s = getCurrentState();
    s.lid_edge_length = v;
    commitState(s, "Changed lid edge.");
  });
  hookNumberInput("input-lid-offset", (v) => {
    const s = getCurrentState();
    s.lid_offset_from_hopper_edge = v;
    commitState(s, "Changed lid offset.");
  });
  hookCheckbox("chk-advanced-lid-mat", (checked) => {
    const s = getCurrentState();
    s.advanced_lid_material = checked;
    setLidMaterialInputsEnabled(checked);
    commitState(s, "Toggled advanced lid material.");
  });
  hookNumberInput("input-rho-lid", (v) => {
    const s = getCurrentState();
    s.rho_lid = v;
    commitState(s, "Changed lid density.");
  });

  // Materials & dust
  const shellSel = document.getElementById("select-shell-material");
  if (shellSel) {
    shellSel.addEventListener("change", () => updateShellDensityByMaterial(true));
  }
  hookNumberInput("input-rho-shell", (v) => {
    const s = getCurrentState();
    s.rho_shell = v;
    s.shell_material = "custom";
    const sel = document.getElementById("select-shell-material");
    if (sel) sel.value = "custom";
    commitState(s, "Changed shell density.");
  });
  hookNumberInput("input-rho-dust", (v) => {
    const s = getCurrentState();
    s.rho_dust = v;
    commitState(s, "Changed dust density.");
  });
  hookNumberInput("input-humidity", (v) => {
    const s = getCurrentState();
    s.humidity = v;
    commitState(s, "Changed humidity (info only).");
  });
  hookNumberInput("input-fill-perc", (v) => {
    const s = getCurrentState();
    s.fill_percentage = Math.max(0, Math.min(100, v));
    commitState(s, "Changed fill percentage.");
  });

  // View & movement
  hookCheckbox("chk-snap-grid", (checked) => {
    const s = getCurrentState();
    s.snap_to_grid = checked;
    commitState(s, "Toggled snap to grid.");
  });
  hookNumberInput("input-move-step", (v) => {
    const s = getCurrentState();
    s.move_step_mm = v;
    commitState(s, "Changed move step.");
  });
  hookCheckbox("chk-ref-cube", (checked) => {
    const s = getCurrentState();
    s.show_reference_cube = checked;
    commitState(s, "Toggled reference cube.");
  });
  hookCheckbox("chk-show-cog-empty", (checked) => {
    const s = getCurrentState();
    s.show_cog_empty = checked;
    commitState(s, "Toggled CoG empty.");
  });
  hookCheckbox("chk-show-cog-filled", (checked) => {
    const s = getCurrentState();
    s.show_cog_filled = checked;
    commitState(s, "Toggled CoG filled.");
  });

  const resetViewBtn = document.getElementById("btn-reset-view");
  if (resetViewBtn) {
    resetViewBtn.addEventListener("click", () => {
      resetCameraToIsometric();
      log("View reset to isometric.");
    });
  }

  // Advanced
  const exportCfgBtn = document.getElementById("btn-export-config");
  if (exportCfgBtn) exportCfgBtn.addEventListener("click", exportConfig);
  const importCfgBtn = document.getElementById("btn-import-config");
  if (importCfgBtn) importCfgBtn.addEventListener("click", importConfig);

  const exportContainerBtn = document.getElementById("btn-export-container");
  if (exportContainerBtn) {
    exportContainerBtn.addEventListener("click", () => {
      exportContainer(state.export_lid_with_container);
    });
  }
  const exportLidBtn = document.getElementById("btn-export-lid");
  if (exportLidBtn) exportLidBtn.addEventListener("click", exportLid);

  hookCheckbox("chk-export-lid-with-container", (checked) => {
    const s = getCurrentState();
    s.export_lid_with_container = checked;
    commitState(s, "Toggled export lid with container.");
  });

  const importStlInput = document.getElementById("input-import-stl");
  if (importStlInput) {
    importStlInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      importSTL(file);
      importStlInput.value = "";
    });
  }

  const copySourceBtn = document.getElementById("btn-copy-source");
  if (copySourceBtn) copySourceBtn.addEventListener("click", copyFullSource);

  const resetDefaultsBtn = document.getElementById("btn-reset-defaults");
  if (resetDefaultsBtn) {
    resetDefaultsBtn.addEventListener("click", () => {
      const confirmReset = window.confirm("Reset all parameters to defaults and clear saved config?");
      if (!confirmReset) return;
      state = structuredClone(DEFAULTS);
      lastValidState = structuredClone(DEFAULTS);
      undoStack.length = 0;
      redoStack.length = 0;
      applyStateToInputs();
      rebuildSceneGeometry();
      updateOutputs();
      saveStateToLocalStorage();
      updateUndoRedoButtons();
      log("Reset to defaults.");
    });
  }

  // Undo/Redo buttons
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  if (undoBtn) undoBtn.addEventListener("click", undo);
  if (redoBtn) redoBtn.addEventListener("click", redo);

  updateUndoRedoButtons();
}

// Input helpers
function hookNumberInput(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => {
    const v = parseFloat(el.value);
    if (!Number.isFinite(v)) return;
    onChange(v);
  });
}
function hookCheckbox(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => onChange(el.checked));
}

// Init
window.addEventListener("DOMContentLoaded", () => {
  loadStateFromLocalStorage();
  applyStateToInputs();
  setupUI();
  initThree();
  setupKeyboard();
  updateOutputs();
  log("Application ready. Adjust parameters to begin.");
});
