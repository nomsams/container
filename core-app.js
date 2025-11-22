// core-app.js – Dust Container Designer PRO
// Uses import map from index.html:
//   "three": "https://unpkg.com/three@0.160.0/build/three.module.js"
//   "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";

/* ------------------------------------------------------------------ */
/* Configuration & state                                              */
/* ------------------------------------------------------------------ */

const APP_VERSION = "3.1.0";

const DEFAULTS = {
  L: 1400,
  W: 1300,
  H: 900,
  x_hopper: 700,
  t_wall: 5,

  frame_h: 100,
  frame_pocket_w: 230,
  frame_pocket_h: 91,
  frame_pocket_s: 142,
  include_frame: true,

  include_lid: false,
  t_lid: 3,
  r_hole: 150,
  lid_offset: 300,
  advanced_lid_material: false,

  rho_shell: 7850,
  rho_dust: 1850,
  rho_lid: 7850,
  fill_percent: 80,

  move_step: 50,
  snap: true,
  show_collisions: true,
  show_cog_e: false,
  show_cog_f: true,
};

let params = { ...DEFAULTS };

let historyStack = [];
let historyIndex = -1;
let isUndoRedo = false;

/* Three.js globals */
let scene, camera, renderer, controls, gridHelper;
let containerGroup, lidMesh, dustMesh, frameGroup;
let importedObjects = [];
let collisionBoxes = [];
let selectedObject = null;
let refCube, cogArrowEmpty, cogArrowFilled;
const localCoG_E = new THREE.Vector3();
const localCoG_F = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* Init                                                               */
/* ------------------------------------------------------------------ */

function init() {
  loadState();
  initThreeJS();
  setupUI();
  updateUIFromParams();
  rebuildContainer();
  pushHistory();
  animate();
  log(`Dust Container Designer v${APP_VERSION} started.`);
}

/* ------------------------------------------------------------------ */
/* Three.js setup                                                     */
/* ------------------------------------------------------------------ */

function initThreeJS() {
  const container = document.getElementById("main-view");

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb0b0b0); // concrete grey

  const aspect = container.clientWidth / container.clientHeight;
  const d = 3000;
  camera = new THREE.OrthographicCamera(
    -d * aspect,
    d * aspect,
    d,
    -d,
    -5000,
    10000
  );
  resetCameraView();

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI;

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(2000, 4000, 2000);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 10000;
  const dLight = 3000;
  dirLight.shadow.camera.left = -dLight;
  dirLight.shadow.camera.right = dLight;
  dirLight.shadow.camera.top = dLight;
  dirLight.shadow.camera.bottom = -dLight;
  scene.add(dirLight);

  // Ground grid (XZ plane, Habbo-like)
  gridHelper = new THREE.GridHelper(10000, 100, 0x555555, 0x888888);
  scene.add(gridHelper);

  // Reference cube (1 m³ wireframe)
  const geomRef = new THREE.BoxGeometry(1000, 1000, 1000);
  const matRef = new THREE.MeshBasicMaterial({
    color: 0xe74c3c,
    wireframe: true,
    transparent: true,
    opacity: 0.5,
  });
  refCube = new THREE.Mesh(geomRef, matRef);
  refCube.position.set(2000, 500, 2000);
  refCube.visible = false;
  scene.add(refCube);

  // CoG arrows
  const headLen = 200;
  const headW = 100;
  cogArrowEmpty = new THREE.ArrowHelper(
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 0),
    1000,
    0x2980b9,
    headLen,
    headW
  );
  cogArrowFilled = new THREE.ArrowHelper(
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 0),
    1000,
    0xc0392b,
    headLen,
    headW
  );
  scene.add(cogArrowEmpty);
  scene.add(cogArrowFilled);

  window.addEventListener("resize", onWindowResize);
  document.addEventListener("keydown", onKeyDown);
  renderer.domElement.addEventListener("mousedown", onCanvasClick);
}

function resetCameraView() {
  camera.position.set(3000, 3000, 3000);
  camera.lookAt(0, 0, 0);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
}

/* ------------------------------------------------------------------ */
/* Geometry / container                                               */
/* ------------------------------------------------------------------ */

