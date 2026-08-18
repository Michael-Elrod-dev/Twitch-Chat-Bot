import type { UpdateSettingsRequest } from '@almosthadai/shared';

/**
 * What a settings pane asks the shell to save.
 *
 * The contract's own request type, never `Partial<ChannelSettings>`. The two are
 * deliberately different shapes and conflating them is what forces casts. The
 * clearest case is the webhook: the response carries
 * `discordWebhookConfigured: boolean` and the request carries
 * `discordWebhookUrl: string | null`, because one of them is a fact you may read
 * and the other is a capability you may only write. A `Partial<ChannelSettings>`
 * has no field a pane could use to set one, which is exactly right and is why the
 * patch type has to be the request.
 *
 * **An empty patch means "re-read, do not write".** The songs screens need it
 * after a Spotify disconnect: the server switches song requests off as part of
 * unlinking, so the shell's copy of the settings is stale the moment that
 * succeeds, and guessing which fields moved would be inventing the response. The
 * shell fetches `/me` instead of sending a body the schema would reject for being
 * empty.
 */
export type SettingsPatch = UpdateSettingsRequest | Record<string, never>;
