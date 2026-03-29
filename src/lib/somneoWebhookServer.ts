import * as http from 'http';
import { Logger } from 'homebridge';
import { URL, URLSearchParams } from 'url';
import { SomneoClock } from './somneoClock';
import { WebhookApiSettings } from './somneoConfigDataTypes';
import { SomneoConstants } from './somneoConstants';
import { WakeAlarmSettings } from './somneoServiceDataTypes';

interface AlarmMutationRequest {
  clock?: string;
  enabled?: boolean;
  lightTheme?: number;
  powerWake?: boolean;
  powerWakeTime?: string;
  profileNumber?: number;
  snoozeMinutes?: number;
  sound?: string;
  soundSource?: string;
  sunriseMinutes?: number;
  time?: string;
  token?: string;
  volume?: number;
}

interface SimpleWakeAlarm {
  clock: string;
  enabled: boolean;
  host: string;
  lightTheme?: number;
  powerWakeEnabled: boolean;
  powerWakeTime?: string;
  profileNumber?: number;
  sound?: string;
  soundSource?: string;
  sunriseMinutes?: number;
  time?: string;
  volume?: number;
}

interface WebhookApiResponse {
  ok: boolean;
  action?: string;
  alarm?: SimpleWakeAlarm;
  availableClocks?: { host: string; name: string }[];
  basePath?: string;
  clock?: { host: string; name: string };
  deleteMode?: string;
  endpoints?: {
    body?: Record<string, unknown>;
    description: string;
    method: string;
    path: string;
  }[];
  error?: string;
  requiresToken?: boolean;
  snoozeMinutes?: number;
}

class WebhookBadRequestError extends Error {
}

export class SomneoWebhookServer {

  private static readonly BASE_PATH = '/somneo/v1';
  private static readonly JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
  private static readonly MAX_BODY_BYTES = 16 * 1024;

  private server?: http.Server;

  constructor(
    private readonly clocks: SomneoClock[],
    private readonly log: Logger,
    private readonly settings: WebhookApiSettings,
  ) { }

  start(): void {

    if (!this.settings.isEnabled || this.server !== undefined) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    this.server.on('error', error => {
      this.log.error(`Webhook API Error -> ${error.message}`);
    });

    this.server.listen(this.settings.port, this.settings.bindHost, () => {
      this.log.info(`Webhook API -> listening on http://${this.settings.bindHost}:${this.settings.port}${SomneoWebhookServer.BASE_PATH}`);
    });
  }