function rebuildContainer() {
  if (containerGroup) scene.remove(containerGroup);

  containerGroup = new THREE.Group();
  containerGroup.name = "Container";

  const matShell = new THREE.MeshStandardMaterial({
    color: 0x34495e,
    roughness: 0.6,
    metalness: 0.3,
    side: THREE.DoubleSide,
  });
  const matFrame = new THREE.MeshStandardMaterial({
    color: 0x27ae60,
    roughness: 0.7,
    metalness: 0.1,
  });
  const matLid = new THREE.MeshStandardMaterial({
    color: 0x95a5a6,
    roughness: 0.5,
  });
  const matDust = new THREE.MeshBasicMaterial({
    color: 0x8d6e63,
    transparent: true,
    opacity: 0.7,
  });

  const { L, W, H, x_hopper, t_wall, frame_h, include_frame } = params;
  const y_offset = include_frame ? frame_h : 0;

  // Floor
  const floorGeo = new THREE.BoxGeometry(L, t_wall, W);
  const floor = new THREE.Mesh(floorGeo, matShell);
  floor.position.set(L / 2, y_offset + t_wall / 2, 0);
  floor.castShadow = true;
  floor.receiveShadow = true;
  containerGroup.add(floor);
  addEdge(floor);

  // Side walls by extruding side profile
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(L, 0);
  if (x_hopper > 1) {
    shape.lineTo(L + x_hopper, H);
    shape.lineTo(0, H);
  } else {
    shape.lineTo(L, H);
    shape.lineTo(0, H);
  }
  shape.lineTo(0, 0);

  const wallGeo = new THREE.ExtrudeGeometry(shape, {
    depth: t_wall,
    bevelEnabled: false,
  });

  const wallLeft = new THREE.Mesh(wallGeo, matShell);
  wallLeft.position.set(0, y_offset, W / 2 - t_wall);
  wallLeft.castShadow = true;
  wallLeft.receiveShadow = true;
  containerGroup.add(wallLeft);
  addEdge(wallLeft);

  const wallRight = new THREE.Mesh(wallGeo, matShell);
  wallRight.position.set(0, y_offset, -W / 2);
  wallRight.castShadow = true;
  wallRight.receiveShadow = true;
  containerGroup.add(wallRight);
  addEdge(wallRight);

  // Front wall (slanted if hopper)
  if (x_hopper > 1) {
    const slantLen = Math.sqrt(x_hopper ** 2 + H ** 2);
    const angle = Math.atan2(H, x_hopper);
    const fwGeo = new THREE.BoxGeometry(slantLen, W - 2 * t_wall, t_wall);
    const fw = new THREE.Mesh(fwGeo, matShell);
    const midX = L + x_hopper / 2;
    const midY = H / 2;
    fw.position.set(midX, y_offset + midY, 0);
    fw.rotation.x = Math.PI / 2;
    fw.rotation.y = -angle;
    fw.castShadow = true;
    fw.receiveShadow = true;
    containerGroup.add(fw);
    addEdge(fw);
  } else {
    const fw = new THREE.Mesh(
      new THREE.BoxGeometry(t_wall, H, W - 2 * t_wall),
      matShell
    );
    fw.position.set(L - t_wall / 2, y_offset + H / 2, 0);
    fw.castShadow = true;
    fw.receiveShadow = true;
    containerGroup.add(fw);
    addEdge(fw);
  }

  // Back wall
  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(t_wall, H, W - 2 * t_wall),
    matShell
  );
  backWall.position.set(t_wall / 2, y_offset + H / 2, 0);
  backWall.castShadow = true;
  backWall.receiveShadow = true;
  containerGroup.add(backWall);
  addEdge(backWall);

  // Forklift frame (green)
  frameGroup = null;
  if (include_frame) {
    frameGroup = new THREE.Group();
    const wp = params.frame_pocket_w;
    const sp = params.frame_pocket_s;
    const groupW = 2 * wp + sp;
    const margin = (W - groupW) / 2;
    const yFrame = frame_h / 2;

    const beamOuterGeo = new THREE.BoxGeometry(L, frame_h, margin);
    const beamCenterGeo = new THREE.BoxGeometry(L, frame_h, sp);

    const beamL = new THREE.Mesh(beamOuterGeo, matFrame);
    beamL.position.set(L / 2, yFrame, W / 2 - margin / 2);
    beamL.castShadow = true;
    frameGroup.add(beamL);
    addEdge(beamL);

    const beamR = new THREE.Mesh(beamOuterGeo, matFrame);
    beamR.position.set(L / 2, yFrame, -W / 2 + margin / 2);
    beamR.castShadow = true;
    frameGroup.add(beamR);
    addEdge(beamR);

    const beamC = new THREE.Mesh(beamCenterGeo, matFrame);
    beamC.position.set(L / 2, yFrame, 0);
    beamC.castShadow = true;
    frameGroup.add(beamC);
    addEdge(beamC);

    const plateT = 5;
    const topPlate = new THREE.Mesh(
      new THREE.BoxGeometry(L, plateT, W),
      matFrame
    );
    topPlate.position.set(L / 2, frame_h - plateT / 2, 0);
    frameGroup.add(topPlate);

    const botPlate = new THREE.Mesh(
      new THREE.BoxGeometry(L, plateT, W),
      matFrame
    );
    botPlate.position.set(L / 2, plateT / 2, 0);
    frameGroup.add(botPlate);

    containerGroup.add(frameGroup);
  }

  // Lid
  lidMesh = null;
  if (params.include_lid) {
    const lidShape = new THREE.Shape();
    lidShape.moveTo(0, -W / 2);
    lidShape.lineTo(L + x_hopper, -W / 2);
    lidShape.lineTo(L + x_hopper, W / 2);
    lidShape.lineTo(0, W / 2);
    lidShape.lineTo(0, -W / 2);

    const cx = L + x_hopper - params.lid_offset;
    const holePath = new THREE.Path();
    holePath.absarc(cx, 0, params.r_hole, 0, Math.PI * 2, true);
    lidShape.holes.push(holePath);

    const lidGeo = new THREE.ExtrudeGeometry(lidShape, {
      depth: params.t_lid,
      bevelEnabled: false,
    });
    lidMesh = new THREE.Mesh(lidGeo, matLid);
    lidMesh.rotation.x = Math.PI / 2;
    lidMesh.position.set(0, y_offset + H + params.t_lid, 0);
    lidMesh.castShadow = true;
    containerGroup.add(lidMesh);
    addEdge(lidMesh);
  }

  // Dust fill (simplified as a box in rectangular section)
  dustMesh = null;
  const fillH = H * (params.fill_percent / 100);
  if (fillH > 0) {
    const dustGeo = new THREE.BoxGeometry(L - 2 * t_wall, fillH, W - 2 * t_wall);
    dustMesh = new THREE.Mesh(dustGeo, matDust);
    dustMesh.position.set(L / 2, y_offset + fillH / 2 + t_wall, 0);
    containerGroup.add(dustMesh);
  }

  scene.add(containerGroup);

  if (
    !selectedObject ||
    (selectedObject.parent !== scene && selectedObject !== containerGroup)
  ) {
    selectedObject = containerGroup;
  }

  calculatePhysics();
  updateLayerList();
}

