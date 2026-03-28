import { SomneoConstants } from './somneoConstants';
import { WakeAlarmSettings } from './somneoServiceDataTypes';
import { SomneoSwitchAccessory } from './somneoSwitchAccessory';

export class SomneoWakeAlarmSwitchAccessory extends SomneoSwitchAccessory {

  private wakeAlarmSettings: WakeAlarmSettings | undefined;

  protected getName(): string {
    return `${this.somneoClock.Name} ${SomneoConstants.SWITCH_WAKE_ALARM}`;
  }

  async updateValues(): Promise<void> {

    return this.somneoClock.SomneoService.getWakeAlarmSettings()
      .then(wakeAlarmSettings => {
        if (wakeAlarmSettings === undefined) {
          return;
        }

        this.wakeAlarmSettings = wakeAlarmSettings;

        if (wakeAlarmSettings.prfen !== undefined) {
          this.isOn = wakeAlarmSettings.prfen;
          this.getBinaryService()
            .getCharacteristic(this.getBinaryCharacteristic())
            .updateValue(this.isOn);
        }

        this.hasGetError = false;
      }).catch(err => {
        this.platform.log.error(`Error -> Updating accessory=${this.name} err=${err}`);
        this.hasGetError = true;
      });
  }

  protected async modifySomneoServiceState(isOn: boolean): Promise<void> {

    const profileNumber = this.wakeAlarmSettings?.prfnr ?? (await this.somneoClock.SomneoService.getWakeAlarmSettings()).prfnr;
    if (profileNumber === undefined) {
      throw new Error('Wake alarm profile number unavailable');
    }

    await this.somneoClock.SomneoService.updateWakeAlarmEnabled(profileNumber, isOn);
    this.wakeAlarmSettings = { ...this.wakeAlarmSettings, prfen: isOn, prfnr: profileNumber };
  }

  protected turnOffConflictingAccessories(): Promise<void> {
    return Promise.resolve();
  }
}
