import { HttpClient } from './http.js';
import { getSetting } from '../settings.js';

export interface MediaStream {
  Index: number;
  Type: string;
  Language?: string;
  DisplayTitle?: string;
  IsExternal?: boolean;
  IsForced?: boolean;
  IsHearingImpaired?: boolean;
}
export interface NowPlaying {
  Id: string;
  Name: string;
  Type: 'Movie' | 'Episode' | string;
  Path?: string;
  ProductionYear?: number;
  SeriesId?: string;
  SeriesName?: string;
  ParentIndexNumber?: number; // season
  IndexNumber?: number; // episode
  ProviderIds?: Record<string, string>;
  MediaStreams?: MediaStream[];
}
export interface JfSession {
  Id: string;
  UserId: string;
  UserName: string;
  DeviceName?: string;
  Client?: string;
  NowPlayingItem?: NowPlaying;
  PlayState?: { SubtitleStreamIndex?: number; PositionTicks?: number };
}
export interface JfUser {
  Id: string;
  Name: string;
}

const http = new HttpClient('Jellyfin', () => getSetting('jellyfin.url'), () => ({
  Authorization: `MediaBrowser Token="${getSetting('jellyfin.apiKey')}"`,
  'X-Emby-Token': getSetting('jellyfin.apiKey'),
}));

export const jellyfin = {
  configured: () => http.configured,
  ping: () => http.request<{ ServerName: string; Version: string }>('/System/Info'),
  users: () => http.request<JfUser[]>('/Users'),
  async findUser(name: string) {
    const users = await this.users();
    return users.find((u) => u.Name.toLowerCase() === name.trim().toLowerCase());
  },
  async nowPlaying(userId: string): Promise<JfSession | undefined> {
    const sessions = await http.request<JfSession[]>('/Sessions');
    return sessions.find((s) => s.UserId === userId && s.NowPlayingItem);
  },
  async allNowPlaying() {
    const sessions = await http.request<JfSession[]>('/Sessions');
    return sessions.filter((s) => s.NowPlayingItem);
  },
  async item(id: string) {
    const r = await http.request<{ Items: NowPlaying[] }>('/Items', { query: { Ids: id, Fields: 'ProviderIds,Path' } });
    return r.Items[0];
  },
};