/* Wireframe edges for visual clarity */
function addEdge(mesh) {
  const edges = new THREE.EdgesGeometry(mesh.geometry);
  const line = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({
      color: 0x000000,
      opacity: 0.3,
      transparent: true,
    })
  );
  mesh.add(line);
}

/* ------------------------------------------------------------------ */
/* Physics: volumes, masses, CoG                                      */
/* ------------------------------------------------------------------ */

function calculatePhysics() {
  const L_m = params.L / 1000;
  const W_m = params.W / 1000;
  const H_m = params.H / 1000;
  const xHop_m = params.x_hopper / 1000;
  const t_m = params.t_wall / 1000;
  const frameH_m = params.include_frame ? params.frame_h / 1000 : 0;

  const V_rect_int = Math.max(
    0,
    (L_m - 2 * t_m) * (W_m - 2 * t_m) * (H_m - t_m)
  );
  const V_wedge_int = Math.max(
    0,
    0.5 * xHop_m * (H_m - t_m) * (W_m - 2 * t_m)
  );
  const V_total = Math.max(0, V_rect_int + V_wedge_int);
  const V_fill = V_total * (params.fill_percent / 100);

  const V_rect_out = L_m * W_m * H_m;
  const V_wedge_out = 0.5 * xHop_m * H_m * W_m;
  const V_shell_vol = Math.max(0, V_rect_out + V_wedge_out - V_total);

  let V_frame = 0;
  if (params.include_frame) {
    V_frame = L_m * W_m * frameH_m * 0.4; // approximate solid fraction
  }

  const m_shell_only = (V_shell_vol + V_frame) * params.rho_shell;
  let m_lid = 0;
  if (params.include_lid) {
    const r_m = params.r_hole / 1000;
    const t_lid_m = params.t_lid / 1000;
    const area_lid = (L_m + xHop_m) * W_m - Math.PI * r_m * r_m;
    const rho =
      params.advanced_lid_material
        ? parseFloat(document.getElementById("num-RhoLid").value || "7850")
        : params.rho_shell;
    m_lid = Math.max(0, area_lid * t_lid_m * rho);
  }

  const m_empty = m_shell_only + m_lid;
  const m_dust = V_fill * params.rho_dust;
  const m_total = m_empty + m_dust;

  // CoG approx
  const m_frame = V_frame * params.rho_shell;
  const m_shell_no_frame = V_shell_vol * params.rho_shell;

  const y_frame = frameH_m / 2;
  const x_frame = L_m / 2;
  const y_shell = frameH_m + H_m / 3;
  const x_shell = L_m / 2 + xHop_m / 5;

  const y_lid = frameH_m + H_m + (params.t_lid / 1000);

  const sumM_empty = m_frame + m_shell_no_frame + m_lid;
  let cogY_e = 0;
  let cogX_e = 0;
  if (sumM_empty > 0) {
    cogY_e =
      (m_frame * y_frame +
        m_shell_no_frame * y_shell +
        m_lid * y_lid) /
      sumM_empty;
    cogX_e =
      (m_frame * x_frame +
        m_shell_no_frame * x_shell +
        m_lid * x_shell) /
      sumM_empty;
  }

  const y_dust =
    frameH_m + (H_m * (params.fill_percent / 100)) / 2 + t_m / 2;
  const x_dust = L_m / 2;

  let cogY_f = cogY_e;
  let cogX_f = cogX_e;
  if (m_dust > 0 && m_empty > 0) {
    cogY_f = (m_empty * cogY_e + m_dust * y_dust) / (m_empty + m_dust);
    cogX_f = (m_empty * cogX_e + m_dust * x_dust) / (m_empty + m_dust);
  }

  localCoG_E.set(cogX_e * 1000, cogY_e * 1000, 0);
  localCoG_F.set(cogX_f * 1000, cogY_f * 1000, 0);

  document.getElementById("val-vol-int").innerText =
    V_total.toFixed(3) + " m³";
  document.getElementById("val-vol-fill").innerText =
    V_fill.toFixed(3) + " m³";
  document.getElementById("val-mass-shell").innerText =
    (m_shell_only + m_lid).toFixed(1) + " kg";
  document.getElementById("val-mass-dust").innerText =
    m_dust.toFixed(1) + " kg";
  document.getElementById("val-mass-total").innerText =
    m_total.toFixed(1) + " kg";

  document.getElementById(
    "val-cog-empty"
  ).innerText = `X:${cogX_e.toFixed(2)}, Y:${cogY_e.toFixed(2)}`;
  document.getElementById(
    "val-cog-filled"
  ).innerText = `X:${cogX_f.toFixed(2)}, Y:${cogY_f.toFixed(2)}`;
}

