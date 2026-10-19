import * as THREE from '/vendor/three/three.module.js';

const PRIORITY_COLORS = { 1: 0x38bdf8, 2: 0xfbbf24, 3: 0xff5c8a };
const DONE_COLOR = 0x34d399;
const CORE_IDLE = new THREE.Color(0x6d5dfc);
const CORE_DONE = new THREE.Color(0x34d399);

const RINGS = {
  active: { radius: 4.8, tilt: 0.38, speed: 0.12 },
  done: { radius: 2.9, tilt: 0.75, speed: -0.2 },
};

const TAU = Math.PI * 2;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));

function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRing(radius, tilt, color) {
  const points = [];
  for (let i = 0; i <= 256; i++) {
    const a = (i / 256) * TAU;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 })
  );
  line.rotation.x = tilt;
  return line;
}

function makeStars(count) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = [new THREE.Color(0xffffff), new THREE.Color(0xc4b5fd), new THREE.Color(0x67e8f9)];
  for (let i = 0; i < count; i++) {
    const r = 25 + Math.random() * 60;
    const theta = Math.random() * TAU;
    const phi = Math.acos(2 * Math.random() - 1);
    positions.set(
      [r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi)],
      i * 3
    );
    const c = palette[(Math.random() * palette.length) | 0];
    colors.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 0.18,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
}

function makeDust(count) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 2 + Math.random() * 9;
    const a = Math.random() * TAU;
    positions.set([Math.cos(a) * r, (Math.random() - 0.5) * 3, Math.sin(a) * r], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 0.05,
      color: 0xb4a8ff,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
}

/**
 * Creates the 3D orbit scene. Each todo is rendered as a glowing orb:
 * active todos orbit on the outer ring, completed ones on the inner ring.
 */
