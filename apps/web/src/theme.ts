// Colour is used to MEAN something: the block family (what kind of device it is) and the scene. Nothing else is coloured.

export interface Family { code: string; color: string; label: string }

const F = {
  UTL: { code: 'UTL', color: '#8fb3c9', label: 'Utility' },
  CMP: { code: 'CMP', color: '#5eead4', label: 'Dynamics' },
  DRV: { code: 'DRV', color: '#fbbf24', label: 'Drive' },
  AMP: { code: 'AMP', color: '#f87171', label: 'Amp' },
  CAB: { code: 'CAB', color: '#d4915f', label: 'Cab / IR' },
  CAP: { code: 'CAP', color: '#fb923c', label: 'Capture' },
  MOD: { code: 'MOD', color: '#a78bfa', label: 'Modulation' },
  DLY: { code: 'DLY', color: '#60a5fa', label: 'Delay' },
  RVB: { code: 'RVB', color: '#34d399', label: 'Reverb' },
  SYN: { code: 'SYN', color: '#f472b6', label: 'Synth' },
} as const satisfies Record<string, Family>;

/** Map one of the unit's catalog categories ("Guitar Overdrive", "Cabsim Bass (ST)"…) to a family. Unknown -> Utility. */
export function familyOf(category: string | undefined): Family {
  const c = category ?? '';
  if (/neural capture/i.test(c)) return F.CAP;
  if (/overdrive|distortion|fuzz/i.test(c)) return F.DRV;
  if (/amplifier/i.test(c)) return F.AMP;
  if (/cabsim|irloader/i.test(c)) return F.CAB;
  if (/compressor/i.test(c)) return F.CMP;
  if (/delay/i.test(c)) return F.DLY;
  if (/reverb/i.test(c)) return F.RVB;
  if (/modulation|wah|pitch|morph|filter/i.test(c)) return F.MOD;
  if (/synth/i.test(c)) return F.SYN;
  return F.UTL;
}

/** CSS colour for a scene (0xAARRGGBB as stored in the preset). A scene with no colour gets a neutral. */
export function sceneColor(argb: number | undefined): string {
  return argb && argb >>> 24 !== 0 ? `#${(argb & 0xffffff).toString(16).padStart(6, '0')}` : '#55555e';
}
