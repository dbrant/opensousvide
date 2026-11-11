// Draws the app icon (a white Joule-style cylinder with a red status light on
// deep water-blue) and renders every PNG the app config needs.
//
//   node scripts/make-icons.mjs            writes assets/*.png
//   node scripts/make-icons.mjs <dir>      also writes a masked preview to <dir>
//
// All shapes are in a local frame centered on the cylinder, so each output just
// places the same drawing at a different scale.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Resvg } from '@resvg/resvg-js';

const SIZE = 1024;
const RX = 130; // cylinder radius
const HALF_H = 310; // half the height of the straight body
const RY = 36; // ellipse height of the top and bottom edges (viewing angle)
const LIGHT_Y = -HALF_H + 72;

const defs = `
  <radialGradient id="water" cx="512" cy="420" r="640" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#2B8AA3"/>
    <stop offset="0.55" stop-color="#155A70"/>
    <stop offset="1" stop-color="#0A2E3E"/>
  </radialGradient>
  <linearGradient id="body" x1="${-RX}" y1="0" x2="${RX}" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#D5DBE0"/>
    <stop offset="0.2" stop-color="#F6F8F9"/>
    <stop offset="0.42" stop-color="#FFFFFF"/>
    <stop offset="0.78" stop-color="#E3E8EB"/>
    <stop offset="1" stop-color="#B9C2C9"/>
  </linearGradient>
  <linearGradient id="top" x1="${-RX}" y1="${-HALF_H - RY}" x2="${RX}" y2="${-HALF_H + RY}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FFFFFF"/>
    <stop offset="1" stop-color="#DCE2E6"/>
  </linearGradient>
  <radialGradient id="led" cx="-4" cy="${LIGHT_Y - 4}" r="16" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#FF8A80"/>
    <stop offset="0.5" stop-color="#FF3B30"/>
    <stop offset="1" stop-color="#C81E14"/>
  </radialGradient>
  <filter id="blur-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="11"/></filter>
  <filter id="blur-shadow" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="16"/></filter>
`;

const bodyPath = `M ${-RX},${-HALF_H} L ${-RX},${HALF_H} A ${RX},${RY} 0 0 0 ${RX},${HALF_H} L ${RX},${-HALF_H} Z`;

function cylinder({ shadow }) {
  return `
    ${shadow ? `<ellipse cx="0" cy="${HALF_H + RY + 6}" rx="${RX + 40}" ry="${RY}" fill="#000" opacity="0.35" filter="url(#blur-shadow)"/>` : ''}
    <path d="${bodyPath}" fill="url(#body)"/>
    <ellipse cx="0" cy="${-HALF_H}" rx="${RX}" ry="${RY}" fill="url(#top)"/>
    <ellipse cx="0" cy="${-HALF_H}" rx="${RX - 1.5}" ry="${RY - 1.5}" fill="none" stroke="#C7CFD5" stroke-width="3"/>
    <circle cx="0" cy="${LIGHT_Y}" r="34" fill="#FF3B30" opacity="0.55" filter="url(#blur-glow)"/>
    <circle cx="0" cy="${LIGHT_Y}" r="15" fill="url(#led)"/>
  `;
}

/** Solid silhouette with the light cut out, for Android themed icons. */
function silhouette() {
  return `
    <mask id="cutout" maskUnits="userSpaceOnUse" x="-512" y="-512" width="1024" height="1024">
      <rect x="-512" y="-512" width="1024" height="1024" fill="#fff"/>
      <circle cx="0" cy="${LIGHT_Y}" r="17" fill="#000"/>
    </mask>
    <g mask="url(#cutout)" fill="#fff">
      <path d="${bodyPath}"/>
      <ellipse cx="0" cy="${-HALF_H}" rx="${RX}" ry="${RY}"/>
    </g>
  `;
}

const background = `<rect width="${SIZE}" height="${SIZE}" fill="url(#water)"/>`;

function svg(content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><defs>${defs}</defs>${content}</svg>`;
}

// Launchers show only the middle two-thirds of an adaptive layer, scaled up to
// fill the icon, so the cylinder is drawn smaller there.
const ADAPTIVE_SCALE = 0.6;
const place = (scale, y = 512) => `transform="translate(512 ${y}) scale(${scale})"`;

const outputs = {
  'icon.png': svg(`${background}<g ${place(1, 500)}>${cylinder({ shadow: true })}</g>`),
  'android-icon-background.png': svg(background),
  'android-icon-foreground.png': svg(`<g ${place(ADAPTIVE_SCALE, 500)}>${cylinder({ shadow: true })}</g>`),
  'android-icon-monochrome.png': svg(`<g ${place(ADAPTIVE_SCALE, 500)}>${silhouette()}</g>`),
};

function render(markup) {
  return new Resvg(markup, { fitTo: { mode: 'width', value: SIZE } }).render().asPng();
}

const assets = new URL('../assets/', import.meta.url);
for (const [name, markup] of Object.entries(outputs)) {
  writeFileSync(new URL(name, assets), render(markup));
  console.log(`wrote assets/${name}`);
}

// Optional preview: the full icon, then the adaptive icon under circle and
// squircle masks, then the themed monochrome version.
const previewDir = process.argv[2];
if (previewDir) {
  const tile = 300;
  const s = tile / SIZE;
  // Launchers show only the middle 72/108 of an adaptive layer, scaled to fill.
  const visible = (SIZE * 72) / 108;
  const inset = (SIZE - visible) / 2;
  const adaptive = (x) => `translate(${x} 20) scale(${tile / visible}) translate(${-inset} ${-inset})`;
  const layers = `${background}<g ${place(ADAPTIVE_SCALE, 500)}>${cylinder({ shadow: true })}</g>`;
  const squircle = `M 512,0 C 900,0 1024,124 1024,512 C 1024,900 900,1024 512,1024 C 124,1024 0,900 0,512 C 0,124 124,0 512,0 Z`;
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="${tile * 4 + 100}" height="${tile + 40}">
    <defs>${defs}
      <clipPath id="circle"><circle cx="512" cy="512" r="${visible / 2}"/></clipPath>
      <clipPath id="squircle"><path d="${squircle}" transform="translate(${inset} ${inset}) scale(${visible / SIZE})"/></clipPath>
      <clipPath id="rounded"><rect width="1024" height="1024" rx="225"/></clipPath>
    </defs>
    <rect width="100%" height="100%" fill="#ECE9E4"/>
    <g transform="translate(20 20) scale(${s})" clip-path="url(#rounded)">${background}<g ${place(1, 500)}>${cylinder({ shadow: true })}</g></g>
    <g transform="${adaptive(40 + tile)}" clip-path="url(#circle)">${layers}</g>
    <g transform="${adaptive(60 + tile * 2)}" clip-path="url(#squircle)">${layers}</g>
    <g transform="${adaptive(80 + tile * 3)}" clip-path="url(#circle)">
      <rect width="1024" height="1024" fill="#3B4A3F"/><g ${place(ADAPTIVE_SCALE, 500)}>${silhouette()}</g>
    </g>
  </svg>`;
  const out = join(previewDir, 'icon-preview.png');
  writeFileSync(out, new Resvg(preview).render().asPng());
  console.log(`wrote ${out}`);
}