export function createScene(canvas, { onSelect, onHover } = {}) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = reduceMotion ? 0.15 : 1;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('WebGL unavailable, 3D scene disabled', err);
    return { sync() {}, highlight() {}, celebrate() {}, pulse() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070814, 0.028);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, 3, 15);

  // Lights
  scene.add(new THREE.AmbientLight(0x8a8cff, 0.35));
  const keyLight = new THREE.PointLight(0xa78bfa, 120, 60, 1.6);
  keyLight.position.set(6, 6, 7);
  const rimLight = new THREE.PointLight(0x22d3ee, 80, 60, 1.6);
  rimLight.position.set(-7, -4, 3);
  const coreLight = new THREE.PointLight(0x8b7bff, 25, 14, 1.4);
  scene.add(keyLight, rimLight, coreLight);

  const glowTexture = makeGlowTexture();
  const world = new THREE.Group();
  scene.add(world);

  // Core
  const core = new THREE.Group();
  const coreMaterial = new THREE.MeshStandardMaterial({
    color: CORE_IDLE.clone(),
    emissive: CORE_IDLE.clone(),
    emissiveIntensity: 0.35,
    metalness: 0.35,
    roughness: 0.25,
    flatShading: true,
  });
  const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.35, 1), coreMaterial);
  const wire = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.75, 1),
    new THREE.MeshBasicMaterial({ color: 0xc4b5fd, wireframe: true, transparent: true, opacity: 0.18 })
  );
  const coreGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: CORE_IDLE.clone(),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  coreGlow.scale.setScalar(7.5);
  core.add(coreGlow, coreMesh, wire);
  world.add(core);

  world.add(makeRing(RINGS.active.radius, RINGS.active.tilt, 0xa78bfa));
  world.add(makeRing(RINGS.done.radius, RINGS.done.tilt, 0x34d399));
  const dust = makeDust(600);
  world.add(dust);
  const stars = makeStars(1800);
  scene.add(stars);

  // Orbs
  const orbGeometry = new THREE.SphereGeometry(0.3, 32, 32);
  const orbs = new Map(); // id -> orb state
  const ringPhase = { active: 0, done: 0 };
  let completionRatio = 0;
  let corePulse = 0;
  let highlightedId = null;
  let hoveredId = null;

  function createOrb(todo) {
    const color = new THREE.Color(todo.completed ? DONE_COLOR : PRIORITY_COLORS[todo.priority]);
    const material = new THREE.MeshStandardMaterial({
      color: color.clone(),
      emissive: color.clone(),
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(orbGeometry, material);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: color.clone(),
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    glow.scale.setScalar(2.2);
    mesh.add(glow);
    mesh.scale.setScalar(0.001);
    world.add(mesh);

    const ring = todo.completed ? RINGS.done : RINGS.active;
    const orb = {
      id: todo.id,
      todo,
      mesh,
      glow,
      color,
      angle: Math.random() * TAU,
      slot: 0,
      radius: ring.radius + 3,
      tilt: ring.tilt,
      scale: 0.001,
      bobSeed: Math.random() * TAU,
      removing: false,
    };
    mesh.userData.orbId = todo.id;
    orbs.set(todo.id, orb);
    return orb;
  }

  function disposeOrb(orb) {
    world.remove(orb.mesh);
    orb.mesh.material.dispose();
    orb.glow.material.dispose();
    orbs.delete(orb.id);
  }

  function sync(todos) {
    const seen = new Set();
    for (const todo of todos) {
      seen.add(todo.id);
      const orb = orbs.get(todo.id) ?? createOrb(todo);
      orb.todo = todo;
      orb.removing = false;
      orb.color.set(todo.completed ? DONE_COLOR : PRIORITY_COLORS[todo.priority]);
    }
    for (const orb of orbs.values()) {
      if (!seen.has(orb.id)) orb.removing = true;
    }

    // Evenly distribute orbs around their ring.
    for (const key of ['active', 'done']) {
      const group = todos.filter((t) => (key === 'done') === t.completed);
      group.forEach((t, i) => {
        orbs.get(t.id).slot = (i / group.length) * TAU;
      });
    }

    completionRatio = todos.length ? todos.filter((t) => t.completed).length / todos.length : 0;
  }

  // Burst particles
  const bursts = [];
  function celebrate(id) {
    const orb = orbs.get(id);
    if (!orb) return;
    const count = 70;
    const positions = new Float32Array(count * 3);
    const velocities = [];
    for (let i = 0; i < count; i++) {
      positions.set([orb.mesh.position.x, orb.mesh.position.y, orb.mesh.position.z], i * 3);
      const v = new THREE.Vector3().randomDirection().multiplyScalar(1.5 + Math.random() * 3);
      velocities.push(v);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.14,
        map: glowTexture,
        color: DONE_COLOR,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    world.add(points);
    bursts.push({ points, velocities, life: 0 });
    corePulse = 1;
  }

  function pulse() {
    corePulse = 1;
  }

  function highlight(id) {
    highlightedId = id;
  }

  // Interaction
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const parallax = new THREE.Vector2();
  let pointerInside = false;

  function pick(clientX, clientY) {
    pointer.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const meshes = [...orbs.values()].filter((o) => !o.removing).map((o) => o.mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.orbId : null;
  }

  window.addEventListener('pointermove', (e) => {
    parallax.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    pointerInside = e.target === canvas;
    const id = pointerInside ? pick(e.clientX, e.clientY) : null;
    if (id !== hoveredId) {
      hoveredId = id;
      canvas.style.cursor = id ? 'pointer' : '';
    }
    onHover?.(id ? orbs.get(id).todo : null, e.clientX, e.clientY);
  });

  canvas.addEventListener('click', (e) => {
    const id = pick(e.clientX, e.clientY);
    if (id) onSelect?.(id);
  });

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Shift the scene so it isn't hidden behind the glass panel.
    if (w > 1000) camera.setViewOffset(w, h, w * 0.2, 0, w, h);
    else camera.setViewOffset(w, h, 0, h * 0.27, w, h);
    camera.position.z = w > 1000 ? 15 : 23;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // Animation loop
  const tmpColor = new THREE.Color();
  let last = performance.now();
  let t = 0;

  function tick(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    t += dt;

    ringPhase.active += RINGS.active.speed * dt * motion;
    ringPhase.done += RINGS.done.speed * dt * motion;

    // Core
    corePulse = damp(corePulse, 0, 3, dt);
    coreMesh.rotation.y += 0.15 * dt * motion;
    coreMesh.rotation.x += 0.07 * dt * motion;
    wire.rotation.y -= 0.1 * dt * motion;
    wire.rotation.z += 0.05 * dt * motion;
    const breathe = 1 + Math.sin(t * 1.4) * 0.025 * motion + corePulse * 0.18;
    core.scale.setScalar(breathe);
    tmpColor.copy(CORE_IDLE).lerp(CORE_DONE, completionRatio);
    coreMaterial.color.lerp(tmpColor, 0.05);
    coreMaterial.emissive.lerp(tmpColor, 0.05);
    coreMaterial.emissiveIntensity = 0.35 + corePulse * 0.8;
    coreGlow.material.color.copy(coreMaterial.color);
    coreGlow.material.opacity = 0.5 + corePulse * 0.4;
    coreLight.color.copy(coreMaterial.color);

    dust.rotation.y += 0.02 * dt * motion;
    stars.rotation.y += 0.004 * dt * motion;

    // Orbs
    for (const orb of orbs.values()) {
      const ringKey = orb.todo.completed ? 'done' : 'active';
      const ring = RINGS[ringKey];
      const targetAngle = ringPhase[ringKey] + orb.slot;
      orb.angle += wrapAngle(targetAngle - orb.angle) * (1 - Math.exp(-3 * dt));
      orb.radius = damp(orb.radius, orb.removing ? ring.radius + 4 : ring.radius, 3, dt);
      orb.tilt = damp(orb.tilt, ring.tilt, 3, dt);

      const active = orb.id === highlightedId || orb.id === hoveredId;
      const baseScale = orb.todo.completed ? 0.7 : 0.85 + orb.todo.priority * 0.15;
      const targetScale = orb.removing ? 0 : baseScale * (active ? 1.45 : 1);
      orb.scale = damp(orb.scale, targetScale, orb.removing ? 6 : 5, dt);
      orb.mesh.scale.setScalar(Math.max(orb.scale, 0.001));

      const bob = Math.sin(t * 1.5 + orb.bobSeed) * 0.15 * motion;
      const x = Math.cos(orb.angle) * orb.radius;
      const z = Math.sin(orb.angle) * orb.radius;
      orb.mesh.position.set(
        x,
        bob * Math.cos(orb.tilt) - z * Math.sin(orb.tilt),
        bob * Math.sin(orb.tilt) + z * Math.cos(orb.tilt)
      );

      orb.mesh.material.color.lerp(orb.color, 0.08);
      orb.mesh.material.emissive.lerp(orb.color, 0.08);
      orb.mesh.material.emissiveIntensity = active ? 1.6 : 0.9;
      orb.glow.material.color.copy(orb.mesh.material.color);
      orb.glow.material.opacity = active ? 1 : 0.65;

      if (orb.removing && orb.scale < 0.01) disposeOrb(orb);
    }

    // Bursts
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.life += dt;
      const pos = b.points.geometry.attributes.position;
      for (let j = 0; j < b.velocities.length; j++) {
        const v = b.velocities[j];
        v.multiplyScalar(1 - 2.2 * dt);
        pos.setXYZ(j, pos.getX(j) + v.x * dt, pos.getY(j) + v.y * dt, pos.getZ(j) + v.z * dt);
      }
      pos.needsUpdate = true;
      b.points.material.opacity = Math.max(0, 1 - b.life / 1.4);
      if (b.life > 1.4) {
        world.remove(b.points);
        b.points.geometry.dispose();
        b.points.material.dispose();
        bursts.splice(i, 1);
      }
    }

    // Camera parallax
    camera.position.x = damp(camera.position.x, parallax.x * 1.6, 2, dt);
    camera.position.y = damp(camera.position.y, 3 - parallax.y * 1.2, 2, dt);
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(tick);

  return { sync, highlight, celebrate, pulse };
}
