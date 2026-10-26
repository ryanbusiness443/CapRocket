// Names shown in the interface for RocketPilot Auto Edit (mirrors electron/rocket/effects.cjs).

export const TRANSITIONS = {
  fade: 'Crossfade', fadewhite: 'Flash white', fadeblack: 'Dip to black', zoomin: 'Zoom in', pixelize: 'Pixelate',
  radial: 'Radial wipe', hblur: 'Blur', circleopen: 'Circle open', circleclose: 'Circle close', squeezeh: 'Squeeze',
  slideleft: 'Slide left', slideright: 'Slide right', smoothleft: 'Smooth left', hrwind: 'Wind', diagtl: 'Diagonal',
  coverup: 'Cover up', rectcrop: 'Rectangle', wipeleft: 'Wipe left', dissolve: 'Dissolve', hlslice: 'Slices',
};

export const EFFECTS = {
  glitch: { label: 'Glitch', duration: 0.26 },
  flash: { label: 'Flash', duration: 0.11 },
  shake: { label: 'Camera shake', duration: 0.4 },
  trails: { label: 'Motion trails', duration: 0.95 },
  invert: { label: 'Invert hit', duration: 0.05 },
  boost: { label: 'Color boost', duration: 0.9 },
};

export const STYLES = {
  pro: { label: 'Pro', blurb: 'Clean read captions, zero dead air, no effects' },
  crazy: { label: 'Crazy', blurb: '12 transitions, glitch hits, trails, SFX' },
  hype: { label: 'Hype', blurb: 'Flash + shake on highlights, punchy cuts' },
  clean: { label: 'Clean', blurb: 'Soft fades, no hits, no SFX' },
};

export const CAPTION_STYLES = { read: 'Read (Pro)', karaoke: 'Word highlight', pop: 'Pop-in', clean: 'Clean', off: 'Hidden' };
