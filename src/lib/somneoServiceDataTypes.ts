export interface AudioDeviceSettings {
  onoff?: boolean;
  tempy?: boolean;
  sdvol?: number;
  snddv?: string;
  sndch?: string;
  sndss?: number;
}

export interface LightSettings {
  onoff?: boolean;
  tempy?: boolean;
  ltlvl?: number;
  ngtlt?: boolean;
}

export interface RelaxBreatheProgramSettings {
  onoff?: boolean;
  progr?: number;
  durat?: number;
  rtype?: number;
  intny?: number;
  sndlv?: number;
}

export interface SensorReadings {
  mslux?: number;
  mstmp?: number;
  msrhu?: number;
}

export interface SunsetProgramSettings {
  onoff?: boolean;
  durat?: number;
  curve?: number;
  ctype?: string;
  sndch?: string;
  snddv?: string;
  sndlv?: number;
  sndss?: number;
}

export interface WakeAlarmSettings {
  prfnr?: number;
  prfen?: boolean;
  prfvs?: boolean;
  pname?: string;
  ayear?: number;
  amnth?: number;
  alday?: number;
  daynm?: number;
  almhr?: number;
  almmn?: number;
  curve?: number;
  durat?: number;
  ctype?: number;
  snddv?: string;
  sndch?: string;
  sndlv?: number;
  sndss?: number;
  pwrsz?: number;
  pszhr?: number;
  pszmn?: number;
}

export interface WakeAlarmRootSettings {
  snztm?: number;
  prfnr?: number;
  prfen?: boolean;
}

export interface WakeAlarmControl {
  tapsz?: boolean;
  disms?: boolean;
}
