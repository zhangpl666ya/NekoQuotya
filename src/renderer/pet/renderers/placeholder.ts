import type { MoodId, PetIntent } from '../../../shared/pet.ts';
import type { PetRenderer } from './types.ts';

// Development stand-in for real artwork: a round face drawn on a canvas.
//   colour + expression  → mood        ring around the face → pressure %
//   motion               → action      closed eyes + "z"    → sleeping
//   "?" badge            → stale data  caption              → mood · activity · action
// Every state the brain can produce is visible, so behavior can be checked
// before any art exists.

const W = 240;
const H = 220;
const CX = W / 2;
const CY = 112;
const R = 72;

const COLORS: Record<MoodId, string> = {
  ENERGETIC: '#7bd389',
  FOCUSED: '#6aa9ff',
  SWEATING: '#ffd166',
  PANICKED: '#ff9f43',
  EXHAUSTED: '#ef5d60',
};

export class PlaceholderRenderer implements PetRenderer {
  readonly height = H;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private intent: PetIntent | null = null;

  async mount(stage: HTMLElement): Promise<void> {
    const dpr = window.devicePixelRatio || 1;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    stage.appendChild(this.canvas);
    const loop = () => {
      this.draw(performance.now(), Date.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  apply(intent: PetIntent): void {
    this.intent = intent;
  }

  hitTest(x: number, y: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    return Math.hypot(x - rect.left - CX, y - rect.top - CY) <= R + 6;
  }

  private draw(frame: number, now: number): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, W, H);
    const intent = this.intent;
    if (!intent) return;

    const action = intent.action;
    const elapsed = action ? now - action.startedAt : 0;
    const sleeping = intent.activity === 'sleeping';
    const motion = actionMotion(action?.id, elapsed, frame);

    ctx.save();
    ctx.translate(CX + motion.dx, CY + motion.dy);
    ctx.rotate(motion.rotate);
    ctx.scale(motion.sx, motion.sy);

    // pressure ring
    const pressure = Math.max(0, Math.min(100, intent.info.pressure));
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(0, 0, R + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = COLORS[intent.mood];
    ctx.beginPath();
    ctx.arc(0, 0, R + 8, -Math.PI / 2, -Math.PI / 2 + (pressure / 100) * Math.PI * 2);
    ctx.stroke();

    // face
    ctx.fillStyle = COLORS[intent.mood];
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    drawFace(ctx, intent.mood, sleeping, action?.id === 'eat' ? Math.abs(Math.sin(elapsed / 90)) : 0);
    if (!sleeping && (intent.mood === 'SWEATING' || intent.mood === 'PANICKED')) drawSweat(ctx, frame);
    ctx.restore();

    if (sleeping) drawZzz(ctx, frame);
    if (intent.activity === 'working' && !sleeping) drawSpark(ctx, frame);
    if (intent.info.stale) drawBadge(ctx, '?');

    // caption
    ctx.fillStyle = 'rgba(20,20,28,0.75)';
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    const caption = [intent.mood, intent.activity, action?.id].filter(Boolean).join(' · ');
    ctx.fillText(`${caption}  ${Math.round(intent.info.pressure)}%`, CX, H - 6);
  }
}

function actionMotion(id: string | undefined, t: number, frame: number) {
  const m = { dx: 0, dy: 0, rotate: 0, sx: 1, sy: 1 };
  switch (id) {
    case 'poked': {
      const k = Math.max(0, 1 - t / 600);
      m.sx = 1 + 0.12 * k * Math.cos(t / 40);
      m.sy = 1 - 0.12 * k * Math.cos(t / 40);
      break;
    }
    case 'dragged':
      m.rotate = Math.sin(frame / 180) * 0.12;
      m.dy = 4;
      break;
    case 'landed': {
      const k = Math.max(0, 1 - t / 400);
      m.sx = 1 + 0.15 * k;
      m.sy = 1 - 0.15 * k;
      break;
    }
    case 'alert':
      m.dx = Math.sin(t / 25) * 6 * Math.max(0, 1 - t / 3000);
      break;
    case 'celebrate':
      m.dy = -Math.abs(Math.sin(t / 160)) * 22;
      break;
    case 'wake': {
      const k = Math.sin(Math.min(1, t / 1200) * Math.PI);
      m.sy = 1 + 0.12 * k;
      m.sx = 1 - 0.06 * k;
      break;
    }
    case 'newDay':
      m.rotate = Math.sin(t / 120) * 0.15 * Math.max(0, 1 - t / 3000);
      break;
  }
  return m;
}

function drawFace(ctx: CanvasRenderingContext2D, mood: MoodId, sleeping: boolean, chew: number): void {
  ctx.strokeStyle = '#2b2233';
  ctx.fillStyle = '#2b2233';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';

  // eyes
  for (const x of [-26, 26]) {
    ctx.beginPath();
    if (sleeping) {
      ctx.arc(x, -12, 9, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    } else if (mood === 'EXHAUSTED') {
      ctx.moveTo(x - 8, -20);
      ctx.lineTo(x + 8, -4);
      ctx.moveTo(x + 8, -20);
      ctx.lineTo(x - 8, -4);
      ctx.stroke();
    } else if (mood === 'ENERGETIC') {
      ctx.arc(x, -8, 9, 1.15 * Math.PI, 1.85 * Math.PI);
      ctx.stroke();
    } else {
      ctx.arc(x, -12, mood === 'PANICKED' ? 9 : 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // mouth
  ctx.beginPath();
  if (chew > 0) {
    ctx.ellipse(0, 26, 12, 3 + chew * 9, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (sleeping) {
    ctx.arc(0, 28, 6, 0, Math.PI * 2);
    ctx.stroke();
  } else if (mood === 'ENERGETIC') {
    ctx.arc(0, 16, 20, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  } else if (mood === 'FOCUSED') {
    ctx.moveTo(-14, 28);
    ctx.lineTo(14, 28);
    ctx.stroke();
  } else if (mood === 'SWEATING') {
    ctx.moveTo(-16, 30);
    ctx.quadraticCurveTo(-8, 22, 0, 30);
    ctx.quadraticCurveTo(8, 38, 16, 30);
    ctx.stroke();
  } else if (mood === 'PANICKED') {
    ctx.ellipse(0, 30, 10, 13, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.arc(0, 44, 18, 1.2 * Math.PI, 1.8 * Math.PI);
    ctx.stroke();
  }
}

function drawSweat(ctx: CanvasRenderingContext2D, frame: number): void {
  const y = -30 + ((frame / 25) % 30);
  ctx.fillStyle = '#7fd3ff';
  ctx.beginPath();
  ctx.moveTo(52, y - 10);
  ctx.quadraticCurveTo(60, y + 2, 52, y + 6);
  ctx.quadraticCurveTo(44, y + 2, 52, y - 10);
  ctx.fill();
}

function drawZzz(ctx: CanvasRenderingContext2D, frame: number): void {
  ctx.fillStyle = 'rgba(40,40,60,0.75)';
  ctx.font = 'bold 18px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  for (let i = 0; i < 3; i++) {
    const phase = ((frame / 1400 + i / 3) % 1);
    ctx.globalAlpha = 1 - phase;
    ctx.fillText('z', CX + R - 10 + phase * 26, CY - R + 10 - phase * 34);
  }
  ctx.globalAlpha = 1;
}

function drawSpark(ctx: CanvasRenderingContext2D, frame: number): void {
  const a = frame / 300;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 3; i++) {
    const ang = a + (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.arc(CX + Math.cos(ang) * (R + 20), CY + Math.sin(ang) * (R + 20), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBadge(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.fillStyle = 'rgba(30,30,40,0.85)';
  ctx.beginPath();
  ctx.arc(CX + R - 4, CY - R + 4, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, CX + R - 4, CY - R + 10);
}
