/**
 * Render effects of the 3D layer: contact shadows, post-processing chain, motion-blur accumulation.
 * Everything is stateless between frames (no temporal effects), so frames render in any order.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { PostSpec, ThreeIR } from '../../dsl/features/three';

// ---------------------------------------------------------------- contact shadows
export class ContactShadow {
  readonly mesh: THREE.Mesh;
  private rt: THREE.WebGLRenderTarget;
  private rtBlur: THREE.WebGLRenderTarget;
  private cam: THREE.OrthographicCamera;
  private depth: THREE.MeshDepthMaterial;
  private hBlur: THREE.ShaderMaterial;
  private vBlur: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor(private spec: NonNullable<ThreeIR['contact']>, res = 512) {
    const { size, y, far, opacity, color } = spec;
    this.rt = new THREE.WebGLRenderTarget(res, res);
    this.rtBlur = new THREE.WebGLRenderTarget(res, res);
    this.rt.texture.generateMipmaps = this.rtBlur.texture.generateMipmaps = false;
    const plane = new THREE.PlaneGeometry(size, size).rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: this.rt.texture, transparent: true, opacity, depthWrite: false, color: new THREE.Color(color) });
    this.mesh = new THREE.Mesh(plane, mat);
    this.mesh.scale.y = -1; // the texture is seen from below
    this.mesh.position.y = y + 0.002;
    this.mesh.renderOrder = -1;
    this.mesh.userData.mfHelper = true;
    this.cam = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, far);
    this.cam.position.set(0, y, 0);
    this.cam.rotation.x = Math.PI / 2;
    this.depth = new THREE.MeshDepthMaterial();
    this.depth.userData.darkness = { value: 1.6 };
    this.depth.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = this.depth.userData.darkness;
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', 'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );')}`;
    };
    this.depth.depthTest = this.depth.depthWrite = false;
    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.hBlur.depthTest = this.vBlur.depthTest = false;
    this.quad = new FullScreenQuad();
  }

  render(gl: THREE.WebGLRenderer, scene: THREE.Scene) {
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => {
      // fully dissolved objects no longer cast a contact shadow
      const gone = o.userData.mfFront && o.userData.mfFront.value >= 1;
      if (o.visible && (o.userData.mfHelper || o.userData.mfGround || o.userData.mfParticles || gone)) {
        hidden.push(o);
        o.visible = false;
      }
    });
    const bg = scene.background;
    scene.background = null;
    scene.overrideMaterial = this.depth;
    const prevRT = gl.getRenderTarget();
    const prevClear = gl.getClearAlpha();
    gl.setClearAlpha(0);
    gl.setRenderTarget(this.rt);
    gl.clear();
    gl.render(scene, this.cam);
    scene.overrideMaterial = null;
    const blur = this.spec.blur;
    for (let i = 0; i < 2; i++) {
      const amt = (blur / 256) * (i === 0 ? 1 : 0.4);
      this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
      this.hBlur.uniforms.h.value = amt;
      this.quad.material = this.hBlur;
      gl.setRenderTarget(this.rtBlur);
      this.quad.render(gl);
      this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
      this.vBlur.uniforms.v.value = amt;
      this.quad.material = this.vBlur;
      gl.setRenderTarget(this.rt);
      this.quad.render(gl);
    }
    gl.setRenderTarget(prevRT);
    gl.setClearAlpha(prevClear);
    scene.background = bg;
    for (const o of hidden) o.visible = true;
  }
}

// ---------------------------------------------------------------- finishing pass (vignette, grain, chromatic aberration)
const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0 }, uGrain: { value: 0 }, uChroma: { value: 0 }, uSeed: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
uniform sampler2D tDiffuse; uniform float uVignette; uniform float uGrain; uniform float uChroma; uniform float uSeed;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
void main() {
  vec2 d = vUv - 0.5;
  vec4 c = texture2D(tDiffuse, vUv);
  if (uChroma > 0.0) {
    c.r = texture2D(tDiffuse, vUv + d * uChroma * 2.0).r;
    c.b = texture2D(tDiffuse, vUv - d * uChroma * 2.0).b;
  }
  float v = 1.0 - uVignette * smoothstep(0.25, 0.85, length(d) * 1.25);
  // premultiplied output: darkening also covers transparent pixels (background painted behind the canvas)
  c.rgb *= v;
  c.a = c.a + (1.0 - v) * (1.0 - c.a);
  c.rgb += (hash(vUv * 1000.0) - 0.5) * uGrain * c.a;
  gl_FragColor = c;
}`,
};

// ---------------------------------------------------------------- accumulation (motion blur)
const AccumShader = {
  uniforms: { tDiffuse: { value: null }, uWeight: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uWeight; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv) * uWeight; }`,
};

export interface Pipeline {
  /** Render a frame. `update(t)` poses the scene at frame t (sub-frames for motion blur). */
  render(lf: number, update: (t: number) => void, before: () => void): void;
  dispose(): void;
}

