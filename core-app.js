// core-app.js – Dust Container Designer PRO
// Pure front-end. Three.js + helpers from CDN.

import * as THREE from "https://unpkg.com/three@0.162.0/build/three.module.js";
import { OrbitControls } from "https://unpkg.com/three@0.162.0/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "https://unpkg.com/three@0.162.0/examples/jsm/loaders/STLLoader.js";
import { STLExporter } from "https://unpkg.com/three@0.162.0/examples/jsm/exporters/STLExporter.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const HTML_VERSION = "1.0.0";
const JS_VERSION = "1.1.0";
const STORAGE_KEY = "dustContainerConfigV1";

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
function mmToM(mm) {
  return mm / 1000;
}
function fmt(v, d) {
  if (v == null || Number.isNaN(v)) return "–";
  return v.toFixed(d);
}
function byId(id) {
  return document.getElementById(id);
}

/* ------------------------------------------------------------------ */
/* Default state                                                      */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  // main geometry
  L_rect: 1400,
  x_hopper: 700,
  H: 900,
  W: 1300,
  t_wall: 5,

  // frame & pockets
  include_frame: true,
  H_frame: 100,
  W_pocket: 230,
  H_pocket: 91,
  S_pocket: 142,
  unlock_pockets: false,

  // lid
  include_lid: false,
  t_lid: 3,
  r_hole: 200,
  lid_edge_length: 100,
  lid_offset_from_hopper_edge: 500,
  advanced_lid_material: false,
  rho_lid: 7850,

  // materials & dust
  shell_material: "steel",
  rho_shell: 7850,
  rho_dust: 1850,
  humidity: 0,
  fill_percentage: 80,

  // view & movement
  snap_to_grid: true,
  move_step_mm: 50,
  show_reference_cube: false,
  show_cog_empty: true,
  show_cog_filled: true,

  // export
  export_lid_with_container: false,
};

let state = deepClone(DEFAULTS);
let lastValidState = deepClone(DEFAULTS);

const undoStack = [];
const redoStack = [];

/* ------------------------------------------------------------------ */
/* Three.js globals                                                   */
/* ------------------------------------------------------------------ */

let renderer, scene, camera, controls;
let containerGroup, lidMesh, frameMesh, referenceCube;
let cogEmptyArrow, cogFilledArrow;
const importedObjects = []; // { mesh, name }
let collisionMarker = null;
let lastCollisionVolume = 0;

// selection & UI
let raycaster, mouse;
let selectedObject = null;
let logTextEl, logListEl;
let selectedNameEl, baseFaceSelectEl, objectListEl;
let pendingFixIgnore = null;

// STL
const loader = new STLLoader();
const exporter = new STLExporter();

/* ------------------------------------------------------------------ */
/* Logging & modal                                                    */
/* ------------------------------------------------------------------ */

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  if (logTextEl) logTextEl.textContent = `${ts} – ${msg}`;
  if (logListEl) {
    const li = document.createElement("li");
    li.textContent = `${ts} – ${msg}`;
    logListEl.prepend(li);
    while (logListEl.children.length > 200) {
      logListEl.removeChild(logListEl.lastChild);
    }
  }
}

function showModal(message, fixText, onFix, onIgnore) {
  const modal = byId("error-modal");
  if (!modal) return;
  byId("error-message").textContent = message;
  byId("error-fix-text").textContent = fixText || "";
  pendingFixIgnore = { onFix, onIgnore };
  modal.style.display = "flex";
}
function closeModal() {
  const modal = byId("error-modal");
  if (modal) modal.style.display = "none";
  pendingFixIgnore = null;
}

/* ------------------------------------------------------------------ */
/* State load/save & undo/redo                                        */
/* ------------------------------------------------------------------ */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = Object.assign(deepClone(DEFAULTS), parsed);
      lastValidState = deepClone(state);
      log("Loaded previous config.");
      return;
    }
  } catch (e) {
    console.warn("Failed to load state", e);
  }
  state = deepClone(DEFAULTS);
  lastValidState = deepClone(DEFAULTS);
  log("Using default config.");
}
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save state", e);
  }
}

