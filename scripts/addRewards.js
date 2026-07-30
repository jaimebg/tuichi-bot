import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TwitchApi } from '../src/twitch/twitchApi.js';
import { resolveResourcePath } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const TWITCH_MAX_REWARDS = 50;
const TWITCH_MAX_TITLE_LENGTH = 45;

/**
 * Resuelve mediaRewards.json igual que src/config.js: fichero real primero,
 * luego su plantilla .example, avisando si cae a la plantilla. Sin esto, un
 * clon recién hecho que ejecute `npm run add-rewards` antes de crear el
 * fichero real muere con un ENOENT crudo -- el mismo fallo que este resolver
 * ya elimina para el resto del bot.
 */
function resolveMediaRewardsReadPath() {
  const resolved = resolveResourcePath(RESOURCES_DIR, 'mediaRewards.json');
  if (!resolved) return path.join(RESOURCES_DIR, 'mediaRewards.json');
  if (resolved.isExample) {
    console.warn(`Usando ${path.basename(resolved.path)} como plantilla. Crea resources/mediaRewards.json para personalizarlo.`);
  }
  return resolved.path;
}

// El fichero se LEE del real o, en su ausencia, de la plantilla .example.
// Pero SIEMPRE se ESCRIBE en la ruta real: este script anota `live`/`rewardId`
// en el fichero tras sincronizar con Twitch, y hacerlo contra la plantilla
// mutaría silenciosamente un fichero versionado en git en vez de materializar
// el fichero real de quien clona.
const mediaRewardsReadPath = resolveMediaRewardsReadPath();
const mediaRewardsWritePath = path.join(RESOURCES_DIR, 'mediaRewards.json');

async function fetchRewards(broadcasterId, token) {
  const res = await fetch(
    `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`,
    { headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Failed to get rewards: ${res.status}`);
  return (await res.json()).data || [];
}

async function createReward(broadcasterId, token, reward) {
  const res = await fetch(
    `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`,
    {
      method: 'POST',
      headers: {
        'Client-Id': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: reward.title,
        cost: reward.cost || 100,
        is_enabled: true,
        is_user_input_required: reward.requiresInput || false,
        prompt: reward.prompt || ''
      })
    }
  );
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`${res.status} ${error}`);
  }
  return (await res.json()).data?.[0]?.id;
}

async function deleteReward(broadcasterId, token, rewardId) {
  const res = await fetch(
    `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`,
    {
      method: 'DELETE',
      headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` }
    }
  );
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`${res.status} ${error}`);
  }
}

async function main() {
  const twitchApi = new TwitchApi({
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    accessToken: process.env.TWITCH_API_TOKEN,
    refreshToken: process.env.TWITCH_REFRESH_TOKEN,
    broadcasterToken: process.env.TWITCH_BROADCASTER_TOKEN,
    broadcasterRefreshToken: process.env.TWITCH_BROADCASTER_REFRESH_TOKEN
  });
  await twitchApi.ensureReady();

  const user = await twitchApi.getUserByName(process.env.TWITCH_CHANNEL);
  if (!user) throw new Error('Could not resolve broadcaster');
  const broadcasterId = user.id;

  const token = await twitchApi.getBroadcasterAccessToken();
  if (!token) {
    throw new Error('Broadcaster token required. Set TWITCH_BROADCASTER_TOKEN and TWITCH_BROADCASTER_REFRESH_TOKEN in .env');
  }

  const rewardsData = JSON.parse(fs.readFileSync(mediaRewardsReadPath, 'utf8'));
  const rewards = rewardsData.rewards || [];

  // Validate: sync_to_twitch=true cannot exceed limit
  const wantSync = rewards.filter(r => r.sync_to_twitch);
  if (wantSync.length > TWITCH_MAX_REWARDS) {
    console.error(`Error: ${wantSync.length} rewards have sync_to_twitch=true but Twitch limit is ${TWITCH_MAX_REWARDS}.`);
    console.error(`Disable ${wantSync.length - TWITCH_MAX_REWARDS} rewards in mediaRewards.json and try again.`);
    process.exit(1);
  }

  // Validate: titles
  const badTitles = wantSync.filter(r => r.title.length > TWITCH_MAX_TITLE_LENGTH);
  if (badTitles.length) {
    console.error(`Error: ${badTitles.length} rewards with sync_to_twitch=true have titles > ${TWITCH_MAX_TITLE_LENGTH} chars:`);
    badTitles.forEach(r => console.error(`  [${r.title.length}] ${r.title}`));
    process.exit(1);
  }

  const existingRewards = await fetchRewards(broadcasterId, token);
  const existingByTitle = new Map(existingRewards.map(r => [r.title, r]));
  let liveCount = existingRewards.length;

  console.log(`Twitch: ${liveCount}/${TWITCH_MAX_REWARDS} live | File: ${rewards.length} total, ${wantSync.length} sync_to_twitch=true\n`);

  let created = 0, deleted = 0, unchanged = 0;

  // Pass 1: delete rewards that should not be on Twitch
  for (const reward of rewards) {
    if (!reward.title) continue;
    const existing = existingByTitle.get(reward.title);
    if (reward.sync_to_twitch || !existing) continue;
    try {
      await deleteReward(broadcasterId, token, existing.id);
      reward.live = false;
      delete reward.rewardId;
      liveCount--;
      deleted++;
      console.log(`  - DEL   ${reward.title} (${existing.id})`);
    } catch (err) {
      reward.live = true;
      reward.rewardId = existing.id;
      console.warn(`  ✗ FAIL  could not delete ${reward.title}: ${err.message}`);
    }
  }

  // Pass 2: create/sync rewards that should be on Twitch, mark the rest as off
  for (const reward of rewards) {
    if (!reward.title) continue;
    const existing = existingByTitle.get(reward.title);

    if (reward.sync_to_twitch) {
      if (existing) {
        reward.rewardId = existing.id;
        reward.live = true;
        unchanged++;
        console.log(`  ✓ LIVE  ${reward.title}`);
      } else {
        try {
          const newId = await createReward(broadcasterId, token, reward);
          reward.rewardId = newId;
          reward.live = true;
          liveCount++;
          created++;
          console.log(`  + NEW   ${reward.title} (${newId})`);
        } catch (err) {
          reward.live = false;
          delete reward.rewardId;
          console.warn(`  ✗ FAIL  ${reward.title}: ${err.message}`);
        }
      }
    } else if (!existing) {
      reward.live = false;
      delete reward.rewardId;
    }
  }

  fs.writeFileSync(mediaRewardsWritePath, JSON.stringify(rewardsData, null, 2));

  const liveLocal = rewards.filter(r => r.live).length;
  console.log(`\n--- Summary ---`);
  console.log(`Live on Twitch: ${liveLocal}/${TWITCH_MAX_REWARDS}`);
  console.log(`Created: ${created} | Deleted: ${deleted} | Unchanged: ${unchanged}`);
  console.log(`Slots available: ${TWITCH_MAX_REWARDS - liveLocal}`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
