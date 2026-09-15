// ============================================================
// TikTok Unrepost Script — delete all TikTok reposts
// ============================================================

(() => {
const DRY_RUN = false;          // поставь true для тестового прогона
const PAUSE_MS = 300;           // пауза между батчами (мс)
const CONCURRENCY = 4;          // сколько удалений параллельно за раз
const PAGE_SIZE = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function deepFindSecUids(obj, found) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.secUid && obj.uniqueId) found.push({ secUid: obj.secUid, uniqueId: obj.uniqueId });
  for (const v of Object.values(obj)) deepFindSecUids(v, found);
}

async function getSecUid() {
  const nick = (location.pathname.match(/@([^/?]+)/) || [])[1];
  if (!nick) throw new Error('Похоже, это не страница профиля (нет @ника в URL).');

  for (const id of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE']) {
    const el = document.getElementById(id);
    if (!el) continue;
    try {
      const found = [];
      deepFindSecUids(JSON.parse(el.textContent), found);
      const exact = found.find((f) => f.uniqueId.toLowerCase() === nick.toLowerCase());
      if (exact) return exact.secUid;
      if (found.length) return found[0].secUid;
    } catch {}
  }

  const html = await (await fetch(location.pathname, { credentials: 'include' })).text();
  const esc = nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = html.match(new RegExp(`"secUid":"([^"]+)","uniqueId":"${esc}"`))
         || html.match(/"secUid":"(MS4wLjABAAAA[^"]+)"/);
  if (m) return m[1];

  throw new Error('secUid не найден. Сделай Ctrl+Shift+R и запусти скрипт снова.');
}

async function fetchRepostPage(secUid, cursor) {
  const url =
    '/api/repost/item_list/' +
    `?secUid=${encodeURIComponent(secUid)}` +
    `&count=${PAGE_SIZE}&cursor=${cursor}&aid=1988&app_language=ru&device_platform=web_pc`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`item_list HTTP ${res.status}`);
  const json = await res.json();
  return {
    items: (json.itemList || []).map((v) => ({ id: v.id, desc: (v.desc || '').slice(0, 60) })),
    hasMore: !!json.hasMore,
    cursor: json.cursor ?? cursor + PAGE_SIZE,
  };
}

async function unrepost(awemeId, retries = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`/tiktok/v1/upvote/delete?aid=1988&item_id=${awemeId}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (!res.ok || !json || json.status_code !== 0) {
        throw new Error(`upvote/delete HTTP ${res.status}: ${text.slice(0, 150)}`);
      }
      return true;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1500);
    }
  }
  throw lastErr;
}

(async () => {
  const secUid = await getSecUid();
  console.log(`secUid: ${secUid.slice(0, 12)}...`);

  let cursor = 0, hasMore = true, total = 0, deleted = 0, errors = 0;

  while (hasMore) {
    const page = await fetchRepostPage(secUid, cursor);
    console.log(`Страница: ${page.items.length} репостов (cursor=${cursor})`);

    if (page.items.length === 0) break;

    if (DRY_RUN) {
      for (const item of page.items) console.log(`[DRY RUN] удалил бы: ${item.id} — ${item.desc}`);
      total += page.items.length;
    } else {
      await pool(page.items, CONCURRENCY, async (item) => {
        total++;
        try {
          await unrepost(item.id);
          deleted++;
          console.log(`✅ ${deleted}/${total}: ${item.desc || item.id}`);
        } catch (e) {
          errors++;
          console.error(`❌ ${item.id}:`, e.message);
        }
      });
      if (errors >= 10) {
        console.warn('Слишком много ошибок — стоп (возможен рейт-лимит). Подожди пару минут и запусти снова.');
        return;
      }
      await sleep(PAUSE_MS);
    }

    hasMore = page.hasMore;
    cursor = page.cursor;
    await sleep(500);
  }

  console.log(`Готово. Репостов: ${total}, удалено: ${DRY_RUN ? 0 : deleted}, ошибок: ${errors}`);
})();
})();
