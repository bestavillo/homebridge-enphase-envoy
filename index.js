'use strict';

const fs = require('fs');
const axios = require('axios');
const path = require('path');

const PLUGIN_NAME = 'homebridge-enphase-envoy';
const PLATFORM_NAME = 'enphaseEnvoy';

let Accessory, Characteristic, Service, Categories, UUID;

module.exports = (api) => {
  Accessory = api.platformAccessory;
  Characteristic = api.hap.Characteristic;
  Service = api.hap.Service;
  Categories = api.hap.Categories;
  UUID = api.hap.uuid;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, envoyPlatform, true);
}

class envoyPlatform {
  constructor(log, config, api) {
    // only load if configured
    if (!config || !Array.isArray(config.devices)) {
      log('No configuration found for %s', PLUGIN_NAME);
      return;
    }
    this.log = log;
    this.config = config;
    this.api = api;
    this.devices = config.devices || [];
    this.accessories = [];

    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching');
      for (let i = 0, len = this.devices.length; i < len; i++) {
        let deviceName = this.devices[i];
        if (!deviceName.name) {
          this.log.warn('Device Name Missing')
        } else {
          this.accessories.push(new envoyDevice(this.log, deviceName, this.api));
        }
      }
    });
  }

  configureAccessory(accessory) {
    this.log.debug('configureAccessory');
    this.accessories.push(accessory);
  }

  removeAccessory(accessory) {
    this.log.debug('removeAccessory');
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }
}

class envoyDevice {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config;


    //device configuration
    this.name = config.name;
    this.host = config.host;
    this.refreshInterval = config.refreshInterval || 30;
    this.maxPowerDetected = config.maxPowerDetected;

    //get Device info
    this.manufacturer = config.manufacturer || 'Enphase';
    this.modelName = config.modelName || 'Envoy-S';
    this.serialNumber = config.serialNumber || 'SN0000005';
    this.firmwareRevision = config.firmwareRevision || 'FW0000005';

    //setup variables
    this.connectionStatus = false;
    this.currentProductionPower = 0;
    this.maxProductionPower = 0;
    this.totalConsumptionPower = 0;
    this.netConsumptionPower = 0;
    this.url = 'http://' + this.host;

    //Check net state
    setInterval(function () {
      axios.get(this.url + '/production.json').then(response => {
        this.log.debug('Device %s %s, get device status data: %s', this.host, this.name, response.data);
        this.deviceStatusInfo = response;
        if (!this.connectionStatus) {
          this.log.info('Device: %s %s, state: Online.', this.host, this.name);
          this.connectionStatus = true;
          setTimeout(this.getDeviceInfo.bind(this), 350);
        } else {
          this.getDeviceState();
        }
      }).catch(error => {
        this.log.debug('Device: %s %s, state: Offline.', this.host, this.name);
        this.connectionStatus = false;
        return;
      });
    }.bind(this), this.refreshInterval * 1000);

    //Delay to wait for device info before publish
    setTimeout(this.prepareEnvoyService.bind(this), 1500);
  }

  getDeviceInfo() {
    var me = this;
    me.log.debug('Device: %s %s, requesting config information.', me.host, me.name);
    let response = me.deviceStatusInfo;
    let inverters = response.data.production[0].activeCount;
    me.log('-------- %s --------', me.name);
    me.log('Manufacturer: %s', me.manufacturer);
    me.log('Model: %s', me.modelName);
    me.log('Firmware: %s', me.firmwareRevision);
    me.log('Inverters: %s', inverters);
    me.log('----------------------------------');
  }

  getDeviceState() {
    var me = this;
    let response = me.deviceStatusInfo;
    let productionPower = response.data.production[1].wNow;
    let totalConsumptionPower = response.data.consumption[0].wNow;
    let netConsumptionPower = response.data.consumption[1].wNow;
    if (productionPower > me.maxProductionPower) {
       me.maxProductionPower = productionPower;
      }

    me.log.debug('Device: %s %s, get production Power successful: %s kW', me.host, me.name, productionPower / 1000);
    me.log.debug('Device: %s %s, get max production Power successful: %s kW', me.host, me.name, me.maxProductionPower / 1000);
    me.log.debug('Device: %s %s, get total consumption Power successful: %s kW', me.host, me.name, totalConsumptionPower / 1000);
    me.log.debug('Device: %s %s, get net consumption Power successful: %s kW', me.host, me.name, netConsumptionPower / 1000);
    me.currentProductionPower = Math.round(parseFloat(productionPower));
    me.totalConsumptionPower = Math.round(parseFloat(totalConsumptionPower));
    me.netConsumptionPower = Math.round(parseFloat(netConsumptionPower));
  }

  //Prepare TV service 
  prepareEnvoyService() {
    this.log.debug('prepareEnvoyService');
    const accessoryName = this.name;
    const accessoryUUID = UUID.generate(accessoryName);
    this.accessory = new Accessory(accessoryName, accessoryUUID);
    //this.accessory.category = Categories.AUDIO_RECEIVER;

    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
      .setCharacteristic(Characteristic.Model, this.modelName)
      .setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
      .setCharacteristic(Characteristic.FirmwareRevision, this.firmwareRevision);

    this.envoyService = new Service.CarbonDioxideSensor(accessoryName, 'envoyService');

    this.envoyService.getCharacteristic(Characteristic.CarbonDioxideDetected)
      .on('get', this.getDetected.bind(this));

    this.envoyService.getCharacteristic(Characteristic.CarbonDioxideLevel)
      .on('get', this.getProductionPower.bind(this));

    this.envoyService.getCharacteristic(Characteristic.CarbonDioxidePeakLevel)
      .on('get', this.getMaxProductionPower.bind(this));

    this.accessory.addService(this.envoyService);

    this.log.debug('Device: %s %s, publishExternalAccessories.', this.host, accessoryName);
    this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
  }

  getDetected(callback) {
    var me = this;
    let state = 0;
    if (me.currentProductionPower >= me.maxPowerDetected) {
      state = 1;
    }
    me.log.info('Device: %s %s, max Power detected successful: %s', me.host, me.name, state);
    callback(null, state);
  }

  getProductionPower(callback) {
    var me = this;
    let power = me.currentProductionPower;
    me.log.info('Device: %s %s, get current production Power successful: %s kW', me.host, me.name, power / 1000);
    callback(null, power);
  }

  getMaxProductionPower(callback) {
    var me = this;
    let power = me.maxProductionPower;
    me.log.info('Device: %s %s, get max production Power successful: %s kW', me.host, me.name, power / 1000);
    callback(null, power);
  }

  getNetConsumptionPower(callback) {
    var me = this;
    let power = me.netConsumptionPower;
    me.log.info('Device: %s %s, get net consumption Power successful: %s kW', me.host, me.name, power / 1000);
    callback(null, power);
  }
}