  stop(): void {

    if (this.server === undefined) {
      return;
    }

    this.server.close(error => {
      if (error !== undefined) {
        this.log.error(`Webhook API Error -> failed to close server: ${error.message}`);
        return;
      }

      this.log.debug('Webhook API -> server closed');
    });

    this.server = undefined;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {

    response.setHeader('Content-Type', SomneoWebhookServer.JSON_CONTENT_TYPE);
    response.setHeader('Cache-Control', 'no-store');

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    try {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const body = await this.readBody(request);
      const params = {
        ...this.convertSearchParamsToObject(requestUrl.searchParams),
        ...body,
      };

      const pathname = requestUrl.pathname.replace(/\/+$/, '') || '/';
      const method = request.method ?? 'GET';

      if (!pathname.startsWith(SomneoWebhookServer.BASE_PATH)) {
        this.writeJson(response, 404, { ok: false, error: 'Not found.' });
        return;
      }

      if (!this.isRequestAuthorized(request, params) && !this.isPublicPath(pathname)) {
        this.writeJson(response, 401, { ok: false, error: 'Unauthorized.' });
        return;
      }

      if (method === 'GET' && pathname === SomneoWebhookServer.BASE_PATH) {
        this.writeJson(response, 200, this.buildApiIndex());
        return;
      }

      if (method === 'GET' && pathname === `${SomneoWebhookServer.BASE_PATH}/health`) {
        this.writeJson(response, 200, {
          ok: true,
          action: 'health',
          basePath: SomneoWebhookServer.BASE_PATH,
          requiresToken: this.settings.token !== undefined,
        });
        return;
      }

      if (method === 'GET' && pathname === `${SomneoWebhookServer.BASE_PATH}/clocks`) {
        this.writeJson(response, 200, {
          ok: true,
          action: 'clocks',
          availableClocks: this.clocks.map(clock => ({ name: clock.Name, host: clock.SomneoService.Host })),
        });
        return;
      }

      if (method === 'GET' && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm`) {
        const clock = this.resolveClock(params);
        const alarm = await this.getAlarm(clock);
        this.writeJson(response, 200, { ok: true, action: 'getAlarm', alarm });
        return;
      }

      if ((method === 'POST' || method === 'PUT' || method === 'GET') && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm/set`) {
        const clock = this.resolveClock(params);
        const payload = this.parseAlarmMutationRequest(params);
        const alarm = await this.upsertAlarm(clock, payload);
        this.writeJson(response, 200, { ok: true, action: 'setAlarm', alarm });
        return;
      }

      if ((method === 'POST' || method === 'PUT') && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm`) {
        const clock = this.resolveClock(params);
        const payload = this.parseAlarmMutationRequest(params);
        const alarm = await this.upsertAlarm(clock, payload);
        this.writeJson(response, 200, { ok: true, action: 'setAlarm', alarm });
        return;
      }

      if ((method === 'POST' || method === 'GET') && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm/enable`) {
        const clock = this.resolveClock(params);
        const alarm = await this.setAlarmEnabled(clock, true, params);
        this.writeJson(response, 200, { ok: true, action: 'enableAlarm', alarm });
        return;
      }

      if ((method === 'POST' || method === 'GET') && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm/disable`) {
        const clock = this.resolveClock(params);
        const alarm = await this.setAlarmEnabled(clock, false, params);
        this.writeJson(response, 200, { ok: true, action: 'disableAlarm', alarm });
        return;
      }

      if ((method === 'POST' || method === 'GET') && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm/delete`) {
        const clock = this.resolveClock(params);
        const alarm = await this.setAlarmEnabled(clock, false, params);
        this.writeJson(response, 200, {
          ok: true,
          action: 'deleteAlarm',
          alarm,
          deleteMode: 'disableCurrentWakeProfile',
        });
        return;
      }

      if (method === 'DELETE' && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm`) {
        const clock = this.resolveClock(params);
        const alarm = await this.setAlarmEnabled(clock, false, params);
        this.writeJson(response, 200, {
          ok: true,
          action: 'deleteAlarm',
          alarm,
          deleteMode: 'disableCurrentWakeProfile',
        });
        return;
      }

      if ((method === 'POST' || method === 'GET') && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm/snooze`) {
        const clock = this.resolveClock(params);
        await clock.SomneoService.snoozeWakeAlarm();
        this.writeJson(response, 200, { ok: true, action: 'snoozeAlarm' });
        return;
      }

      if ((method === 'POST' || method === 'GET') && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm/dismiss`) {
        const clock = this.resolveClock(params);
        await clock.SomneoService.dismissWakeAlarm();
        this.writeJson(response, 200, { ok: true, action: 'dismissAlarm' });
        return;
      }

      if ((method === 'POST' || method === 'GET') && pathname === `${SomneoWebhookServer.BASE_PATH}/alarm/snooze-duration`) {
        const clock = this.resolveClock(params);
        const snoozeMinutes = this.getNumberValue(params, ['snoozeMinutes', 'minutes']);
        if (snoozeMinutes === undefined) {
          throw new WebhookBadRequestError('Missing snoozeMinutes.');
        }

        await clock.SomneoService.setWakeAlarmSnoozeDuration(snoozeMinutes);
        this.writeJson(response, 200, {
          ok: true,
          action: 'setSnoozeDuration',
          snoozeMinutes,
        });
        return;
      }

      this.writeJson(response, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
      this.handleError(error, response);
    }
  }

  private buildApiIndex(): WebhookApiResponse {
    return {
      ok: true,
      action: 'index',
      basePath: SomneoWebhookServer.BASE_PATH,
      requiresToken: this.settings.token !== undefined,
      endpoints: [
        {
          method: 'GET',
          path: `${SomneoWebhookServer.BASE_PATH}/health`,
          description: 'Health check for the local Somneo API server.',
        },
        {
          method: 'GET',
          path: `${SomneoWebhookServer.BASE_PATH}/clocks`,
          description: 'List configured Somneo clocks. Include token if one is configured.',
        },
        {
          method: 'GET',
          path: `${SomneoWebhookServer.BASE_PATH}/alarm?clock=Bedroom`,
          description: 'Read the current native Somneo wake alarm profile.',
        },
        {
          method: 'GET',
          path: `${SomneoWebhookServer.BASE_PATH}/alarm/set?time=07:00&clock=Bedroom`,
          description: 'Shortcut-friendly create or update endpoint. If time is set and enabled is omitted, the alarm is armed automatically.',
        },
        {
          method: 'POST',
          path: `${SomneoWebhookServer.BASE_PATH}/alarm`,
          description: 'Create or update the current wake alarm using a simple JSON body.',
          body: {
            clock: 'Bedroom',
            time: '07:00',
            enabled: true,
            sunriseMinutes: 30,
            lightTheme: 0,
            soundSource: 'wus',
            sound: '1',
            volume: 12,
            powerWake: false,
            powerWakeTime: '08:17',
          },
        },
        {
          method: 'POST',
          path: `${SomneoWebhookServer.BASE_PATH}/alarm/enable`,
          description: 'Arm the current Somneo wake alarm profile.',
          body: {
            clock: 'Bedroom',
          },
        },
        {
          method: 'POST',
          path: `${SomneoWebhookServer.BASE_PATH}/alarm/disable`,
          description: 'Disarm the current Somneo wake alarm profile.',
          body: {
            clock: 'Bedroom',
          },
        },
        {
          method: 'DELETE',
          path: `${SomneoWebhookServer.BASE_PATH}/alarm?clock=Bedroom`,
          description: 'Delete alias. This disables the current Somneo wake alarm profile and leaves its saved settings intact.',
        },
        {
          method: 'POST',
          path: `${SomneoWebhookServer.BASE_PATH}/alarm/snooze`,
          description: 'Send the native Somneo snooze action.',
          body: {
            clock: 'Bedroom',
          },
        },
        {
          method: 'POST',
          path: `${SomneoWebhookServer.BASE_PATH}/alarm/dismiss`,
          description: 'Send the native Somneo dismiss action.',
          body: {
            clock: 'Bedroom',
          },
        },
        {
          method: 'POST',
          path: `${SomneoWebhookServer.BASE_PATH}/alarm/snooze-duration`,
          description: 'Set the native Somneo snooze duration in minutes.',
          body: {
            clock: 'Bedroom',
            snoozeMinutes: 9,
          },
        },
      ],
    };
  }

  private convertSearchParamsToObject(searchParams: URLSearchParams): Record<string, unknown> {

    const params: Record<string, unknown> = {};
    searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return params;
  }

  private isPublicPath(pathname: string): boolean {
    return pathname === SomneoWebhookServer.BASE_PATH || pathname === `${SomneoWebhookServer.BASE_PATH}/health`;
  }

  private isRequestAuthorized(request: http.IncomingMessage, params: Record<string, unknown>): boolean {

    if (this.settings.token === undefined) {
      return true;
    }

    const requestToken = this.getTokenFromRequest(request, params);
    return requestToken === this.settings.token;
  }

  private getTokenFromRequest(request: http.IncomingMessage, params: Record<string, unknown>): string | undefined {

    const authorizationHeader = request.headers.authorization;
    if (authorizationHeader !== undefined && authorizationHeader.startsWith('Bearer ')) {
      return authorizationHeader.slice('Bearer '.length).trim();
    }

    const customHeader = request.headers['x-somneo-token'];
    if (typeof customHeader === 'string') {
      return customHeader.trim();
    }

    if (Array.isArray(customHeader) && customHeader.length > 0) {
      return customHeader[0].trim();
    }

    return this.getStringValue(params, ['token']);
  }

  private async readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {

    if (request.method === 'GET' || request.method === 'DELETE' || request.method === 'HEAD') {
      return {};
    }

    const chunks: Buffer[] = [];
    let byteCount = 0;

    for await (const chunk of request) {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += bufferChunk.length;

      if (byteCount > SomneoWebhookServer.MAX_BODY_BYTES) {
        throw new WebhookBadRequestError('Request body is too large.');
      }

      chunks.push(bufferChunk);
    }

    if (chunks.length === 0) {
      return {};
    }

    const rawBody = Buffer.concat(chunks).toString('utf8').trim();
    if (rawBody === '') {
      return {};
    }

    const contentType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

    if (contentType === 'application/x-www-form-urlencoded') {
      const formData = new URLSearchParams(rawBody);
      return this.convertSearchParamsToObject(formData);
    }

    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new WebhookBadRequestError('JSON body must be an object.');
      }

      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof WebhookBadRequestError) {
        throw error;
      }

      throw new WebhookBadRequestError('Request body must be valid JSON or form data.');
    }
  }

  private parseAlarmMutationRequest(params: Record<string, unknown>): AlarmMutationRequest {
    return {
      clock: this.getStringValue(params, ['clock', 'name', 'host']),
      enabled: this.getBooleanValue(params, ['enabled']),
      lightTheme: this.getNumberValue(params, ['lightTheme', 'ctype']),
      powerWake: this.getBooleanValue(params, ['powerWake', 'powerWakeEnabled']),
      powerWakeTime: this.getStringValue(params, ['powerWakeTime']),
      profileNumber: this.getNumberValue(params, ['profileNumber', 'prfnr']),
      snoozeMinutes: this.getNumberValue(params, ['snoozeMinutes', 'minutes']),
      sound: this.getStringValue(params, ['sound', 'soundChannel', 'sndch']),
      soundSource: this.getStringValue(params, ['soundSource', 'snddv']),
      sunriseMinutes: this.getNumberValue(params, ['sunriseMinutes', 'duration', 'durat']),
      time: this.getStringValue(params, ['time']),
      token: this.getStringValue(params, ['token']),
      volume: this.getNumberValue(params, ['volume', 'sndlv']),
    };
  }

  private async upsertAlarm(clock: SomneoClock, request: AlarmMutationRequest): Promise<SimpleWakeAlarm> {

    const currentSettings = await clock.SomneoService.getWakeAlarmSettings();
    const updatedSettings: WakeAlarmSettings = { ...currentSettings };
    let changed = false;

    if (request.time !== undefined) {
      const { hour, minute } = this.parseTime(request.time);
      updatedSettings.almhr = hour;
      updatedSettings.almmn = minute;
      changed = true;

      if (request.enabled === undefined) {
        updatedSettings.prfen = true;
      }
    }

    if (request.enabled !== undefined) {
      updatedSettings.prfen = request.enabled;
      changed = true;
    }

    if (request.profileNumber !== undefined) {
      updatedSettings.prfnr = request.profileNumber;
      changed = true;
    }

    if (request.sunriseMinutes !== undefined) {
      updatedSettings.durat = request.sunriseMinutes;
      changed = true;
    }

    if (request.lightTheme !== undefined) {
      updatedSettings.ctype = request.lightTheme;
      changed = true;
    }

    if (request.soundSource !== undefined) {
      updatedSettings.snddv = request.soundSource;
      changed = true;
    }

    if (request.sound !== undefined) {
      updatedSettings.sndch = request.sound;
      changed = true;
    }

    if (request.volume !== undefined) {
      updatedSettings.sndlv = request.volume;
      changed = true;
    }

    if (request.powerWake !== undefined) {
      updatedSettings.pwrsz = request.powerWake ? 1 : 0;
      changed = true;
    }

    if (request.powerWakeTime !== undefined) {
      const { hour, minute } = this.parseTime(request.powerWakeTime);
      updatedSettings.pszhr = hour;
      updatedSettings.pszmn = minute;
      changed = true;
    }

    if (!changed && request.snoozeMinutes === undefined) {
      throw new WebhookBadRequestError('No alarm changes were provided. Set at least one of: time, enabled, sunriseMinutes, lightTheme, soundSource, sound, volume, powerWake, powerWakeTime, or profileNumber.');
    }

    if (updatedSettings.prfnr === undefined) {
      updatedSettings.prfnr = SomneoConstants.DEFAULT_WAKE_ALARM_PROFILE_NUMBER;
    }

    if (changed) {
      await clock.SomneoService.setWakeAlarmSettings(updatedSettings);
    }

    if (request.snoozeMinutes !== undefined) {
      await clock.SomneoService.setWakeAlarmSnoozeDuration(request.snoozeMinutes);
    }

    const savedSettings = await clock.SomneoService.getWakeAlarmSettings();
    return this.buildSimpleWakeAlarm(clock, savedSettings);
  }

  private async setAlarmEnabled(
    clock: SomneoClock,
    enabled: boolean,
    params: Record<string, unknown>,
  ): Promise<SimpleWakeAlarm> {

    const profileNumber = this.getNumberValue(params, ['profileNumber', 'prfnr']);
    const currentSettings = await clock.SomneoService.getWakeAlarmSettings();
    const targetProfileNumber = profileNumber ?? currentSettings.prfnr ?? SomneoConstants.DEFAULT_WAKE_ALARM_PROFILE_NUMBER;

    await clock.SomneoService.updateWakeAlarmEnabled(targetProfileNumber, enabled);

    const savedSettings = await clock.SomneoService.getWakeAlarmSettings();
    return this.buildSimpleWakeAlarm(clock, savedSettings);
  }

  private async getAlarm(clock: SomneoClock): Promise<SimpleWakeAlarm> {
    const settings = await clock.SomneoService.getWakeAlarmSettings();
    return this.buildSimpleWakeAlarm(clock, settings);
  }

  private buildSimpleWakeAlarm(clock: SomneoClock, settings: WakeAlarmSettings): SimpleWakeAlarm {
    return {
      clock: clock.Name,
      enabled: settings.prfen === true,
      host: clock.SomneoService.Host,
      lightTheme: settings.ctype,
      powerWakeEnabled: settings.pwrsz === 1,
      powerWakeTime: this.formatTime(settings.pszhr, settings.pszmn),
      profileNumber: settings.prfnr,
      sound: settings.sndch,
      soundSource: settings.snddv,
      sunriseMinutes: settings.durat,
      time: this.formatTime(settings.almhr, settings.almmn),
      volume: settings.sndlv,
    };
  }

  private resolveClock(params: Record<string, unknown>): SomneoClock {

    const requestedClock = this.getStringValue(params, ['clock', 'name', 'host']);
    if (requestedClock === undefined) {
      if (this.clocks.length === 1) {
        return this.clocks[0];
      }

      throw new WebhookBadRequestError(`Multiple Somneo clocks are configured. Specify a clock by name or host. Available clocks: ${this.clocks.map(clock => `${clock.Name} (${clock.SomneoService.Host})`).join(', ')}`);
    }

    const normalizedClock = requestedClock.trim().toLowerCase();
    const matchingClocks = this.clocks.filter(clock =>
      clock.Name.trim().toLowerCase() === normalizedClock ||
      clock.SomneoService.Host.trim().toLowerCase() === normalizedClock);

    if (matchingClocks.length === 0) {
      throw new WebhookBadRequestError(`Unknown clock "${requestedClock}". Available clocks: ${this.clocks.map(clock => `${clock.Name} (${clock.SomneoService.Host})`).join(', ')}`);
    }

    return matchingClocks[0];
  }

  private getStringValue(params: Record<string, unknown>, keys: string[]): string | undefined {

    for (const key of keys) {
      const value = params[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim();
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
    }

    return undefined;
  }

  private getNumberValue(params: Record<string, unknown>, keys: string[]): number | undefined {

    for (const key of keys) {
      const value = params[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }

      if (typeof value === 'string' && value.trim() !== '') {
        const numericValue = Number(value);
        if (Number.isFinite(numericValue)) {
          return numericValue;
        }
      }
    }

    return undefined;
  }

  private getBooleanValue(params: Record<string, unknown>, keys: string[]): boolean | undefined {

    for (const key of keys) {
      const value = params[key];
      if (typeof value === 'boolean') {
        return value;
      }

      if (typeof value === 'number') {
        return value !== 0;
      }

      if (typeof value === 'string') {
        const normalizedValue = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalizedValue)) {
          return true;
        }

        if (['false', '0', 'no', 'off'].includes(normalizedValue)) {
          return false;
        }
      }
    }

    return undefined;
  }

  private parseTime(time: string): { hour: number; minute: number } {

    const trimmedTime = time.trim();
    const twentyFourHourMatch = trimmedTime.match(/^(\d{1,2}):(\d{2})$/);
    if (twentyFourHourMatch !== null) {
      const hour = Number(twentyFourHourMatch[1]);
      const minute = Number(twentyFourHourMatch[2]);

      if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw new WebhookBadRequestError(`Invalid time "${time}". Use HH:MM or h:MM AM/PM.`);
      }

      return { hour, minute };
    }

    const twelveHourMatch = trimmedTime.match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
    if (twelveHourMatch !== null) {
      const twelveHour = Number(twelveHourMatch[1]);
      const minute = Number(twelveHourMatch[2] ?? '0');
      const meridiem = twelveHourMatch[3].toUpperCase();

      if (!Number.isInteger(twelveHour) || !Number.isInteger(minute) || twelveHour < 1 || twelveHour > 12 || minute < 0 || minute > 59) {
        throw new WebhookBadRequestError(`Invalid time "${time}". Use HH:MM or h:MM AM/PM.`);
      }

      const normalizedHour = meridiem === 'AM'
        ? (twelveHour === 12 ? 0 : twelveHour)
        : (twelveHour === 12 ? 12 : twelveHour + 12);

      return { hour: normalizedHour, minute };
    }

    throw new WebhookBadRequestError(`Invalid time "${time}". Use HH:MM or h:MM AM/PM.`);
  }

  private formatTime(hour?: number, minute?: number): string | undefined {

    if (hour === undefined || minute === undefined) {
      return undefined;
    }

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  private writeJson(response: http.ServerResponse, statusCode: number, body: WebhookApiResponse): void {
    response.statusCode = statusCode;
    response.end(JSON.stringify(body, null, 2));
  }

  private handleError(error: unknown, response: http.ServerResponse): void {

    if (error instanceof WebhookBadRequestError) {
      this.writeJson(response, 400, { ok: false, error: error.message });
      return;
    }

    if (error instanceof Error) {
      this.log.error(`Webhook API Error -> ${error.message}`);
      this.writeJson(response, 500, { ok: false, error: error.message });
      return;
    }

    this.log.error(`Webhook API Error -> ${String(error)}`);
    this.writeJson(response, 500, { ok: false, error: 'Unexpected error.' });
  }
}