function updateCoGArrows() {
  if (!containerGroup) return;

  cogArrowEmpty.visible = params.show_cog_e;
  cogArrowFilled.visible = params.show_cog_f;

  const worldPosE = containerGroup.position.clone().add(localCoG_E);
  const worldPosF = containerGroup.position.clone().add(localCoG_F);

  cogArrowEmpty.position.copy(worldPosE);
  cogArrowFilled.position.copy(worldPosF);
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                          */
/* ------------------------------------------------------------------ */

function setupUI() {
  const bind = (idRange, idNum, key, cb) => {
    const r = document.getElementById(idRange);
    const n = document.getElementById(idNum);
    const update = (val) => {
      const v = parseFloat(val);
      if (!Number.isFinite(v)) return;
      params[key] = v;
      if (r) r.value = v;
      if (n) n.value = v;
      cb();
    };
    if (r) {
      r.addEventListener("input", () => update(r.value));
      r.addEventListener("change", pushHistory);
    }
    if (n) {
      n.addEventListener("change", () => {
        update(n.value);
        pushHistory();
      });
    }
  };

  bind("inp-L", "num-L", "L", rebuildContainer);
  bind("inp-W", "num-W", "W", rebuildContainer);
  bind("inp-H", "num-H", "H", rebuildContainer);
  bind("inp-XHop", "num-XHop", "x_hopper", rebuildContainer);
  bind("inp-Thick", "num-Thick", "t_wall", rebuildContainer);

  document.getElementById("chk-frame").addEventListener("change", (e) => {
    params.include_frame = e.target.checked;
    rebuildContainer();
    pushHistory();
  });
  document.getElementById("num-HFrame").addEventListener("change", (e) => {
    params.frame_h = parseFloat(e.target.value) || params.frame_h;
    rebuildContainer();
    pushHistory();
  });

  document
    .getElementById("unlock-pocket")
    .addEventListener("change", (e) => {
      const d = !e.target.checked;
      document.getElementById("num-WPocket").disabled = d;
      document.getElementById("num-HPocket").disabled = d;
      document.getElementById("num-SPocket").disabled = d;
    });

  document.getElementById("chk-lid").addEventListener("change", (e) => {
    params.include_lid = e.target.checked;
    rebuildContainer();
    pushHistory();
  });
  document.getElementById("num-TLid").addEventListener("change", (e) => {
    params.t_lid = parseFloat(e.target.value) || params.t_lid;
    rebuildContainer();
    pushHistory();
  });
  document.getElementById("num-RHole").addEventListener("change", (e) => {
    params.r_hole = parseFloat(e.target.value) || params.r_hole;
    rebuildContainer();
    pushHistory();
  });
  document
    .getElementById("num-LidOffset")
    .addEventListener("change", (e) => {
      params.lid_offset = parseFloat(e.target.value) || params.lid_offset;
      rebuildContainer();
      pushHistory();
    });

  document.getElementById("chk-lid-adv").addEventListener("change", (e) => {
    params.advanced_lid_material = e.target.checked;
    document.getElementById("row-lid-dens").style.display = e.target.checked
      ? "flex"
      : "none";
    calculatePhysics();
  });
  document.getElementById("num-RhoLid").addEventListener("change", () => {
    calculatePhysics();
  });

  document.getElementById("sel-mat").addEventListener("change", (e) => {
    if (e.target.value !== "custom") {
      params.rho_shell = parseFloat(e.target.value);
    }
    calculatePhysics();
    pushHistory();
  });

  document.getElementById("num-RhoDust").addEventListener("change", (e) => {
    params.rho_dust = parseFloat(e.target.value) || params.rho_dust;
    calculatePhysics();
    pushHistory();
  });

  document.getElementById("inp-Fill").addEventListener("input", (e) => {
    params.fill_percent = parseFloat(e.target.value);
    document.getElementById("lbl-Fill").innerText =
      params.fill_percent + "%";
    rebuildContainer();
  });
  document.getElementById("inp-Fill").addEventListener("change", pushHistory);

  document.getElementById("num-Step").addEventListener("change", (e) => {
    params.move_step = parseFloat(e.target.value) || params.move_step;
  });
  document.getElementById("chk-snap").addEventListener("change", (e) => {
    params.snap = e.target.checked;
  });
  document.getElementById("chk-ref").addEventListener("change", (e) => {
    refCube.visible = e.target.checked;
  });
  document.getElementById("chk-cog-e").addEventListener("change", (e) => {
    params.show_cog_e = e.target.checked;
  });
  document.getElementById("chk-cog-f").addEventListener("change", (e) => {
    params.show_cog_f = e.target.checked;
  });
  document.getElementById("chk-col").addEventListener("change", (e) => {
    params.show_collisions = e.target.checked;
    checkCollisions();
  });

  document
    .getElementById("btn-reset-view")
    .addEventListener("click", resetCameraView);

  document
    .getElementById("btn-export-stl")
    .addEventListener("click", exportContainerSTL);
  document
    .getElementById("btn-export-lid")
    .addEventListener("click", exportLidSTL);
  document
    .getElementById("btn-copy-source")
    .addEventListener("click", copySource);
  document.getElementById("btn-reset").addEventListener("click", () => {
    localStorage.removeItem("dustContainerConfigV3");
    location.reload();
  });

  document
    .getElementById("btn-import")
    .addEventListener("click", () =>
      document.getElementById("file-input").click()
    );
  document
    .getElementById("file-input")
    .addEventListener("change", handleFileSelect);

  document.getElementById("log-header").addEventListener("click", toggleLog);

  document.getElementById("btn-undo").addEventListener("click", undo);
  document.getElementById("btn-redo").addEventListener("click", redo);

  // Collapsibles
  const coll = document.getElementsByClassName("collapsible");
  for (let i = 0; i < coll.length; i++) {
    coll[i].addEventListener("click", function () {
      this.classList.toggle("active");
      const content = this.nextElementSibling;
      if (content.style.maxHeight) {
        content.style.maxHeight = null;
      } else {
        content.style.maxHeight = content.scrollHeight + "px";
      }
    });
  }
}

/* sync UI widgets from params (also used for undo/redo/load) */
function updateUIFromParams() {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  const check = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = val;
  };

  set("inp-L", params.L);
  set("num-L", params.L);
  set("inp-W", params.W);
  set("num-W", params.W);
  set("inp-H", params.H);
  set("num-H", params.H);
  set("inp-XHop", params.x_hopper);
  set("num-XHop", params.x_hopper);
  set("inp-Thick", params.t_wall);
  set("num-Thick", params.t_wall);

  check("chk-frame", params.include_frame);
  set("num-HFrame", params.frame_h);

  check("chk-lid", params.include_lid);
  set("num-TLid", params.t_lid);
  set("num-RHole", params.r_hole);
  set("num-LidOffset", params.lid_offset);
  check("chk-lid-adv", params.advanced_lid_material);
  document.getElementById("row-lid-dens").style.display =
    params.advanced_lid_material ? "flex" : "none";
  set("num-RhoLid", params.rho_lid);

  set("num-RhoDust", params.rho_dust);
  set("inp-Fill", params.fill_percent);
  const lblFill = document.getElementById("lbl-Fill");
  if (lblFill) lblFill.innerText = params.fill_percent + "%";

  set("num-Step", params.move_step);
  check("chk-snap", params.snap);
  check("chk-ref", refCube && refCube.visible);
  check("chk-cog-e", params.show_cog_e);
  check("chk-cog-f", params.show_cog_f);
  check("chk-col", params.show_collisions);

  const selMat = document.getElementById("sel-mat");
  if (selMat) {
    if (params.rho_shell === 7850) selMat.value = "7850";
    else if (params.rho_shell === 2700) selMat.value = "2700";
    else selMat.value = "custom";
  }
}

