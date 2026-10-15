// Units: centimetres and seconds.
// One eel goes through every step. In its own frame the fillet runs along u (0 = head end, L = tail),
// with lateral position w across it (negative = the far/upper half, positive = the near/lower half).

export const FISH = {
  L: 60,          // fillet length (a big eel; the head itself is separate and leaves with the bone)
  bins: 120,      // 0.5 cm cells along the length
  cols: 12,       // cells across the opened fillet
  R: 1.75,        // body radius (cm) in the thick part
  headLen: 7,
};
// lengths that were tuned on a 40 cm fillet scale with this
export const LSCALE = FISH.L / 40;
export const SKEWER_LEN = 24; // bridges the konro's rims, fits inside the tare trough

// radius of the body along its length: full through the middle, tapering to the tail
export function bodyRadius(u) {
  const L = FISH.L;
  if (u < 2) return FISH.R * (0.92 + 0.04 * u);
  const full = 0.6 * L;
  if (u < full) return FISH.R;
  const t = Math.min(1, (u - full) / (L - full));
  return FISH.R * (1 - 0.72 * t * t);
}

// width of each half of the opened fillet (before cut errors)
export function halfWidth(u) {
  return Math.PI * bodyRadius(u) * 0.74;
}

// thickness of the opened flesh
export function thickness(u) {
  return 0.55 + 0.45 * (bodyRadius(u) / FISH.R);
}

export const GRILL = {
  x0: -34, x1: 34,   // inside length of the charcoal box
  zHalf: 11,         // half depth (skewers rest on the front and back rims)
  rimY: 12,          // height of the rims (where skewers rest) above the counter
  coalY: 5,
};

// Charcoal heat (0..1): three bands front-to-back so the whole fish can sit in one of them —
// 強 at the back, 中 in the middle, 弱 at the front — and cooler ends. The coals glow from this too.
export function heatAt(x, z) {
  const sm = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  const band = 0.28 + 0.32 * (1 - sm(3.5, 6.5, z)) + 0.4 * (1 - sm(-6.5, -3.5, z));
  return band * (1 - 0.25 * sm(28, 35, Math.abs(x)));
}

export const GRILL_MOVE = { x0: -33, x1: -27, z0: -6.5, z1: 6.5 }; // head-end x and centre z of the (60 cm) fish on the grill

// constants calibrated with the design prototype (work/design-proto) and the simulated cooks
export const TUNE = {
  kF: 0.085, kS: 0.095, kUp: 0.14,      // surface dose rates (face down / skin down / face up share)
  knee: 0.65, kneeLo: 1.4, kneeHi: 1.95, // browning slows well before char: a late turn costs a little, not everything
  tauK: 2.2,                             // core follows the faces (× thickness²)
  cDry: 0.55, cUp: 0.04, drip: 0.8,      // wet tare → glaze on the coals, slow on top, excess drips
  shield: 0.45, burnB: 0.45, wLoss: 0.016,
  // dipping in the tare pot: the face that goes in first (the one facing the coals) is coated as soon as
  // it touches, the other once the fillet is fully under; a coat approaches dipCoat with time constant
  // dipTau, and staying in longer than soakAfter keeps thickening it (soak per second)
  dipCoat: 0.85, dipTau: 0.3, soakAfter: 1.4, soak: 0.2, sinkRate: 2.4, liftRate: 4, dripTo: 0.6, dripRate: 2.2,
  knifeMax: 1.5,       // the cut cannot stray further than this (cm) from the back line
  minSkewers: 3,
  maxSkewers: 4,
  steps: ['cut', 'open', 'bone', 'skewer', 'white', 'tare', 'unskewer', 'slice', 'plate', 'finish'],
};

// slots in the lacquered box (box-local cm): three pieces side by side, slightly overlapping
export const BOX = {
  inner: { x: 10.5, z: 5.8 },   // half sizes of the rice area (the 20 cm pieces reach past both rims)
  slots: [{ x: -6.4, z: 0 }, { x: 0, z: 0 }, { x: 6.4, z: 0 }],
};

// World layout (cm). The counter top is y = 0; +z is toward the player, +x to the right.
// Board on the left, charcoal grill in the middle, lacquered box on the right.
export const STATIONS = {
  board: { x: -70, z: 2, w: 74, d: 28, h: 3.2 },          // hinoki cutting board, top at y = h
  grill: { x: 0, z: 0, w: 82, d: 30, h: GRILL.rimY },      // konro outer size; rims (skewer rests) at y = h
  box: { x: 60, z: 4, w: 24, d: 15, h: 6.5, rice: 5.4 },   // jubako outer size; rice a little below the rim (a band of vermilion shows), the big pieces hang over front and back
  // the deep tare trough in front of the konro, long enough to take the whole skewered fillet
  // (wider inside than the 24 cm skewers, so they go in with the fish)
  tare: { x: 0, z: 29.5, len: 74, w: 27.6, h: 10, surf: 8.6, inner: { x: 35.5, z: 12.3 } },
  jar: { x: 44, z: 36 },                                     // sansho shaker / dish corner, right of the trough
};
// fish placement on the board: u = 0 (head end of the fillet) sits at this x
export const BOARD_FISH_X = STATIONS.board.x - 25;