function pushUndo() {
  undoStack.push(deepClone(state));
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function undo() {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  redoStack.push(deepClone(state));
  state = prev;
  lastValidState = deepClone(state);
  applyStateToInputs();
  rebuildGeometry();
  updateOutputs();
  saveState();
  updateUndoButtons();
  log("Undo.");
}
function redo() {
  if (!redoStack.length) return;
  const next = redoStack.pop();
  undoStack.push(deepClone(state));
  state = next;
  lastValidState = deepClone(state);
  applyStateToInputs();
  rebuildGeometry();
  updateOutputs();
  saveState();
  updateUndoButtons();
  log("Redo.");
}
function updateUndoButtons() {
  const u = byId("btn-undo");
  const r = byId("btn-redo");
  if (u) u.disabled = undoStack.length === 0;
  if (r) r.disabled = redoStack.length === 0;
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

function validateCandidate(c) {
  // Basic >0 checks
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

  // Wall thickness vs cavity
  const maxWall = Math.min(c.W, c.L_rect) / 4;
  if (2 * c.t_wall >= c.W || 2 * c.t_wall >= c.L_rect) {
    return {
      ok: false,
      message: "Wall thickness too large relative to width/length – inner cavity would collapse.",
      fix: () => {
        c.t_wall = Math.max(2, Math.floor(maxWall));
      },
      fields: ["input-t-wall"],
    };
  }

  // Hopper length can't exceed rectangular length
  if (c.x_hopper < 0 || c.x_hopper > c.L_rect) {
    return {
      ok: false,
      message: "x_hopper must be between 0 and L_rect (wedge cannot be longer than the rectangular part).",
      fix: () => {
        c.x_hopper = Math.max(0, Math.min(c.x_hopper, c.L_rect));
      },
      fields: ["input-x-hopper", "input-l-rect"],
    };
  }

  // Frame height should not exceed container
  if (c.include_frame && c.H_frame >= c.H) {
    return {
      ok: false,
      message: "Frame height H_frame should be smaller than container height H.",
      fix: () => {
        c.H_frame = Math.max(30, Math.floor(c.H / 3));
      },
      fields: ["input-h-frame", "input-h"],
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
          "Forklift pockets + spacing need more width than available. Reduce pocket width/spacing or increase container width.",
        fix: () => {
          const available = c.W - 2 * minMargin;
          const newPocket = Math.max(50, Math.floor((available - c.S_pocket) / 2));
          c.W_pocket = newPocket;
        },
        fields: ["input-w-pocket", "input-s-pocket", "input-w"],
      };
    }
  }

  // Lid hole + edge must fit
  if (c.include_lid) {
    const maxRByW = c.W / 2 - c.lid_edge_length;
    const maxRByL = c.L_rect / 2 - c.lid_edge_length;
    const maxR = Math.max(20, Math.min(maxRByW, maxRByL));
    if (c.r_hole > maxR) {
      return {
        ok: false,
        message: "Lid hole radius too large; ring edge would become negative.",
        fix: () => {
          c.r_hole = maxR;
        },
        fields: ["input-r-hole", "input-lid-edge"],
      };
    }
  }

  return { ok: true };
}

function markInvalid(fields) {
  document.querySelectorAll("input").forEach((el) => el.classList.remove("invalid"));
  if (!fields) return;
  fields.forEach((id) => {
    const el = byId(id);
    if (el) el.classList.add("invalid");
  });
}

function commitState(newState, msg) {
  const candidate = deepClone(newState);
  const v = validateCandidate(candidate);
  if (!v.ok) {
    markInvalid(v.fields);
    showModal(
      v.message,
      "Fix will auto-correct values. Ignore keeps the last valid geometry.",
      () => {
        v.fix && v.fix();
        state = candidate;
        lastValidState = deepClone(candidate);
        markInvalid([]);
        pushUndo();
        applyStateToInputs();
        rebuildGeometry();
        updateOutputs();
        saveState();
        log("Auto-fix applied.");
      },
      () => {
        state = deepClone(lastValidState);
        applyStateToInputs();
        markInvalid([]);
        log("Invalid parameters ignored; geometry unchanged.");
      }
    );
    return;
  }

  markInvalid([]);
  pushUndo();
  state = candidate;
  lastValidState = deepClone(candidate);
  applyStateToInputs();
  rebuildGeometry();
  updateOutputs();
  saveState();
  log(msg || "Updated parameters.");
}

/* ------------------------------------------------------------------ */
/* Apply state -> inputs                                              */
/* ------------------------------------------------------------------ */

function setVal(id, v) {
  const el = byId(id);
  if (el) el.value = v;
}
function setChecked(id, v) {
  const el = byId(id);
  if (el) el.checked = !!v;
}
function pocketLockUi(locked) {
  ["input-w-pocket", "input-h-pocket", "input-s-pocket"].forEach((id) => {
    const el = byId(id);
    if (el) el.disabled = locked;
  });
}
function lidMaterialUi(enabled) {
  const el = byId("input-rho-lid");
  if (el) el.disabled = !enabled;
}

function applyStateToInputs() {
  // geometry
  setVal("input-l-rect", state.L_rect);
  setVal("range-l-rect", state.L_rect);
  setVal("input-x-hopper", state.x_hopper);
  setVal("range-x-hopper", state.x_hopper);
  setVal("input-h", state.H);
  setVal("range-h", state.H);
  setVal("input-w", state.W);
  setVal("range-w", state.W);
  setVal("input-t-wall", state.t_wall);
  setVal("range-t-wall", state.t_wall);

  // frame
  setChecked("chk-include-frame", state.include_frame);
  setVal("input-h-frame", state.H_frame);
  setChecked("chk-unlock-pockets", state.unlock_pockets);
  setVal("input-w-pocket", state.W_pocket);
  setVal("input-h-pocket", state.H_pocket);
  setVal("input-s-pocket", state.S_pocket);
  pocketLockUi(!state.unlock_pockets);

  // lid
  setChecked("chk-include-lid", state.include_lid);
  setVal("input-t-lid", state.t_lid);
  setVal("input-r-hole", state.r_hole);
  setVal("input-lid-edge", state.lid_edge_length);
  setVal("input-lid-offset", state.lid_offset_from_hopper_edge);
  setChecked("chk-advanced-lid-mat", state.advanced_lid_material);
  setVal("input-rho-lid", state.rho_lid);
  lidMaterialUi(state.advanced_lid_material);

  // materials
  const sel = byId("select-shell-material");
  if (sel) sel.value = state.shell_material;
  setVal("input-rho-shell", state.rho_shell);
  setVal("input-rho-dust", state.rho_dust);
  setVal("input-humidity", state.humidity);
  setVal("input-fill-perc", state.fill_percentage);

  // view
  setChecked("chk-snap-grid", state.snap_to_grid);
  setVal("input-move-step", state.move_step_mm);
  setChecked("chk-ref-cube", state.show_reference_cube);
  setChecked("chk-show-cog-empty", state.show_cog_empty);
  setChecked("chk-show-cog-filled", state.show_cog_filled);

  // export
  setChecked("chk-export-lid-with-container", state.export_lid_with_container);
}

/* ------------------------------------------------------------------ */
/* Geometry creation                                                  */
/* ------------------------------------------------------------------ */

function buildWedgeGeometry(L_rect_m, H_m, W_m, x_m) {
  const hw = W_m / 2;
  const verts = [
    // y = -hw
    0, -hw, 0,
    -x_m, -hw, 0,
    0, -hw, H_m,
    // y = +hw
    0, hw, 0,
    -x_m, hw, 0,
    0, hw, H_m,
  ];
  const idx = [
    0, 1, 4, 0, 4, 3,
    1, 2, 5, 1, 5, 4,
    2, 0, 3, 2, 3, 5,
    0, 1, 2,
    3, 5, 4,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// simple ring on top of lid to visually indicate hole location
function createLidRingMesh(L, W, tLid) {
  const rHole = mmToM(state.r_hole);
  const ringWidth = mmToM(state.lid_edge_length);
  const outerR = rHole + ringWidth;
  const innerR = rHole;

  const segments = 48;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
  const holePath = new THREE.Path();
  holePath.absarc(0, 0, innerR, 0, Math.PI * 2, true);
  shape.holes.push(holePath);

  const extrudeSettings = {
    depth: tLid,
    bevelEnabled: false,
  };
  const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  geom.rotateX(Math.PI / 2); // stand on top of lid

  const mat = new THREE.MeshStandardMaterial({
    color: 0x6b7280,
    metalness: 0.3,
    roughness: 0.6,
  });

  const mesh = new THREE.Mesh(geom, mat);

  // Position ring center along length with offset from hopper edge (x=0)
  const offsetX = mmToM(state.lid_offset_from_hopper_edge);
  const cx = Math.min(Math.max(offsetX, 0), L);
  const cy = 0;
  const cz = mmToM(state.H) + tLid; // exactly on top of lid
  mesh.position.set(cx, cy, cz);

  return mesh;
}

function createContainerGroup() {
  const group = new THREE.Group();

  const L = mmToM(state.L_rect);
  const H = mmToM(state.H);
  const W = mmToM(state.W);
  const x = mmToM(state.x_hopper);
  const Hf = mmToM(state.H_frame);

  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x2563eb,
    metalness: 0.4,
    roughness: 0.4,
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x00a676,
    metalness: 0.5,
    roughness: 0.3,
  });
  const lidMat = new THREE.MeshStandardMaterial({
    color: 0x9ca3af,
    metalness: 0.2,
    roughness: 0.6,
  });

  // Rectangular body
  const rect = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), shellMat);
  rect.position.set(L / 2, 0, H / 2);
  group.add(rect);

  // Hopper wedge
  if (state.x_hopper > 0) {
    const wedgeGeom = buildWedgeGeometry(L, H, W, x);
    const wedge = new THREE.Mesh(wedgeGeom, shellMat);
    group.add(wedge);
  }

  // Frame
  frameMesh = null;
  if (state.include_frame && Hf > 0) {
    const fm = new THREE.Mesh(new THREE.BoxGeometry(L, Hf, W), frameMat);
    fm.position.set(L / 2, 0, Hf / 2);
    group.add(fm);
    frameMesh = fm;
  }

  // Lid
  lidMesh = null;
  if (state.include_lid) {
    const tLid = mmToM(state.t_lid);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(L, tLid, W), lidMat);
    lid.position.set(L / 2, 0, H + tLid / 2);
    group.add(lid);
    lidMesh = lid;

    // ring to visualize hole location
    const ring = createLidRingMesh(L, W, tLid);
    group.add(ring);
  }

  return group;
}