/* ------------------------------------------------------------------ */
/* Keyboard / mouse interaction                                      */
/* ------------------------------------------------------------------ */

function onKeyDown(event) {
  if (!selectedObject) return;
  const step = params.move_step;
  const snapStep = params.snap ? 100 : 1;

  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  camDir.y = 0;
  camDir.normalize();

  let forward = new THREE.Vector3(0, 0, -1);
  if (Math.abs(camDir.x) > Math.abs(camDir.z)) {
    forward.set(Math.sign(camDir.x), 0, 0);
  } else {
    forward.set(0, 0, Math.sign(camDir.z));
  }

  const right = new THREE.Vector3().crossVectors(
    new THREE.Vector3(0, 1, 0),
    forward
  );

  let move = new THREE.Vector3();

  switch (event.key.toLowerCase()) {
    case "w":
      move.copy(forward).multiplyScalar(step);
      break;
    case "s":
      move.copy(forward).multiplyScalar(-step);
      break;
    case "a":
      move.copy(right).multiplyScalar(-step);
      break;
    case "d":
      move.copy(right).multiplyScalar(step);
      break;
    default:
      return;
  }

  selectedObject.position.add(move);
  if (params.snap) {
    selectedObject.position.x =
      Math.round(selectedObject.position.x / snapStep) * snapStep;
    selectedObject.position.z =
      Math.round(selectedObject.position.z / snapStep) * snapStep;
  }
  checkCollisions();
}

