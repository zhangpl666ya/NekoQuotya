import { pickVisual, type ImageAppearance } from '../../../shared/appearance.ts';
import type { PetIntent } from '../../../shared/pet.ts';
import type { PetRenderer } from './types.ts';

// Static images, one per visual key (mood.<MOOD>, action.<ACTION>, activity.sleeping).
// Missing images fall back (shared/appearance.ts → visualKeys); only mood.ENERGETIC
// is required. Hits use the image's alpha channel, so transparent pixels click
// through. A light motion per action keeps static art from feeling frozen.

interface LoadedImage {
  image: HTMLImageElement;
  /** Alpha channel at the drawn size, for hit testing */
  alpha: Uint8ClampedArray;
}

export class ImageRenderer implements PetRenderer {
  private readonly appearance: ImageAppearance;
  private readonly assetBase: string;
  private readonly images = new Map<string, LoadedImage>();
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private current: LoadedImage | null = null;
  private intent: PetIntent | null = null;

  constructor(appearance: ImageAppearance, assetBase: string) {
    this.appearance = appearance;
    this.assetBase = assetBase;
  }

  get height(): number {
    return this.appearance.size[1];
  }

  async mount(stage: HTMLElement): Promise<void> {
    const [w, h] = this.appearance.size;
    const dpr = window.devicePixelRatio || 1;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    stage.appendChild(this.canvas);

    await Promise.all(
      Object.entries(this.appearance.images).map(async ([key, file]) => {
        const loaded = await this.load(file);
        if (loaded) this.images.set(key, loaded);
      })
    );

    const loop = () => {
      this.draw(Date.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  apply(intent: PetIntent): void {
    this.intent = intent;
    this.current = this.images.get(pickVisual(this.images.keys(), intent)) ?? null;
  }

  hitTest(x: number, y: number): boolean {
    const current = this.current;
    if (!current) return false;
    const rect = this.canvas.getBoundingClientRect();
    const [w, h] = this.appearance.size;
    const px = Math.floor(x - rect.left);
    const py = Math.floor(y - rect.top);
    if (px < 0 || py < 0 || px >= w || py >= h) return false;
    // Above a soft floor shadow's alpha: clicking the shadow is not touching her
    return current.alpha[py * w + px]! > 110;
  }

  private draw(now: number): void {
    const [w, h] = this.appearance.size;
    const { ctx } = this;
    ctx.clearRect(0, 0, w, h);
    if (!this.current) return;
    const action = this.intent?.action;
    const t = action ? now - action.startedAt : 0;
    let dx = 0;
    let dy = 0;
    if (action?.id === 'poked' || action?.id === 'landed') dy = Math.sin(t / 50) * 4 * Math.max(0, 1 - t / 500);
    if (action?.id === 'alert') dx = Math.sin(t / 25) * 4 * Math.max(0, 1 - t / 3000);
    if (action?.id === 'celebrate') dy = -Math.abs(Math.sin(t / 160)) * 14;
    ctx.drawImage(this.current.image, dx, dy, w, h);
  }

  private async load(file: string): Promise<LoadedImage | null> {
    const image = new Image();
    image.crossOrigin = 'anonymous'; // needed to read pixels for hit testing
    image.src = this.assetBase + file.split('/').map(encodeURIComponent).join('/');
    try {
      await image.decode();
    } catch {
      return null; // a broken image is skipped; fallbacks cover it
    }
    const [w, h] = this.appearance.size;
    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(image, 0, 0, w, h);
    const rgba = sctx.getImageData(0, 0, w, h).data;
    const alpha = new Uint8ClampedArray(w * h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]!;
    return { image, alpha };
  }
}