function rebuildGeometry() {
  if (!scene) return;
  const prevWasContainerSelected = selectedObject === containerGroup || !selectedObject;

  if (containerGroup) scene.remove(containerGroup);
  containerGroup = createContainerGroup();
  scene.add(containerGroup);

  if (prevWasContainerSelected) selectedObject = containerGroup;

  if (referenceCube) referenceCube.visible = state.show_reference_cube;

  updateCogMarkers();
  refreshObjectList();
  updateSelectionUi();
}

/* ------------------------------------------------------------------ */
/* Calculations for volume, mass & CoG                                */
/* ------------------------------------------------------------------ */

function computeVolumesAndMasses() {
  const L = mmToM(state.L_rect);
  const H = mmToM(state.H);
  const W = mmToM(state.W);
  const x = mmToM(state.x_hopper);
  const Hf = mmToM(state.H_frame);
  const t = mmToM(state.t_wall);

  const L_in = Math.max(0.001, L - 2 * t);
  const W_in = Math.max(0.001, W - 2 * t);
  const H_in = Math.max(0.001, H - t); // open top

  const x_in = Math.max(0, x - t);
  const H_tri_in = H_in;

  const V_rect_in = L_in * W_in * H_in;
  const V_hopper_in = 0.5 * x_in * H_tri_in * W_in;
  const V_internal = V_rect_in + V_hopper_in;

  const fillFrac = Math.min(1, Math.max(0, state.fill_percentage / 100));
  const V_fill = V_internal * fillFrac;

  const V_rect_out = L * W * H;
  const V_hopper_out = x > 0 ? 0.5 * x * H * W : 0;
  const V_frame_out = state.include_frame ? L * W * Hf : 0;

  const Wp = mmToM(state.W_pocket);
  const Hp = mmToM(state.H_pocket);
  const Sp = mmToM(state.S_pocket);
  const minMargin = mmToM(20);
  let V_pockets = 0;
  if (state.include_frame) {
    const availableWidth = W - 2 * minMargin;
    if (2 * Wp + Sp <= availableWidth + 1e-6) {
      const V_one = L * Wp * Hp;
      V_pockets = 2 * V_one;
    }
  }

  const V_outer = V_rect_out + V_hopper_out + V_frame_out;
  const V_shell = Math.max(0, V_outer - V_internal - V_pockets);

  const rhoShell = state.rho_shell;
  const rhoDust = state.rho_dust;
  const rhoLid = state.advanced_lid_material ? state.rho_lid : rhoShell;

  let V_lid = 0;
  if (state.include_lid) {
    const tLid = mmToM(state.t_lid);
    const areaLid = L * W;
    const rHole = mmToM(state.r_hole);
    const areaHole = Math.PI * rHole * rHole;
    V_lid = Math.max(0, (areaLid - areaHole) * tLid);
  }

  const m_shell = V_shell * rhoShell;
  const m_lid = V_lid * (state.include_lid ? rhoLid : 0);
  const m_dust = V_fill * rhoDust;
  const m_empty = m_shell + m_lid;
  const m_total = m_empty + m_dust;

  const c_rect = { x: L / 2, y: 0, z: H / 2 };
  const c_hopper = x > 0 ? { x: -x / 3, y: 0, z: H / 3 } : null;
  const c_frame = state.include_frame ? { x: L / 2, y: 0, z: Hf / 2 } : null;
  const c_lid =
    state.include_lid && V_lid > 0
      ? { x: L / 2, y: 0, z: H + mmToM(state.t_lid) / 2 }
      : null;

  function weightedCentroid(components) {
    let vx = 0, vy = 0, vz = 0, vt = 0;
    components.forEach((c) => {
      if (!c || !c.c) return;
      vx += c.v * c.c.x;
      vy += c.v * c.c.y;
      vz += c.v * c.c.z;
      vt += c.v;
    });
    if (vt <= 0) return null;
    return { x: vx / vt, y: vy / vt, z: vz / vt };
  }

  const compsEmpty = [];
  if (V_rect_out > 0) compsEmpty.push({ v: V_rect_out, c: c_rect });
  if (V_hopper_out > 0) compsEmpty.push({ v: V_hopper_out, c: c_hopper });
  if (V_frame_out > 0) compsEmpty.push({ v: V_frame_out, c: c_frame });
  if (state.include_lid && V_lid > 0) compsEmpty.push({ v: V_lid, c: c_lid });

  const cog_empty = weightedCentroid(compsEmpty);

  let cog_dust = null;
  if (V_fill > 0 && V_internal > 0) {
    const z_int = H_in / 2;
    const z_dust = z_int * fillFrac;
    cog_dust = { x: L / 2, y: 0, z: z_dust };
  }

  let cog_filled = null;
  if (cog_empty && cog_dust && m_dust > 0 && m_empty > 0) {
    const M1 = m_empty, M2 = m_dust;
    const xC = (M1 * cog_empty.x + M2 * cog_dust.x) / (M1 + M2);
    const yC = (M1 * cog_empty.y + M2 * cog_dust.y) / (M1 + M2);
    const zC = (M1 * cog_empty.z + M2 * cog_dust.z) / (M1 + M2);
    cog_filled = { x: xC, y: yC, z: zC };
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

function updateOutputs() {
  const r = computeVolumesAndMasses();
  byId("out-v-int").textContent = fmt(r.V_internal, 3);
  byId("out-v-fill").textContent = fmt(r.V_fill, 3);
  byId("out-m-shell").textContent = fmt(r.m_shell, 1);
  byId("out-m-lid").textContent = fmt(r.m_lid, 1);
  byId("out-m-dust").textContent = fmt(r.m_dust, 1);
  byId("out-m-total").textContent = fmt(r.m_total, 1);

  if (r.cog_empty) {
    byId("out-cog-empty").textContent =
      `(${fmt(r.cog_empty.x, 3)}, ${fmt(r.cog_empty.y, 3)}, ${fmt(r.cog_empty.z, 3)})`;
  } else {
    byId("out-cog-empty").textContent = "–";
  }
  if (r.cog_filled) {
    byId("out-cog-filled").textContent =
      `(${fmt(r.cog_filled.x, 3)}, ${fmt(r.cog_filled.y, 3)}, ${fmt(r.cog_filled.z, 3)})`;
  } else {
    byId("out-cog-filled").textContent = "–";
  }

  updateCogMarkers(r);
}

function updateCogMarkers(results) {
  if (!results) results = computeVolumesAndMasses();
  const { cog_empty, cog_filled } = results;

  if (cogEmptyArrow) {
    cogEmptyArrow.visible = !!(state.show_cog_empty && cog_empty);
    if (cog_empty) {
      cogEmptyArrow.position.set(cog_empty.x, cog_empty.y, cog_empty.z);
    }
  }

  if (cogFilledArrow) {
    cogFilledArrow.visible = !!(state.show_cog_filled && cog_filled);
    if (cog_filled) {
      cogFilledArrow.position.set(cog_filled.x, cog_filled.y, cog_filled.z);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Collision (container vs imported STLs)                             */
/* ------------------------------------------------------------------ */

function updateCollisions() {
  if (!containerGroup) return;

  const boxContainer = new THREE.Box3().setFromObject(containerGroup);
  let firstIntersection = null;

  importedObjects.forEach((o) => {
    const box = new THREE.Box3().setFromObject(o.mesh);
    if (boxContainer.intersectsBox(box)) {
      const inter = boxContainer.clone().intersect(box);
      const size = new THREE.Vector3();
      inter.getSize(size);
      if (size.x > 0 && size.y > 0 && size.z > 0 && !firstIntersection) {
        firstIntersection = inter;
      }
    }
  });

  if (firstIntersection) {
    const size = new THREE.Vector3();
    firstIntersection.getSize(size);
    const center = new THREE.Vector3();
    firstIntersection.getCenter(center);
    const volume = size.x * size.y * size.z;

    if (!collisionMarker) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff4b4b,
        transparent: true,
        opacity: 0.35,
      });
      collisionMarker = new THREE.Mesh(geo, mat);
      scene.add(collisionMarker);
    }
    collisionMarker.visible = true;
    collisionMarker.position.copy(center);
    collisionMarker.scale.set(size.x, size.y, size.z);

    const eps = 1e-6;
    if (Math.abs(volume - lastCollisionVolume) > eps) {
      const dxmm = size.x * 1000;
      const dymm = size.y * 1000;
      const dzmm = size.z * 1000;
      const vLit = volume * 1000;
      log(
        `Collision: ~${fmt(dxmm, 1)}×${fmt(dymm, 1)}×${fmt(
          dzmm,
          1
        )} mm, ≈${fmt(vLit, 2)} L overlap`
      );
      lastCollisionVolume = volume;
    }
  } else {
    if (collisionMarker) collisionMarker.visible = false;
    if (lastCollisionVolume > 0) {
      log("Collision cleared.");
      lastCollisionVolume = 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Three.js init, selection & movement                                */
/* ------------------------------------------------------------------ */

function resetCamera() {
  const d = 8;
  const elev = (35 * Math.PI) / 180;
  const az = (45 * Math.PI) / 180;
  const x = d * Math.cos(elev) * Math.cos(az);
  const y = d * Math.cos(elev) * Math.sin(az);
  const z = d * Math.sin(elev);
  camera.position.set(x, y, z);
  camera.lookAt(2, 0, 1);
}

function initThree() {
  const container = byId("renderer-container");
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f4f6);

  const aspect = width / height;
  const camSize = 3;
  camera = new THREE.OrthographicCamera(
    -camSize * aspect,
    camSize * aspect,
    camSize,
    -camSize,
    0.1,
    100
  );
  resetCamera();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  const amb = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(3, 4, 5);
  scene.add(dir);

  const groundSize = 10;
  const slabGeom = new THREE.BoxGeometry(groundSize, 0.1, groundSize);
  const slabMat = new THREE.MeshStandardMaterial({
    color: 0xe5e7eb,
    roughness: 0.9,
  });
  const slab = new THREE.Mesh(slabGeom, slabMat);
  slab.position.set(groundSize / 2 - 0.5, 0, -0.05);
  scene.add(slab);

  const grid = new THREE.GridHelper(groundSize, 20, 0xcbd5f5, 0xe5e7eb);
  grid.position.set(groundSize / 2 - 0.5, 0, 0.001);
  scene.add(grid);

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

  containerGroup = createContainerGroup();
  scene.add(containerGroup);

  cogEmptyArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, 0, 0),
    0.8,
    0x0ea5e9
  );
  cogFilledArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, 0, 0),
    0.8,
    0xf97316
  );
  scene.add(cogEmptyArrow);
  scene.add(cogFilledArrow);
  updateCogMarkers();

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  renderer.domElement.addEventListener("pointerdown", onPointerDown);

  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onKeyDown);

  selectedObject = containerGroup;
  refreshObjectList();
  updateSelectionUi();

  animate();
}

