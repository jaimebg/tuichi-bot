import { RefreshingAuthProvider } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { log } from '../logger.js';

/**
 * Shared Twitch auth + API layer. Standalone (no Bot dependency).
 */
export class TwitchApi {
  /**
   * @param {{ clientId, clientSecret, accessToken, refreshToken, broadcasterToken?, broadcasterRefreshToken? }} config
   */
  constructor({ clientId, clientSecret, accessToken, refreshToken, broadcasterToken, broadcasterRefreshToken }) {
    this.authProvider = new RefreshingAuthProvider({ clientId, clientSecret });
    // addUserForToken may return a string or Promise<string> depending on
    // @twurple version. Wrap in Promise.resolve to handle both cases.
    this._ready = Promise.resolve(
      this.authProvider.addUserForToken(
        { accessToken, refreshToken, expiresIn: 0, obtainmentTimestamp: 0 },
        ['chat']
      )
    ).then(userId => { this._userId = userId; });
    // Register broadcaster token for EventSub subscriptions (channel points, stream events)
    if (broadcasterToken && broadcasterRefreshToken) {
      this._ready = this._ready.then(() =>
        Promise.resolve(
          this.authProvider.addUserForToken(
            { accessToken: broadcasterToken, refreshToken: broadcasterRefreshToken, expiresIn: 0, obtainmentTimestamp: 0 },
            ['channel:read:redemptions', 'channel:read:subscriptions', 'moderator:read:chatters']
          )
        ).then(broadcasterId => { this._broadcasterId = broadcasterId; })
      );
    }
    this.authProvider.onRefresh(() => {
      log('info', 'Twitch token refreshed automatically');
    });
    this.api = new ApiClient({ authProvider: this.authProvider });
    this._userId = null;
    this._broadcasterId = null;
    this._channelId = null;
  }

  /** Wait for token registration to complete. Call once at startup. */
  async ensureReady() { await this._ready; }

  /** Get the user ID that was registered with the auth provider. */
  getUserId() { return this._userId; }

  /**
   * Get the bot's current access token. Always goes through the auth provider,
   * which refreshes it once expired; never cache the raw token here.
   */
  async getAccessToken() {
    const tokenInfo = await this.authProvider.getAccessTokenForIntent('chat');
    return tokenInfo?.accessToken ?? null;
  }

  /** Get the broadcaster access token (for channel points, subscriptions). */
  async getBroadcasterAccessToken() {
    if (!this._broadcasterId) return null;
    const tokenInfo = await this.authProvider.getAccessTokenForUser(this._broadcasterId);
    return tokenInfo?.accessToken ?? null;
  }

  /**
   * Force-refresh the broadcaster token, for when Twitch rejects one that has
   * not reached its expiry yet. Returns null if there is no broadcaster token
   * or the refresh fails (e.g. the refresh token was revoked).
   */
  async refreshBroadcasterAccessToken() {
    if (!this._broadcasterId) return null;
    try {
      const tokenInfo = await this.authProvider.refreshAccessTokenForUser(this._broadcasterId);
      return tokenInfo?.accessToken ?? null;
    } catch (err) {
      log('warn', `Broadcaster token refresh failed: ${err.message}`);
      return null;
    }
  }

  /** Get user by login name. Returns { id, displayName } or null. */
  async getUserByName(login) {
    const user = await this.api.users.getUserByName(login);
    if (!user) return null;
    return { id: user.id, displayName: user.displayName };
  }

  /** Get stream info. Returns { title, gameName, startedAt } or null if offline. */
  async getStreamByUserName(login) {
    const stream = await this.api.streams.getStreamByUserName(login);
    if (!stream) return null;
    return {
      title: stream.title,
      gameName: stream.gameName,
      startedAt: stream.startDate?.toISOString() ?? new Date().toISOString(),
      viewerCount: stream.viewers
    };
  }

  /** Get channel info by broadcaster ID. */
  async getChannelInfo(broadcasterId) {
    const channel = await this.api.channels.getChannelInfoById(broadcasterId);
    if (!channel) return null;
    return { title: channel.title, gameName: channel.gameName };
  }

  /**
   * Get the list of users currently connected to the channel's chat session.
   * Uses the broadcaster token (which must carry the `moderator:read:chatters` scope).
   * Returns an array of { userId, userName, displayName }, or null if the channel
   * can't be resolved. Throws on API/auth errors so the caller can react.
   */
  async getChatters(channelLogin) {
    if (!this._channelId) {
      const user = await this.api.users.getUserByName(channelLogin);
      if (!user) return null;
      this._channelId = user.id;
    }
    const result = await this.api.chat.getChatters(this._channelId, { limit: 1000 });
    return (result?.data ?? []).map(c => ({
      userId: c.userId,
      userName: c.userName,
      displayName: c.userDisplayName
    }));
  }
}
