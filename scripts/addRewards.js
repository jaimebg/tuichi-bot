import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TwitchApi } from '../src/twitch/twitchApi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaRewardsPath = path.join(__dirname, '..', 'resources', 'mediaRewards.json');

async function main() {
  const twitchApi = new TwitchApi({
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    accessToken: process.env.TWITCH_API_TOKEN,
    refreshToken: process.env.TWITCH_REFRESH_TOKEN
  });
  await twitchApi.ensureReady();

  const user = await twitchApi.getUserByName(process.env.TWITCH_CHANNEL);
  if (!user) throw new Error('Could not resolve broadcaster');
  const broadcasterId = user.id;
  console.log(`Broadcaster ID: ${broadcasterId}`);

  const rewardsData = JSON.parse(fs.readFileSync(mediaRewardsPath, 'utf8'));

  // Get existing rewards from Twitch
  const token = await twitchApi.getAccessToken();
  const existingResponse = await fetch(
    `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`,
    {
      headers: {
        'Client-Id': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      }
    }
  );
  if (!existingResponse.ok) {
    throw new Error(`Failed to get existing rewards: ${existingResponse.status}`);
  }
  const existingPayload = await existingResponse.json();
  const existingRewards = existingPayload.data || [];
  const existingByTitle = new Map(existingRewards.map(r => [r.title, r]));

  console.log(`Found ${existingRewards.length} existing rewards on Twitch`);

  // Sync rewards
  for (const reward of rewardsData.rewards || []) {
    if (!reward.title) continue;
    const existing = existingByTitle.get(reward.title);

    if (existing) {
      // Update reward ID in local data
      reward.rewardId = existing.id;
      console.log(`  ✓ ${reward.title} already exists (${existing.id})`);
    } else {
      // Create new reward
      const createToken = await twitchApi.getAccessToken();
      const body = {
        title: reward.title,
        cost: reward.cost || 100,
        is_enabled: true,
        is_user_input_required: reward.requiresInput || false,
        prompt: reward.prompt || ''
      };

      const createResponse = await fetch(
        `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`,
        {
          method: 'POST',
          headers: {
            'Client-Id': process.env.TWITCH_CLIENT_ID,
            'Authorization': `Bearer ${createToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }
      );

      if (createResponse.ok) {
        const createPayload = await createResponse.json();
        const newId = createPayload.data?.[0]?.id;
        reward.rewardId = newId;
        console.log(`  + Created ${reward.title} (${newId})`);
      } else {
        const error = await createResponse.text();
        console.warn(`  ✗ Failed to create ${reward.title}: ${createResponse.status} ${error}`);
      }
    }
  }

  fs.writeFileSync(mediaRewardsPath, JSON.stringify(rewardsData, null, 2));
  console.log('Updated mediaRewards.json');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