function onResize() {
  if (!renderer || !camera) return;
  const container = byId("renderer-container");
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

function findRoot(obj) {
  let cur = obj;
  while (cur.parent && cur.parent !== scene) {
    if (cur === containerGroup) return containerGroup;
    cur = cur.parent;
  }
  return cur;
}

function onPointerDown(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const objs = [];
  if (containerGroup) objs.push(containerGroup);
  importedObjects.forEach((o) => objs.push(o.mesh));
  const hits = raycaster.intersectObjects(objs, true);
  if (hits.length > 0) {
    const root = findRoot(hits[0].object);
    selectedObject = root;
    updateSelectionUi();
    refreshObjectList();
    log(`Selected: ${root === containerGroup ? "Container" : root.userData.name || "Imported object"}`);
  }
}

function onKeyDown(e) {
  if (!selectedObject) return;
  const key = e.key.toLowerCase();
  if (!["w", "a", "s", "d"].includes(key)) return;
  e.preventDefault();

  const step = mmToM(state.move_step_mm);
  const pos = selectedObject.position.clone();
  if (key === "w") pos.y += step;
  if (key === "s") pos.y -= step;
  if (key === "a") pos.x -= step;
  if (key === "d") pos.x += step;

  if (state.snap_to_grid) {
    const gs = mmToM(100);
    pos.x = Math.round(pos.x / gs) * gs;
    pos.y = Math.round(pos.y / gs) * gs;
  }
  selectedObject.position.copy(pos);
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
  updateCollisions();
}

/* ------------------------------------------------------------------ */
/* Layers / selection UI                                              */
/* ------------------------------------------------------------------ */

function setBaseFace(mesh, mode) {
  const box = new THREE.Box3().setFromObject(mesh);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const minZ = box.min.z;
  const maxZ = box.max.z;
  let baseZ;
  if (mode === "bottom") baseZ = minZ;
  else if (mode === "top") baseZ = maxZ;
  else baseZ = center.z;
  const delta = -baseZ;
  mesh.position.z += delta;
  mesh.userData.baseFace = mode;
}

function refreshObjectList() {
  const list = objectListEl || byId("object-list");
  if (!list) return;
  list.innerHTML = "";

  const makeEntry = (label, obj) => {
    const div = document.createElement("div");
    div.textContent = label;
    div.style.cursor = "pointer";
    div.style.padding = "2px 4px";
    div.style.fontSize = "11px";
    if (selectedObject === obj) {
      div.style.background = "#e5edff";
    }
    div.addEventListener("click", () => {
      selectedObject = obj;
      updateSelectionUi();
      refreshObjectList();
      log(`Selected: ${label} (via list)`);
    });
    list.appendChild(div);
  };

  if (containerGroup) {
    makeEntry("Container", containerGroup);
  }
  importedObjects.forEach((o, idx) => {
    makeEntry(o.name || `Imported ${idx + 1}`, o.mesh);
  });
}

function updateSelectionUi() {
  if (!selectedObject) selectedObject = containerGroup;
  const nameEl = selectedNameEl || byId("selected-object-name");
  const baseSel = baseFaceSelectEl || byId("select-base-face");
  if (!nameEl || !baseSel) return;

  if (selectedObject === containerGroup || !selectedObject) {
    nameEl.textContent = "Container";
    baseSel.disabled = true;
  } else {
    const obj = importedObjects.find((o) => o.mesh === selectedObject);
    nameEl.textContent = obj ? obj.name || "Imported object" : "Object";
    baseSel.disabled = !obj;
    if (obj) {
      baseSel.value = obj.mesh.userData.baseFace || "bottom";
    }
  }
}

/* ------------------------------------------------------------------ */
/* STL import/export                                                  */
/* ------------------------------------------------------------------ */

function importSTL(file) {
  if (!file) return;
  const maxSize = 15 * 1024 * 1024;
  if (file.size > maxSize) {
    const ok = confirm(
      `File is ${(file.size / 1024 / 1024).toFixed(1)} MB – may slow the browser. Continue?`
    );
    if (!ok) return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const geom = loader.parse(e.target.result);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6b7280,
      metalness: 0.1,
      roughness: 0.7,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.geometry.computeBoundingBox();
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    mesh.position.sub(center);
    mesh.position.z += size.z / 2 + 0.01; // stand on ground
    mesh.userData.baseFace = "bottom";
    mesh.userData.name = file.name;

    scene.add(mesh);
    importedObjects.push({ mesh, name: file.name });
    refreshObjectList();
    log(`Imported STL: ${file.name}`);
  };
  reader.readAsArrayBuffer(file);
}

function exportContainer(includeLid) {
  if (!containerGroup) return;
  const grp = new THREE.Group();
  containerGroup.traverse((obj) => {
    if (obj.isMesh) grp.add(obj.clone());
  });
  if (includeLid && lidMesh && !containerGroup.children.includes(lidMesh)) {
    grp.add(lidMesh.clone());
  }

  const box = new THREE.Box3().setFromObject(grp);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const offset = new THREE.Vector3(-center.x, -center.y, -box.min.z);
  grp.position.add(offset);

  const data = exporter.parse(grp, { binary: true });
  const blob = new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `container_${state.L_rect}x${state.W}x${state.H}.stl`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log("Exported container STL.");
}

function exportLid() {
  if (!lidMesh || !state.include_lid) {
    log("Lid not included – nothing to export.");
    return;
  }
  const grp = new THREE.Group();
  grp.add(lidMesh.clone());

  const box = new THREE.Box3().setFromObject(grp);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const offset = new THREE.Vector3(-center.x, -center.y, -box.min.z);
  grp.position.add(offset);

  const data = exporter.parse(grp, { binary: true });
  const blob = new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lid_${state.L_rect}x${state.W}.stl`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log("Exported lid STL.");
}

/* ------------------------------------------------------------------ */
/* Config & source IO                                                 */
/* ------------------------------------------------------------------ */

function exportConfig() {
  const json = JSON.stringify(state, null, 2);
  navigator.clipboard
    .writeText(json)
    .then(() => log("Config JSON copied to clipboard."))
    .catch(() => {
      alert("Could not copy automatically. JSON:\n\n" + json);
    });
}

function importConfig() {
  const text = prompt("Paste JSON config here:");
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    const merged = Object.assign(deepClone(DEFAULTS), parsed);
    commitState(merged, "Imported configuration.");
  } catch {
    alert("Invalid JSON.");
  }
}

async function copyFullSource() {
  try {
    const [htmlResp, jsResp] = await Promise.all([
      fetch(window.location.href),
      fetch("core-app.js"),
    ]);
    const html = await htmlResp.text();
    const js = await jsResp.text();
    const combined =
      "----- HTML START -----\n" +
      html +
      "\n----- HTML END -----\n\n" +
      "----- JS START -----\n" +
      js +
      "\n----- JS END -----\n";
    await navigator.clipboard.writeText(combined);
    log("HTML+JS source copied to clipboard.");
  } catch (e) {
    console.warn(e);
    alert("Failed to copy source automatically (likely CORS). Check console.");
  }
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                          */
/* ------------------------------------------------------------------ */

function hookNumber(id, handler) {
  const el = byId(id);
  if (!el) return;
  el.addEventListener("change", () => {
    const v = parseFloat(el.value);
    if (!Number.isFinite(v)) return;
    handler(v);
  });
}

function hookCheck(id, handler) {
  const el = byId(id);
  if (!el) return;
  el.addEventListener("change", () => handler(el.checked));
}

function bindRangeNumber(rangeId, numberId, key, msg) {
  const rng = byId(rangeId);
  const num = byId(numberId);
  if (!rng || !num) return;

  const apply = (v) => {
    if (!Number.isFinite(v)) return;
    rng.value = v;
    num.value = v;
    const s = deepClone(state);
    s[key] = v;
    commitState(s, msg);
  };

  rng.addEventListener("input", () => {
    const v = parseFloat(rng.value);
    apply(v);
  });
  num.addEventListener("change", () => {
    const v = parseFloat(num.value);
    apply(v);
  });
}

function setupUI() {
  // version labels
  const hv = byId("html-version-label");
  const jv = byId("js-version-label");
  if (hv) hv.textContent = HTML_VERSION;
  if (jv) jv.textContent = JS_VERSION;

  logTextEl = byId("log-text");
  logListEl = byId("log-list");
  selectedNameEl = byId("selected-object-name");
  baseFaceSelectEl = byId("select-base-face");
  objectListEl = byId("object-list");

  // Modal buttons
  byId("btn-error-fix").addEventListener("click", () => {
    if (pendingFixIgnore && pendingFixIgnore.onFix) pendingFixIgnore.onFix();
    closeModal();
  });
  byId("btn-error-ignore").addEventListener("click", () => {
    if (pendingFixIgnore && pendingFixIgnore.onIgnore) pendingFixIgnore.onIgnore();
    closeModal();
  });

  // Log toggle
  const logToggle = byId("log-toggle");
  const logPanel = byId("log-panel");
  if (logToggle && logPanel) {
    logToggle.addEventListener("click", () => {
      logPanel.style.display = logPanel.style.display === "block" ? "none" : "block";
    });
  }

  // geometry: sliders + numbers
  bindRangeNumber("range-l-rect", "input-l-rect", "L_rect", "Changed L_rect.");
  bindRangeNumber("range-x-hopper", "input-x-hopper", "x_hopper", "Changed x_hopper.");
  bindRangeNumber("range-h", "input-h", "H", "Changed H.");
  bindRangeNumber("range-w", "input-w", "W", "Changed W.");
  bindRangeNumber("range-t-wall", "input-t-wall", "t_wall", "Changed t_wall.");

  // frame
  hookCheck("chk-include-frame", (c) => {
    const s = deepClone(state);
    s.include_frame = c;
    commitState(s, "Toggled frame.");
  });
  hookNumber("input-h-frame", (v) => {
    const s = deepClone(state);
    s.H_frame = v;
    commitState(s, "Changed H_frame.");
  });
  hookCheck("chk-unlock-pockets", (c) => {
    const s = deepClone(state);
    s.unlock_pockets = c;
    pocketLockUi(!c);
    commitState(s, "Toggled pocket lock.");
  });
  hookNumber("input-w-pocket", (v) => {
    const s = deepClone(state);
    s.W_pocket = v;
    commitState(s, "Changed pocket width.");
  });
  hookNumber("input-h-pocket", (v) => {
    const s = deepClone(state);
    s.H_pocket = v;
    commitState(s, "Changed pocket height.");
  });
  hookNumber("input-s-pocket", (v) => {
    const s = deepClone(state);
    s.S_pocket = v;
    commitState(s, "Changed pocket spacing.");
  });

  // lid
  hookCheck("chk-include-lid", (c) => {
    const s = deepClone(state);
    s.include_lid = c;
    commitState(s, "Toggled lid.");
  });
  hookNumber("input-t-lid", (v) => {
    const s = deepClone(state);
    s.t_lid = v;
    commitState(s, "Changed lid thickness.");
  });
  hookNumber("input-r-hole", (v) => {
    const s = deepClone(state);
    s.r_hole = v;
    commitState(s, "Changed lid hole radius.");
  });
  hookNumber("input-lid-edge", (v) => {
    const s = deepClone(state);
    s.lid_edge_length = v;
    commitState(s, "Changed lid ring width.");
  });
  hookNumber("input-lid-offset", (v) => {
    const s = deepClone(state);
    s.lid_offset_from_hopper_edge = v;
    commitState(s, "Changed lid hole offset.");
  });
  hookCheck("chk-advanced-lid-mat", (c) => {
    const s = deepClone(state);
    s.advanced_lid_material = c;
    lidMaterialUi(c);
    commitState(s, "Toggled advanced lid material.");
  });
  hookNumber("input-rho-lid", (v) => {
    const s = deepClone(state);
    s.rho_lid = v;
    commitState(s, "Changed lid density.");
  });

  // materials / dust
  const shellSel = byId("select-shell-material");
  if (shellSel) {
    shellSel.addEventListener("change", () => {
      const s = deepClone(state);
      s.shell_material = shellSel.value;
      if (s.shell_material === "steel") s.rho_shell = 7850;
      else if (s.shell_material === "stainless") s.rho_shell = 8000;
      else if (s.shell_material === "aluminum") s.rho_shell = 2700;
      state = s; // update density input before commit
      if (s.shell_material !== "custom") {
        byId("input-rho-shell").disabled = true;
      } else {
        byId("input-rho-shell").disabled = false;
      }
      commitState(s, "Changed shell material.");
    });
  }
  hookNumber("input-rho-shell", (v) => {
    const s = deepClone(state);
    s.rho_shell = v;
    s.shell_material = "custom";
    const sel = byId("select-shell-material");
    if (sel) sel.value = "custom";
    byId("input-rho-shell").disabled = false;
    commitState(s, "Changed shell density.");
  });
  hookNumber("input-rho-dust", (v) => {
    const s = deepClone(state);
    s.rho_dust = v;
    commitState(s, "Changed dust density.");
  });
  hookNumber("input-humidity", (v) => {
    const s = deepClone(state);
    s.humidity = v;
    commitState(s, "Changed humidity (info only).");
  });
  hookNumber("input-fill-perc", (v) => {
    const s = deepClone(state);
    s.fill_percentage = Math.max(0, Math.min(100, v));
    commitState(s, "Changed fill percentage.");
  });

  // view & movement
  hookCheck("chk-snap-grid", (c) => {
    const s = deepClone(state);
    s.snap_to_grid = c;
    commitState(s, "Toggled snap-to-grid.");
  });
  hookNumber("input-move-step", (v) => {
    const s = deepClone(state);
    s.move_step_mm = v;
    commitState(s, "Changed move step.");
  });
  hookCheck("chk-ref-cube", (c) => {
    const s = deepClone(state);
    s.show_reference_cube = c;
    commitState(s, "Toggled reference cube.");
  });
  hookCheck("chk-show-cog-empty", (c) => {
    const s = deepClone(state);
    s.show_cog_empty = c;
    commitState(s, "Toggled CoG empty.");
  });
  hookCheck("chk-show-cog-filled", (c) => {
    const s = deepClone(state);
    s.show_cog_filled = c;
    commitState(s, "Toggled CoG filled.");
  });

  const resetViewBtn = byId("btn-reset-view");
  if (resetViewBtn) {
    resetViewBtn.addEventListener("click", () => {
      resetCamera();
      log("Reset view to isometric.");
    });
  }

  // layers: base face selector
  if (baseFaceSelectEl) {
    baseFaceSelectEl.addEventListener("change", () => {
      if (!selectedObject) return;
      const obj = importedObjects.find((o) => o.mesh === selectedObject);
      if (!obj) return;
      setBaseFace(obj.mesh, baseFaceSelectEl.value);
    });
  }

  // advanced & IO
  byId("btn-export-config").addEventListener("click", exportConfig);
  byId("btn-import-config").addEventListener("click", importConfig);
  byId("btn-export-container").addEventListener("click", () =>
    exportContainer(state.export_lid_with_container)
  );
  byId("btn-export-lid").addEventListener("click", exportLid);
  hookCheck("chk-export-lid-with-container", (c) => {
    const s = deepClone(state);
    s.export_lid_with_container = c;
    commitState(s, "Toggled include lid in container STL.");
  });

  const importStlInput = byId("input-import-stl");
  if (importStlInput) {
    importStlInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) importSTL(file);
      importStlInput.value = "";
    });
  }
  byId("btn-copy-source").addEventListener("click", copyFullSource);

  byId("btn-reset-defaults").addEventListener("click", () => {
    if (!confirm("Reset all parameters to defaults and clear stored config?")) return;
    state = deepClone(DEFAULTS);
    lastValidState = deepClone(DEFAULTS);
    undoStack.length = 0;
    redoStack.length = 0;
    applyStateToInputs();
    rebuildGeometry();
    updateOutputs();
    saveState();
    updateUndoButtons();
    log("Reset to defaults.");
  });

  byId("btn-undo").addEventListener("click", undo);
  byId("btn-redo").addEventListener("click", redo);
  updateUndoButtons();
}

/* ------------------------------------------------------------------ */
/* Kickoff                                                            */
/* ------------------------------------------------------------------ */

window.addEventListener("DOMContentLoaded", () => {
  loadState();
  applyStateToInputs();
  setupUI();
  initThree();
  updateOutputs();
  log("Application ready. Adjust parameters or import STLs to begin.");
});
