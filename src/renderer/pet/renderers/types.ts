import type { PetIntent } from '../../../shared/pet.ts';

// A renderer turns PetIntents into visuals (docs/architecture.md §5). The pet
// window shell handles the bubble, the mouse and the IPC; renderers only draw
// the character and answer "is this point on the character?".

export interface PetRenderer {
  /** Create the visuals inside `stage`; resolves once ready to draw */
  mount(stage: HTMLElement): Promise<void>;
  apply(intent: PetIntent): void;
  /** Client (window) coordinates → whether the point is on the character; decides click-through */
  hitTest(x: number, y: number): boolean;
  /** Height of the drawn character in CSS pixels, so the bubble sits above it */
  readonly height: number;
}
