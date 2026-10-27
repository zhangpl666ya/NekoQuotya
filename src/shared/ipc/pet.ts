// Channel names for the pet window. Kept apart from the launcher's so the two
// preload bundles share no module (see electron.vite.config.ts).

export const PET_CHANNELS = {
  init: 'pet:init', //          renderer → main (invoke): PetInit
  intent: 'pet:intent', //      main → renderer: PetIntent
  ignoreMouse: 'pet:ignore', // renderer → main: boolean (click-through on/off)
  pointer: 'pet:pointer', //    renderer → main: PetPointer
  hud: 'pet:hud', //            main → renderer: PetHud (the quota widget beside the pet)
} as const;
