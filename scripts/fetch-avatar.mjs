// Récupère ton avatar Roblox en 3D (OBJ + MTL + textures) et l'écrit dans /avatar.
// Lancé par .github/workflows/update-avatar.yml, ou à la main :
//   ROBLOSECURITY="..." node scripts/fetch-avatar.mjs
//
// Variables d'env :
//   ROBLOX_USER_ID  (défaut 1077832330)
//   ROBLOSECURITY   cookie d'un compte Roblox (un ALT, pas ton compte principal)

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const USER_ID = process.env.ROBLOX_USER_ID || '1077832330';
const COOKIE = (process.env.ROBLOSECURITY || '').trim();
const OUT = path.resolve(process.env.AVATAR_OUT || 'avatar');
const UA = 'Mozilla/5.0 (portfolio avatar sync)';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[avatar]', ...a);
function fail(msg) { console.error('::error::' + msg); process.exit(1); }

// URL CDN Roblox à partir d'un hash (même formule que le site Roblox)
function cdnFromHash(hash) {
  let i = 31;
  for (let t = 0; t < Math.min(hash.length, 38); t++) i ^= hash.charCodeAt(t);
  return `https://t${i % 8}.rbxcdn.com/${hash}`;
}

async function download(hash) {
  const candidates = [cdnFromHash(hash), `https://tr.rbxcdn.com/${hash}`];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch { /* on essaie le suivant */ }
  }
  throw new Error(`impossible de télécharger ${hash}`);
}

function imageExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(0, 4).toString() === 'RIFF') return 'webp';
  return 'png';
}

async function getAvatar3D() {
  if (!COOKIE) fail('Secret ROBLOSECURITY manquant. Ajoute-le dans Settings > Secrets and variables > Actions.');
  const url = `https://thumbnails.roblox.com/v1/users/avatar-3d?userId=${USER_ID}`;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = await fetch(url, { headers: { Cookie: `.ROBLOSECURITY=${COOKIE}`, 'User-Agent': UA, Accept: 'application/json' } });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403 || (body.errors && /auth/i.test(JSON.stringify(body.errors)))) {
      fail('Roblox refuse le cookie (expiré ou invalide). Mets à jour le secret ROBLOSECURITY.');
    }
    if (!r.ok) throw new Error(`avatar-3d HTTP ${r.status}: ${JSON.stringify(body)}`);
    if (body.state === 'Completed' && body.imageUrl) return body.imageUrl;
    log(`rendu en cours (${body.state}), essai ${attempt}/12…`);
    await sleep(5000);
  }
  throw new Error('Roblox n\'a pas fini le rendu 3D à temps');
}

async function get2DThumb() {
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${USER_ID}&size=720x720&format=Png&isCircular=false`, { headers: { 'User-Agent': UA } });
    const j = await r.json();
    const u = j.data?.[0]?.imageUrl;
    if (!u) return null;
    const img = await fetch(u);
    return img.ok ? Buffer.from(await img.arrayBuffer()) : null;
  } catch { return null; }
}

async function main() {
  const metaUrl = await getAvatar3D();
  const meta = await (await fetch(metaUrl, { headers: { 'User-Agent': UA } })).json();
  if (!meta.obj || !meta.mtl) throw new Error('réponse 3D inattendue: ' + JSON.stringify(meta).slice(0, 300));

  // Signature = hash des fichiers : si rien n'a changé, on ne touche à rien (pas de commit inutile)
  const signature = createHash('sha1')
    .update([meta.obj, meta.mtl, ...(meta.textures || [])].join('|'))
    .digest('hex').slice(0, 12);

  let previous = null;
  try { previous = JSON.parse(await readFile(path.join(OUT, 'avatar.json'), 'utf8')); } catch {}
  if (previous?.signature === signature && !process.env.FORCE) {
    log('avatar inchangé, rien à faire.');
    return;
  }

  log('téléchargement OBJ / MTL…');
  const [objBuf, mtlBuf] = await Promise.all([download(meta.obj), download(meta.mtl)]);
  let mtl = mtlBuf.toString('utf8');

  const textures = meta.textures || [];
  log(`téléchargement de ${textures.length} textures…`);
  const texFiles = await Promise.all(textures.map(async (hash, i) => {
    const buf = await download(hash);
    return { hash, buf, name: `${signature}_tex${i}.${imageExt(buf)}` };
  }));
  // Le MTL référence les textures par hash : on remplace par nos noms de fichiers locaux
  for (const t of texFiles) mtl = mtl.split(t.hash).join(t.name);

  // Nettoie l'ancien avatar puis écrit le nouveau
  await mkdir(OUT, { recursive: true });
  for (const f of await readdir(OUT)) await rm(path.join(OUT, f), { force: true });

  await writeFile(path.join(OUT, 'avatar.obj'), objBuf);
  await writeFile(path.join(OUT, 'avatar.mtl'), mtl);
  for (const t of texFiles) await writeFile(path.join(OUT, t.name), t.buf);

  const thumb = await get2DThumb();
  if (thumb) await writeFile(path.join(OUT, 'avatar.png'), thumb);

  await writeFile(path.join(OUT, 'avatar.json'), JSON.stringify({
    userId: Number(USER_ID),
    updatedAt: new Date().toISOString(),
    signature,
    obj: 'avatar.obj',
    mtl: 'avatar.mtl',
    textures: texFiles.map(t => t.name),
    camera: meta.camera || null,
    aabb: meta.aabb || null,
    yawOffset: previous?.yawOffset || 0, // ajuste à la main si le perso n'est pas bien de face (radians)
  }, null, 2));

  log(`ok — avatar ${signature} écrit dans ${OUT}`);
}

main().catch(err => fail(err.message));