export function makePipeline(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: { w: number; h: number },
  post: PostSpec | undefined,
  motionBlur: ThreeIR['motionBlur'],
  draft: boolean,
): Pipeline {
  const blur = !draft && motionBlur ? motionBlur : undefined;
  const p = post ?? {};
  const usePost = !!(p.bloom || (p.ao && !draft) || (p.dof && !draft) || p.vignette || p.grain || p.chromatic || blur);
  if (!usePost) {
    return {
      render(lf, update, before) {
        update(lf);
        before();
        gl.setRenderTarget(null);
        gl.render(scene, camera);
      },
      dispose() {},
    };
  }
  const pr = gl.getPixelRatio();
  const W = Math.round(size.w * pr);
  const H = Math.round(size.h * pr);
  const rtType = THREE.HalfFloatType;
  const composer = new EffectComposer(gl, new THREE.WebGLRenderTarget(W, H, { type: rtType, samples: 4 }));
  composer.setPixelRatio(1);
  composer.setSize(W, H);
  // accumulation target: the motion-blurred colour replaces the RenderPass output
  const acc = blur ? new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType }) : null;
  const sub = blur ? new THREE.WebGLRenderTarget(W, H, { type: rtType, samples: 4 }) : null;
  // pure sum (One/One): each sub-frame is already weighted by 1/n in the shader (AdditiveBlending would weight it twice)
  const accQuad = new FullScreenQuad(
    new THREE.ShaderMaterial({
      ...AccumShader,
      uniforms: THREE.UniformsUtils.clone(AccumShader.uniforms),
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }),
  );
  if (blur) {
    const tex = new ShaderPass({ uniforms: { tDiffuse: { value: null }, tAcc: { value: acc!.texture } }, vertexShader: AccumShader.vertexShader.replace('vec4(position.xy, 0.0, 1.0)', 'projectionMatrix * modelViewMatrix * vec4(position, 1.0)'), fragmentShader: `uniform sampler2D tAcc; varying vec2 vUv; void main() { gl_FragColor = texture2D(tAcc, vUv); }` });
    // ShaderPass clones its uniforms (and textures with them): point it at the live target again
    tex.uniforms.tAcc.value = acc!.texture;
    composer.addPass(tex);
  } else composer.addPass(new RenderPass(scene, camera));
  let ao: GTAOPass | null = null;
  if (p.ao && !draft) {
    ao = new GTAOPass(scene, camera, W, H);
    ao.updateGtaoMaterial({ radius: p.ao.radius, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 });
    ao.blendIntensity = p.ao.intensity;
    composer.addPass(ao);
  }
  let bokeh: BokehPass | null = null;
  if (p.dof && !draft) {
    bokeh = new BokehPass(scene, camera, { focus: p.dof.focus, aperture: p.dof.aperture / 1000, maxblur: p.dof.maxblur });
    // keep the alpha channel (transparent canvases, exact background colour behind)
    const mb = (bokeh as any).materialBokeh as THREE.ShaderMaterial;
    mb.fragmentShader = mb.fragmentShader.replace('gl_FragColor.a = 1.0;', 'gl_FragColor.a = texture2D( tColor, vUv ).a;');
    mb.needsUpdate = true;
    composer.addPass(bokeh);
  }
  if (p.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(W, H), p.bloom.strength, p.bloom.radius, p.bloom.threshold));
  composer.addPass(new OutputPass());
  let finish: ShaderPass | null = null;
  if (p.vignette || p.grain || p.chromatic) {
    finish = new ShaderPass(FinishShader);
    finish.uniforms.uVignette.value = p.vignette ?? 0;
    finish.uniforms.uGrain.value = p.grain ?? 0;
    finish.uniforms.uChroma.value = p.chromatic ?? 0;
    composer.addPass(finish);
  }
  return {
    render(lf, update, before) {
      if (blur && acc && sub) {
        const prevAuto = gl.autoClear;
        gl.setRenderTarget(acc);
        gl.setClearColor(0x000000, 0);
        gl.clear();
        const n = blur.samples;
        (accQuad.material as THREE.ShaderMaterial).uniforms.uWeight.value = 1 / n;
        for (let k = 0; k < n; k++) {
          // shutter centred on the frame
          update(lf + blur.shutter * ((k + 0.5) / n - 0.5));
          before();
          gl.setRenderTarget(sub);
          gl.clear();
          gl.render(scene, camera);
          (accQuad.material as THREE.ShaderMaterial).uniforms.tDiffuse.value = sub.texture;
          gl.setRenderTarget(acc);
          gl.autoClear = false;
          accQuad.render(gl);
          gl.autoClear = prevAuto;
        }
        update(lf); // AO / depth of field read the scene at the frame itself
      } else {
        update(lf);
        before();
      }
      if (bokeh && p.dof?.keys?.length) {
        const ks = p.dof.keys;
        let f = ks[ks.length - 1][1][0];
        for (let i = 1; i < ks.length; i++)
          if (lf <= ks[i][0]) {
            const t = Math.max(0, Math.min(1, (lf - ks[i - 1][0]) / Math.max(1, ks[i][0] - ks[i - 1][0])));
            f = ks[i - 1][1][0] + (ks[i][1][0] - ks[i - 1][1][0]) * (t * t * (3 - 2 * t));
            break;
          }
        if (lf <= ks[0][0]) f = ks[0][1][0];
        (bokeh.uniforms as any).focus.value = f;
      }
      if (finish) finish.uniforms.uSeed.value = (lf % 997) * 0.618;
      gl.setRenderTarget(null);
      composer.render();
    },
    dispose() {
      composer.dispose();
      acc?.dispose();
      sub?.dispose();
    },
  };
}
