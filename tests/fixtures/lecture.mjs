// Deterministic, synthetic lecture-like transcripts for quality tests. No real lecture content is
// stored in this public repository; the incident case reproduces only the failure's *shape*.
const TERMS = ['external oblique', 'internal oblique', 'transversus abdominis', 'rectus sheath', 'linea alba', 'inguinal ligament',
  'deep inguinal ring', 'superficial inguinal ring', 'Scarpa fascia', 'Camper fascia', 'pyramidalis', 'arcuate line', 'iliohypogastric nerve',
  'ilioinguinal nerve', 'inferior epigastric artery', 'conjoint tendon', 'spermatic cord', 'cremaster muscle', 'fascia lata', 'umbilicus',
  'lacunar ligament', 'pectineal line', 'semilunar line', 'transversalis fascia', 'extraperitoneal fat', 'parietal peritoneum',
  'superior epigastric artery', 'thoracoabdominal nerves', 'anterior superior iliac spine', 'pubic tubercle', 'dartos muscle', 'tunica vaginalis'];
const VERBS = ['forms', 'lies deep to', 'is supplied by', 'continues as', 'attaches to', 'separates', 'protects', 'drains into', 'is pierced by',
  'gives rise to', 'blends with', 'is lateral to', 'runs along', 'reinforces', 'is derived from'];
const OPENERS = ['Remember that', 'In the exam they ask how', 'So clinically', 'Now look at the slide where', 'Notice that', 'The important point is that',
  'During a paracentesis', 'In this diagram', 'Students often forget that', 'For the quiz you must know that', 'Write this down:', 'Very important:'];
const ENDINGS = ['', ', okay?', ' in most people', ', is it clear?', ' on both sides', ' below the arcuate line', ' in the male', ' at the level of L1',
  ' which is tested every year', ' and this explains hernias'];

export function rng(seed = 1) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
const pick = (random, list) => list[Math.floor(random() * list.length)];

export function sentence(random, t) {
  return `${pick(random, OPENERS)} the ${pick(random, TERMS)} ${pick(random, VERBS)} the ${pick(random, TERMS)}${pick(random, ENDINGS)}${random() < 0.2 ? ` (slide ${Math.floor(t / 60) + 1})` : ''}.`;
}

/**
 * Normal lecture speech at a realistic pace (~`wordsPerSecond`), one sentence per segment with a
 * short pause after it. `step` adds extra pause (seconds) between segments for slower speakers.
 */
export function lecture({ from = 0, to, step = 0, seed = 1, wordsPerSecond = 2.6 }) {
  const random = rng(seed), out = [];
  for (let t = from; t + 1 < to;) {
    const text = sentence(random, t);
    const length = text.split(/\s+/).length / wordsPerSecond;
    const end = Math.min(to, t + length);
    out.push({ start: +t.toFixed(2), end: +end.toFixed(2), text });
    t = end + 0.4 + random() * 0.8 + step;
  }
  return out;
}

/** The P0 incident shape: normal speech, then one sentence repeated `times` times until `end`. */
export function incident({ loopStart = 237, end = 2451, times = 971, text = 'So deep membranous fascia is called fascia of the thigh.' } = {}) {
  const loop = [], step = (end - loopStart) / times;
  for (let i = 0; i < times; i++) loop.push({ start: +(loopStart + i * step).toFixed(2), end: +(loopStart + (i + 1) * step - 0.05).toFixed(2), text });
  return [...lecture({ to: loopStart, seed: 7 }), ...loop];
}
