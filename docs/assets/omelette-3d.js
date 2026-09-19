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

    const width = container.clientWidth || 320;
    const height = container.clientHeight || 320;

    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.set(0, 0, 7.2);

    const renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance'
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    container.appendChild(renderer.domElement);

    // Hide fallback image once WebGL is initialized
    if (fallbackImg) {
        fallbackImg.style.opacity = '0';
    }

    // Textures
    const textureLoader = new THREE.TextureLoader();
    const colorMap = textureLoader.load('assets/omelette.png');
    const heightMap = textureLoader.load('assets/omelette-height.png');
    const normalMap = textureLoader.load('assets/omelette-normal.png');

    colorMap.colorSpace = THREE.SRGBColorSpace;
    colorMap.generateMipmaps = true;

    // Create 3D squircle tile with rounded back
    // Front embossed plane
    const planeGeo = new THREE.PlaneGeometry(4.4, 4.4, 200, 200);
    const mat = new THREE.MeshStandardMaterial({
        map: colorMap,
        displacementMap: heightMap,
        displacementScale: 0.55,
        displacementBias: -0.05,
        normalMap: normalMap,
        normalScale: new THREE.Vector2(0.8, 0.8),
        roughness: 0.55,
        metalness: 0.15,
        transparent: true,
        alphaTest: 0.02,
        side: THREE.FrontSide,
    });

    const frontMesh = new THREE.Mesh(planeGeo, mat);

    // Dark sleek back backing plate with matching bevel so it feels like a physical 3D icon
    const backGeo = new THREE.PlaneGeometry(4.38, 4.38, 32, 32);
    const backMat = new THREE.MeshStandardMaterial({
        map: colorMap,
        roughness: 0.85,
        metalness: 0.1,
        transparent: true,
        alphaTest: 0.05,
        side: THREE.BackSide,
    });
    const backMesh = new THREE.Mesh(backGeo, backMat);
    backMesh.position.z = -0.06;

    const group = new THREE.Group();
    group.add(frontMesh);
    group.add(backMesh);
    scene.add(group);

    // Cinematic lighting
    const ambLight = new THREE.AmbientLight(0xfff3e6, 1.4);
    scene.add(ambLight);

    // Main key light (warm, simulates kitchen counter/studio spotlight)
    const keyLight = new THREE.DirectionalLight(0xfffaea, 2.4);
    keyLight.position.set(4, 5, 5);
    scene.add(keyLight);

    // Rim / side light (subtle cool rim highlights on the cast iron pan)
    const rimLight = new THREE.DirectionalLight(0xa5c4e8, 1.2);
    rimLight.position.set(-5, -3, 3);
    scene.add(rimLight);

    // Specular highlight light
    const specularLight = new THREE.PointLight(0xffecd0, 1.5, 15);
    specularLight.position.set(0, 2, 4);
    scene.add(specularLight);

    // Interactive state & physics
    let targetRotX = 0.15;
    let targetRotY = -0.22;
    let currentRotX = 0.15;
    let currentRotY = -0.22;
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
            targetRotY = -0.22 + nx * 0.55;
            targetRotX = 0.15 - ny * 0.45;
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
            // Gentle organic idle hovering
            targetRotX = 0.15 + Math.sin(t * 1.1) * 0.09;
            targetRotY = -0.22 + Math.cos(t * 0.8) * 0.14;
            group.position.y = Math.sin(t * 1.4) * 0.08;
        } else if (isDragging) {
            targetRotY += velY;
            targetRotX += velX;
            velX *= 0.88;
            velY *= 0.88;
        }

        // Clamp vertical pitch so user doesn't turn it inside out awkwardly
        targetRotX = Math.max(-1.1, Math.min(1.1, targetRotX));

        // Smooth damping
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
