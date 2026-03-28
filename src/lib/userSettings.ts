import { Logger, PlatformConfig } from 'homebridge';
import { SomneoPlatform } from '../somneoPlatform';
import { SomneoClock } from './somneoClock';
import { SomneoConfig, WebhookApiConfig, WebhookApiSettings } from './somneoConfigDataTypes';
import { SomneoConstants } from './somneoConstants';
export class UserSettings {

  private constructor(
    public PlatformName: string,
    public SomneoClocks: SomneoClock[],
    public PollingMilliSeconds: number,
    public WebhookApiSettings: WebhookApiSettings,
  ) { }

  static create(platform: SomneoPlatform): UserSettings {

    const config = platform.config;
    const platformName = UserSettings.buildPlatformName(config);
    const somneoClocks = UserSettings.buildSomneoClocks(platform.log, config);
    const pollingMilliseconds = UserSettings.buildPollingMilliSeconds(config);
    const webhookApiSettings = UserSettings.buildWebhookApiSettings(config);
    return new UserSettings(platformName, somneoClocks, pollingMilliseconds, webhookApiSettings);
  }

  private static buildPollingMilliSeconds(config: PlatformConfig): number {

    // If the user has not specified a polling interval, default to 30s
    const pollingSeconds = config.pollingSeconds ?? SomneoConstants.DEFAULT_POLLING_SECONDS;
    return pollingSeconds * 1000;
  }

  private static buildSomneoClocks(log: Logger, config: PlatformConfig): SomneoClock[] {

    // If the user has not specified clock configs, default to empty array
    if (config.somneos === undefined || config.somneos.length === 0) {
      return [];
    }

    return config.somneos
      .map((somneoConfig: SomneoConfig) => SomneoClock.create(log, somneoConfig))
      .filter((somneoClock: SomneoClock) => somneoClock !== undefined);
  }

  private static buildPlatformName(config: PlatformConfig): string {

    // If the user has not specified a platform name, default to Homebridge Somneo
    return config.name ?? SomneoConstants.DEFAULT_PLATFORM_NAME;
  }

  private static buildWebhookApiSettings(config: PlatformConfig): WebhookApiSettings {

    const webhookApiConfig = (config as PlatformConfig & { webhookApi?: WebhookApiConfig }).webhookApi;

    if (webhookApiConfig === undefined) {
      return {
        isEnabled: false,
        bindHost: SomneoConstants.DEFAULT_WEBHOOK_API_BIND_HOST,
        port: SomneoConstants.DEFAULT_WEBHOOK_API_PORT,
      };
    }

    const port = webhookApiConfig.port;
    const sanitizedPort = (port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535)
      ? port
      : SomneoConstants.DEFAULT_WEBHOOK_API_PORT;
    const token = webhookApiConfig.token?.trim();

    return {
      isEnabled: webhookApiConfig.isEnabled === true,
      bindHost: webhookApiConfig.bindHost?.trim() || SomneoConstants.DEFAULT_WEBHOOK_API_BIND_HOST,
      port: sanitizedPort,
      token: token === '' ? undefined : token,
    };
  }
}
