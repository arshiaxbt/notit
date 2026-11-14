/**
 * Points of interest on the plates, measured from stills of the footage, in CSS px of the app's
 * 1280×720 page (the 2560×1440 plates are that page at 2×). Hand-kept; not generated.
 */

/**
 * Where the app draws the ring on the first frame of `watch`. The cold open ends in this formation,
 * so the cut to the plate is a match cut.
 */
export const STAGE = {
  center: {x: 640, y: 322},
  clockR: 75,
  seat: {x: 640, y: 351, r: 20},
  faceR: 22,
  you: {x: 640, y: 480, r: 35},
  faces: [
    {x: 583, y: 164},
    {x: 697, y: 164},
    {x: 809, y: 187},
    {x: 909, y: 241},
    {x: 948, y: 342},
    {x: 874, y: 426},
    {x: 768, y: 467},
    {x: 513, y: 467},
    {x: 406, y: 426},
    {x: 332, y: 342},
    {x: 371, y: 241},
    {x: 471, y: 187},
  ],
  /** Share of the round burnt on the first frame of `watch` (2:30 left of 3:00). */
  p0: 1 / 6,
  /** Vertical extent of the yellow stage. */
  top: 95,
  bottom: 635,
};

export const POI = {
  /** The one button under your face, and the falling cost printed on it. */
  button: {x: 640, y: 556},
  cost: {x: 760, y: 556},
  /** The line under the button (sign-up steps, "you collected …"). */
  note: {x: 640, y: 599},
  /** Header: "key: volunteer only". */
  keyLink: {x: 860, y: 59},
  /** The strip of figures under the stage: "keep". */
  keep: {x: 310, y: 676},
  /** Chain bar under the table: "Locked: no access keys". */
  locked: {x: 524, y: 567},
  /** Rules page, rule 5 and the line under it. */
  rule5: {x: 370, y: 355},
};
