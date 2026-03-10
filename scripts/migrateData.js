import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/persistence/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_DIR = path.join(ROOT, 'resources', 'users');

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (value.__type === 'Map') return new Map(value.__data);
      if (value.__type === 'Set') return new Set(value.__data);
    }
    return value;
  });
}

function migrate() {
  const dbPath = path.join(DATA_DIR, 'tuichi.db');
  console.log(`Migrating data to ${dbPath}...`);
  const db = new Database(dbPath);

  // 1. User Memory
  const userMemData = loadJson(path.join(DATA_DIR, 'userMemory.json'));
  if (userMemData?.memories) {
    const memories = userMemData.memories instanceof Map
      ? userMemData.memories : new Map(Object.entries(userMemData.memories));
    let count = 0;
    for (const [userKey, userData] of memories) {
      const eng = userData.engagementPattern || {};
      const commonWords = eng.commonWords instanceof Map
        ? Object.fromEntries(eng.commonWords) : (eng.commonWords || {});
      const activeHours = eng.activeHours instanceof Set
        ? [...eng.activeHours] : (Array.isArray(eng.activeHours) ? eng.activeHours : []);
      db.users.upsert({
        userId: userKey,
        displayName: userData.metadata?.displayName || null,
        personalityTraits: userData.personality || [],
        conversationThemes: userData.conversationThemes || [],
        topWords: commonWords,
        messageCount: eng.totalMessages || 0,
        avgMessageLength: eng.averageLength || 0,
        activeHours
      });
      count++;
    }
    console.log(`  Migrated ${count} user memories`);
  }

  // 2. Recent Chat
  const chatData = loadJson(path.join(DATA_DIR, 'recentChat.json'));
  if (chatData?.messages) {
    for (const msg of chatData.messages) {
      db.chat.addMessage(msg.userKey, msg.displayName, msg.message);
    }
    console.log(`  Migrated ${chatData.messages.length} recent chat messages`);
  }

  // 3. Conversation Threads
  const threadsData = loadJson(path.join(DATA_DIR, 'conversationThreads.json'));
  if (threadsData?.threads) {
    const threads = threadsData.threads instanceof Map
      ? threadsData.threads : new Map(Object.entries(threadsData.threads));
    const userThreads = threadsData.userThreads instanceof Map
      ? threadsData.userThreads : new Map(Object.entries(threadsData.userThreads || {}));
    for (const [userKey, threadId] of userThreads) {
      const messages = threads.get(String(threadId)) || threads.get(Number(threadId)) || [];
      if (messages.length > 0) {
        db.threads.upsert(userKey, messages);
      }
    }
    console.log(`  Migrated ${userThreads.size} conversation threads`);
  }

  // 4. Bot State
  const botState = loadJson(path.join(DATA_DIR, 'botState.json'));
  if (botState) {
    if (botState.greetedUsers) {
      db.state.set('greetedUsers', JSON.stringify(botState.greetedUsers));
    }
    if (botState.greetingsEnabled !== undefined) {
      db.state.set('greetingsEnabled', String(botState.greetingsEnabled));
    }
    console.log('  Migrated bot state');
  }

  // 5. User Context Profiles
  if (fs.existsSync(USERS_DIR)) {
    let count = 0;
    for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profilePath = path.join(USERS_DIR, entry.name, 'profile.json');
      if (!fs.existsSync(profilePath)) continue;
      try {
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        db.context.upsert({
          userId: entry.name.toLowerCase(),
          displayName: profile.displayName,
          firstSeen: profile.firstSeen ? new Date(profile.firstSeen).toISOString() : null,
          lastSeen: profile.lastSeen ? new Date(profile.lastSeen).toISOString() : null,
          messageCount: profile.messageCount,
          avgMessageLength: profile.averageLength,
          activeHours: profile.activeHours,
          personality: profile.personality,
          themes: profile.themes,
          topWords: profile.topWords,
          recentCommands: profile.commands,
          preferences: profile.preferences,
          metadata: profile.metadata
        });
        count++;
      } catch (err) {
        console.warn(`  Warning: failed to migrate profile ${entry.name}: ${err.message}`);
      }
    }
    console.log(`  Migrated ${count} user context profiles`);
  }

  db.close();
  console.log('Migration complete!');
}

migrate();
