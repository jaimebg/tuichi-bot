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
            ['channel:read:redemptions', 'channel:read:subscriptions']
          )
        ).then(broadcasterId => { this._broadcasterId = broadcasterId; })
      );
    }
    this.authProvider.onRefresh((_userId, newTokenData) => {
      log('info', 'Twitch token refreshed automatically');
      this._latestTokenData = newTokenData;
    });
    this.api = new ApiClient({ authProvider: this.authProvider });
    this._latestTokenData = null;
    this._userId = null;
    this._broadcasterId = null;
  }

  /** Wait for token registration to complete. Call once at startup. */
  async ensureReady() { await this._ready; }

  /** Get the user ID that was registered with the auth provider. */
  getUserId() { return this._userId; }

  /** Get the current access token (for ws/EventSub that needs raw token). */
  async getAccessToken() {
    if (this._latestTokenData) return this._latestTokenData.accessToken;
    // Force a token check
    const tokenInfo = await this.authProvider.getAccessTokenForIntent('chat');
    return tokenInfo?.accessToken ?? null;
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
}
