import * as THREE from './three.module.js';

export function initHeroCanvas() {
    const container = document.getElementById('hero-3d-canvas');
    const fallbackImg = document.getElementById('hero-fallback-img');
    if (!container) return;

    // Verify WebGL availability
    try {
        const testCanvas = document.createElement('canvas');
        const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
        if (!gl) return;
    } catch {
        return;
    }

    const scene = new THREE.Scene();

    const width = container.clientWidth || 340;
    const height = container.clientHeight || 340;

    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 100);
    camera.position.set(0, 0, 7.5);

    const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance'
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;

    container.appendChild(renderer.domElement);

    // Fade out fallback image cleanly
    if (fallbackImg) {
        fallbackImg.style.opacity = '0';
    }

    // Textures
    const textureLoader = new THREE.TextureLoader();
    const colorMap = textureLoader.load('assets/omelette.png');
    const heightMap = textureLoader.load('assets/omelette-height.png');
    const normalMap = textureLoader.load('assets/omelette-normal.png');
    const roughnessMap = textureLoader.load('assets/omelette-roughness.png');

    colorMap.colorSpace = THREE.SRGBColorSpace;
    colorMap.generateMipmaps = true;

    // 3D Skillet Mesh
    const planeGeo = new THREE.PlaneGeometry(4.4, 4.4, 220, 220);
    const mat = new THREE.MeshStandardMaterial({
        map: colorMap,
        displacementMap: heightMap,
        displacementScale: 0.58,
        displacementBias: -0.05,
        normalMap: normalMap,
        normalScale: new THREE.Vector2(0.95, 0.95),
        roughnessMap: roughnessMap,
        roughness: 0.65,
        metalness: 0.18,
        transparent: true,
        alphaTest: 0.02,
        side: THREE.FrontSide,
    });

    const frontMesh = new THREE.Mesh(planeGeo, mat);

    // Dark rear backing plate so tilting reveals solid physical depth
    const backGeo = new THREE.PlaneGeometry(4.38, 4.38, 32, 32);
    const backMat = new THREE.MeshStandardMaterial({
        map: colorMap,
        roughness: 0.9,
        metalness: 0.08,
        transparent: true,
        alphaTest: 0.05,
        side: THREE.BackSide,
    });
    const backMesh = new THREE.Mesh(backGeo, backMat);
    backMesh.position.z = -0.06;

    // Soft contact shadow underneath
    const shadowGeo = new THREE.PlaneGeometry(4.5, 4.5);
    const shadowMat = new THREE.MeshBasicMaterial({
        map: textureLoader.load('assets/omelette-height.png'),
        color: 0x000000,
        transparent: true,
        opacity: 0.22,
        blending: THREE.NormalBlending,
        depthWrite: false,
    });
    const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    shadowMesh.position.z = -0.28;
    shadowMesh.scale.set(1.06, 1.06, 1.06);

    const group = new THREE.Group();
    group.add(shadowMesh);
    group.add(frontMesh);
    group.add(backMesh);
    scene.add(group);

    // Lighting setup
    const ambLight = new THREE.AmbientLight(0xffeedb, 1.45);
    scene.add(ambLight);

    // Warm key spotlight simulating warm kitchen counter light
    const keyLight = new THREE.DirectionalLight(0xfff5e3, 2.5);
    keyLight.position.set(4.5, 5.5, 5);
    scene.add(keyLight);

    // Cool rim light for metallic skillet definition
    const rimLight = new THREE.DirectionalLight(0xa5c4e8, 1.25);
    rimLight.position.set(-5, -3, 3);
    scene.add(rimLight);

    // Specular highlight light
    const specularLight = new THREE.PointLight(0xffedd2, 1.6, 16);
    specularLight.position.set(0, 2.5, 4);
    scene.add(specularLight);

    // Interactive state & physics
    let targetRotX = 0.16;
    let targetRotY = -0.24;
    let currentRotX = 0.16;
    let currentRotY = -0.24;
    let velX = 0;
    let velY = 0;
    let isDragging = false;
    let isHovered = false;
    let prevMouseX = 0;
    let prevMouseY = 0;

    container.addEventListener('pointerenter', () => {
        isHovered = true;
    });

    container.addEventListener('pointerleave', () => {
        isHovered = false;
    });

    container.addEventListener('pointerdown', (e) => {
        isDragging = true;
        prevMouseX = e.clientX;
        prevMouseY = e.clientY;
        velX = 0;
        velY = 0;
        container.setPointerCapture(e.pointerId);
    });

    window.addEventListener('pointermove', (e) => {
        if (isDragging) {
            const dx = e.clientX - prevMouseX;
            const dy = e.clientY - prevMouseY;
            velY = dx * 0.007;
            velX = dy * 0.007;
            targetRotY += velY;
            targetRotX += velX;
            prevMouseX = e.clientX;
            prevMouseY = e.clientY;
        } else if (isHovered) {
            const rect = container.getBoundingClientRect();
            const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
            targetRotY = -0.24 + nx * 0.55;
            targetRotX = 0.16 - ny * 0.45;
        }
    });

    window.addEventListener('pointerup', (e) => {
        if (isDragging) {
            isDragging = false;
            try {
                container.releasePointerCapture(e.pointerId);
            } catch {}
        }
    });

    // Responsive resize
    const onResize = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    // Animation loop
    const clock = new THREE.Clock();

    const animate = () => {
        requestAnimationFrame(animate);

        const t = clock.getElapsedTime();

        if (!isDragging && !isHovered) {
            // Organic idle hovering
            targetRotX = 0.16 + Math.sin(t * 1.1) * 0.09;
            targetRotY = -0.24 + Math.cos(t * 0.8) * 0.14;
            group.position.y = Math.sin(t * 1.4) * 0.07;
        } else if (isDragging) {
            targetRotY += velY;
            targetRotX += velX;
            velX *= 0.88;
            velY *= 0.88;
        }

        // Clamp vertical pitch
        targetRotX = Math.max(-1.1, Math.min(1.1, targetRotX));

        // Damping
        currentRotX += (targetRotX - currentRotX) * 0.08;
        currentRotY += (targetRotY - currentRotY) * 0.08;

        group.rotation.x = currentRotX;
        group.rotation.y = currentRotY;

        renderer.render(scene, camera);
    };

    animate();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHeroCanvas);
} else {
    initHeroCanvas();
}
