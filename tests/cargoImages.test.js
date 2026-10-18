// The dashboard picks a cargo picture by name at runtime; a renamed or missing file only shows up
// as a broken image in the browser. Keep the names the code can produce and the files on disk in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CARGO_TYPES, cargoImage, cargoType } from '../web/src/lib/market.js';

const root = path.join(import.meta.dirname, '..');
const imageDir = path.join(root, 'public', 'img', 'cargo');

test('every cargo picture the frontend can request exists as WebP', () => {
  assert.equal(CARGO_TYPES.length, 8);
  for (const name of CARGO_TYPES) {
    assert.equal(cargoImage(name), `/img/cargo/${name}.webp?v=2`);
    const file = path.join(imageDir, `${name}.webp`);
    assert.ok(fs.existsSync(file), `public/img/cargo/${name}.webp is referenced but missing`);
    const header = fs.readFileSync(file).subarray(0, 12);
    assert.equal(header.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.equal(header.subarray(8, 12).toString('latin1'), 'WEBP');
  }
});

test('each catalog case maps to the picture of its own cargo', () => {
  const expected = { copper: /copper|铜/iu, 'copper-concentrate': /cuconc|copper concentrate|铜精矿/iu,
    oil: /crude|oil|原油/iu, diesel: /gasoil|diesel|成品油|柴油/iu, ore: /iron ore|ironore|铁矿/iu,
    rubber: /rubber|橡胶/iu, soybean: /soy|大豆/iu, alu: /alu|铝/iu };
  const dir = path.join(root, 'data', 'cases');
  const files = [path.join(root, 'data', 'demo-case.json'), ...fs.readdirSync(dir)
    .filter((name) => name.endsWith('.case.json')).map((name) => path.join(dir, name))];
  const images = new Set();
  assert.ok(files.length >= 5);
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cargo = data.bill_of_lading?.cargo ?? '';
    const type = cargoType(`${data.case_id ?? file} ${cargo}`);
    assert.ok(CARGO_TYPES.includes(type), `${file}: ${type}`);
    assert.match(`${data.case_id ?? file} ${cargo}`, expected[type], `${file} (${cargo}) got the ${type} picture`);
    const image = cargoImage(cargo, data.case_id);
    assert.ok(fs.existsSync(path.join(root, 'public', image.split('?')[0])), `${file}: missing ${image}`);
    images.add(image);
  }
  assert.equal(images.size, files.length, 'each current catalog project, including warehouse lots, has its own photo');
});

test('the cargo pictures stay web-sized', () => {
  for (const file of fs.readdirSync(imageDir)) {
    const bytes = fs.statSync(path.join(imageDir, file)).size;
    assert.ok(bytes < 300 * 1024, `${file} is ${Math.round(bytes / 1024)} KB; compress it (they load on the first screen)`);
  }
});