function onCanvasClick(event) {
  const mouse = new THREE.Vector2();
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(scene.children, true);

  if (intersects.length > 0) {
    let obj = intersects[0].object;
    while (obj.parent && obj.parent !== scene) obj = obj.parent;
    if (
      obj !== gridHelper &&
      obj !== refCube &&
      obj !== cogArrowEmpty &&
      obj !== cogArrowFilled &&
      !obj.isCollisionBox
    ) {
      selectedObject = obj;
      log("Selected: " + (obj.name || "Object"));
      updateLayerList();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Collision detection                                                */
/* ------------------------------------------------------------------ */

function checkCollisions() {
  collisionBoxes.forEach((b) => scene.remove(b));
  collisionBoxes = [];
  document.getElementById("collision-alert").style.display = "none";

  if (!containerGroup || !params.show_collisions) return;

  const box1 = new THREE.Box3().setFromObject(containerGroup);

  importedObjects.forEach((obj) => {
    const box2 = new THREE.Box3().setFromObject(obj);
    if (box1.intersectsBox(box2)) {
      const intersection = box1.clone().intersect(box2);
      const dx = intersection.max.x - intersection.min.x;
      const dy = intersection.max.y - intersection.min.y;
      const dz = intersection.max.z - intersection.min.z;
      if (dx <= 0 || dy <= 0 || dz <= 0) return;

      const volLitres = (dx * dy * dz) / 1_000_000; // mm³ -> L

      log(`Collision detected! Vol: ${volLitres.toFixed(2)} L`);

      const w = dx,
        h = dy,
        d = dz;
      const cx = (intersection.min.x + intersection.max.x) / 2;
      const cy = (intersection.min.y + intersection.max.y) / 2;
      const cz = (intersection.min.z + intersection.max.z) / 2;

      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshBasicMaterial({
          color: 0xe74c3c,
          transparent: true,
          opacity: 0.5,
        })
      );
      mesh.position.set(cx, cy, cz);
      mesh.isCollisionBox = true;
      scene.add(mesh);
      collisionBoxes.push(mesh);

      document.getElementById("val-col-vol").innerText =
        volLitres.toFixed(1) + " L";
      document.getElementById("collision-alert").style.display = "flex";
    }
  });
}

/* ------------------------------------------------------------------ */
/* STL import/export                                                  */
/* ------------------------------------------------------------------ */

function handleFileSelect(evt) {
  const file = evt.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const loader = new STLLoader();
      const geometry = loader.parse(e.target.result);
      geometry.center();
      geometry.computeBoundingBox();
      const h = geometry.boundingBox.min.y;
      geometry.translate(0, -h, 0);

      const material = new THREE.MeshStandardMaterial({ color: 0x95a5a6 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = file.name;
      mesh.rotation.x = -Math.PI / 2;
      mesh.castShadow = true;

      scene.add(mesh);
      importedObjects.push(mesh);
      updateLayerList();
      log("Imported: " + file.name);
    } catch (err) {
      log("Error importing STL: " + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function exportContainerSTL() {
  if (!containerGroup) return;
  const exporter = new STLExporter();

  const dustVis = dustMesh ? dustMesh.visible : false;
  if (dustMesh) dustMesh.visible = false;

  const result = exporter.parse(containerGroup);
  saveString(result, "container_design.stl");

  if (dustMesh) dustMesh.visible = dustVis;
  log("Exported Container STL");
}

function exportLidSTL() {
  if (!lidMesh) {
    alert("No lid generated");
    return;
  }
  const exporter = new STLExporter();
  const result = exporter.parse(lidMesh);
  saveString(result, "lid_design.stl");
  log("Exported Lid STL");
}

function saveString(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

/* copy whole HTML document source (quick & dirty) */
function copySource() {
  const html = document.documentElement.outerHTML;
  navigator.clipboard
    .writeText(html)
    .then(() => alert("Source copied!"))
    .catch(() => alert("Copy failed (clipboard permissions)."));
}

/* ------------------------------------------------------------------ */
/* Undo / redo & state persistence                                   */
/* ------------------------------------------------------------------ */

function pushHistory() {
  if (isUndoRedo) return;
  if (historyIndex < historyStack.length - 1) {
    historyStack = historyStack.slice(0, historyIndex + 1);
  }
  historyStack.push(JSON.stringify(params));
  historyIndex++;
  if (historyStack.length > 20) {
    historyStack.shift();
    historyIndex--;
  }
}

function undo() {
  if (historyIndex > 0) {
    historyIndex--;
    isUndoRedo = true;
    params = JSON.parse(historyStack[historyIndex]);
    updateUIFromParams();
    rebuildContainer();
    isUndoRedo = false;
    log("Undo performed");
  }
}

function redo() {
  if (historyIndex < historyStack.length - 1) {
    historyIndex++;
    isUndoRedo = true;
    params = JSON.parse(historyStack[historyIndex]);
    updateUIFromParams();
    rebuildContainer();
    isUndoRedo = false;
    log("Redo performed");
  }
}

function updateLayerList() {
  const list = document.getElementById("layer-list");
  list.innerHTML = "";
  const items = [containerGroup, ...importedObjects];
  items.forEach((obj) => {
    if (!obj) return;
    const div = document.createElement("div");
    div.className =
      "layer-item" + (selectedObject === obj ? " selected" : "");

    const nameSpan = document.createElement("span");
    nameSpan.innerText = obj.name || "Object";
    div.appendChild(nameSpan);

    const actions = document.createElement("div");
    actions.className = "layer-actions";

    const rotBtn = document.createElement("span");
    rotBtn.className = "layer-icon";
    rotBtn.innerText = "↻";
    rotBtn.title = "Rotate 90° around X";
    rotBtn.onclick = (e) => {
      e.stopPropagation();
      obj.rotation.x += Math.PI / 2;
      checkCollisions();
    };
    actions.appendChild(rotBtn);

    div.appendChild(actions);
    div.addEventListener("click", () => {
      selectedObject = obj;
      updateLayerList();
    });
    list.appendChild(div);
  });
}

/* ------------------------------------------------------------------ */
/* Logging & small utils                                              */
/* ------------------------------------------------------------------ */

function log(msg) {
  const el = document.getElementById("log-content");
  const time = new Date().toLocaleTimeString();
  el.innerText = `[${time}] ${msg}\n` + el.innerText;
}

function toggleLog() {
  document.getElementById("log-panel").classList.toggle("log-expanded");
}

function saveState() {
  try {
    localStorage.setItem("dustContainerConfigV3", JSON.stringify(params));
  } catch {
    // ignore
  }
}

function loadState() {
  const s = localStorage.getItem("dustContainerConfigV3");
  if (s) {
    try {
      const p = JSON.parse(s);
      params = { ...DEFAULTS, ...p };
    } catch (e) {
      console.error("Load failed", e);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Resize + animation loop                                            */
/* ------------------------------------------------------------------ */

function onWindowResize() {
  if (!renderer || !camera) return;
  const container = document.getElementById("main-view");
  const aspect = container.clientWidth / container.clientHeight || 1;
  const d = 3000;
  camera.left = -d * aspect;
  camera.right = d * aspect;
  camera.top = d;
  camera.bottom = -d;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateCoGArrows();
  renderer.render(scene, camera);
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                          */
/* ------------------------------------------------------------------ */

window.addEventListener("DOMContentLoaded", () => {
  init();
  setInterval(saveState, 5000);
});
